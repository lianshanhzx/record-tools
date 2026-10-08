/**
 * collectService.js — Background 采集服务
 *
 * 职责：
 *   - 管理每个标签页的采集会话（仅单标签）。
 *   - 接收 content 上报的动作并分配全局序号。
 *   - 监听 webRequest，记录接口调用（url / method / statusCode）。
 *   - 结束（通过/不通过/废弃）时组装 JSON 并通过 offscreen document 下载到 collect/ 目录。
 *   - 标签页关闭时自动保存为 interrupted。
 *
 * 依赖：
 *   - APP_MODE / APP_DEFAULT_CONFIG（config/config.js）
 */

const COLLECT_SESSIONS_KEY = 'collectSessions'
const COLLECT_OFFSCREEN_DOC = 'collect/downloader.html'

const CollectService = {
  sessions: new Map(), // tabId -> session
  offscreenReady: null,
  _ready: null,
  _persistTimer: null,

  init() {
    if (this._ready) return this._ready
    this._ready = (async () => {
      const stored = await chrome.storage.session.get(COLLECT_SESSIONS_KEY)
      const map = stored[COLLECT_SESSIONS_KEY] || {}
      for (const [tabId, session] of Object.entries(map)) {
        this.sessions.set(Number(tabId), this.hydrateSession(session))
      }
    })()
    return this._ready
  },

  hydrateSession(raw) {
    return {
      sessionId: raw.sessionId,
      tabId: raw.tabId,
      startTime: raw.startTime,
      status: raw.status || 'collecting',
      actions: raw.actions || [],
      networkRequests: raw.networkRequests || [],
      lastNetworkIndex: raw.lastNetworkIndex || 0,
      nextSeq: raw.nextSeq || 1,
      pageConfig: raw.pageConfig === undefined ? null : raw.pageConfig,
      pagetagName: raw.pagetagName || ''
    }
  },

  generateSessionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID()
    }
    return 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
  },

  async persist() {
    const obj = {}
    this.sessions.forEach((session, tabId) => {
      obj[tabId] = session
    })
    await chrome.storage.session.set({ [COLLECT_SESSIONS_KEY]: obj })
  },

  schedulePersist() {
    if (this._persistTimer) return
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      this.persist().catch(() => {})
    }, 2000)
  },

  getActiveSession(tabId) {
    const session = this.sessions.get(tabId)
    if (!session) return null
    if (session.status !== 'collecting') return null
    return session
  },

  async startCollect(tabId) {
    console.log('[CollectService] startCollect', tabId)
    await this.init()
    // 同一个标签页如果已在采集中，先结束并保存为上一条（理论上不会触发）。
    const existing = this.sessions.get(tabId)
    if (existing && existing.status === 'collecting') {
      return { sessionId: existing.sessionId, alreadyActive: true }
    }

    const session = {
      sessionId: this.generateSessionId(),
      tabId,
      startTime: Date.now(),
      status: 'collecting',
      actions: [],
      networkRequests: [],
      lastNetworkIndex: 0,
      nextSeq: 1,
      pageConfig: null,
      pagetagName: ''
    }
    this.sessions.set(tabId, session)
    await this.persist()
    return { sessionId: session.sessionId, alreadyActive: false }
  },

  async endCollect(tabId, result) {
    await this.init()
    const session = this.sessions.get(tabId)
    if (!session) return { error: 'noSession' }
    if (result === 'discard') {
      this.sessions.delete(tabId)
      await this.persist()
      return { discarded: true }
    }
    session.status = 'ending'
    session.endTime = Date.now()
    session.result = result
    const finalizeResult = await this.finalize(session)
    this.sessions.delete(tabId)
    await this.persist()
    return { downloaded: true, sessionId: session.sessionId, upload: finalizeResult.upload }
  },

  async finalize(session) {
    await this.init()
    console.log('[CollectService] finalize', session.sessionId, 'result=', session.result)
    const payload = this.buildPayload(session)
    const pageName = (session.pageConfig && session.pageConfig['页面名称']) || session.pagetagName || ''
    const safePageName = this.sanitizeFileName(pageName)
    const datePart = this.formatDate(session.endTime || Date.now())
    const filename = safePageName
      ? `${APP_DEFAULT_CONFIG.collect.downloadDirectory}/${safePageName}_${datePart}.json`
      : `${APP_DEFAULT_CONFIG.collect.downloadDirectory}/${datePart}_${session.sessionId}.json`

    // 上传与下载并行，上传失败不阻塞下载。
    const uploadPromise = this.uploadJson(payload)

    try {
      await this.downloadJson(payload, filename)
      console.log('[CollectService] download triggered', filename)
    } catch (e) {
      console.error('[CollectService] download failed', e)
      // 即使下载失败，也等待上传结果以便记录。
      try { await uploadPromise } catch (_) {}
      throw e
    }

    const uploadResult = await uploadPromise
    return { downloaded: true, filename, upload: uploadResult }
  },

  buildPayload(session) {
    const tabInfo = session.tabInfo || { tabId: session.tabId }
    const associateMs = APP_DEFAULT_CONFIG.collect.networkAssociateMs || 1000
    // 为每个动作关联对应的网络请求，方便判断“点击查询按钮后调了哪个接口”。
    const actionsWithNetwork = session.actions.map(action => {
      const calls = session.networkRequests.filter(req => {
        if (req.tabId !== session.tabId) return false
        const delta = req.timestamp - action.timestamp
        return delta >= -500 && delta <= associateMs
      }).map(req => ({
        requestId: req.requestId,
        timestamp: req.timestamp,
        frameId: req.frameId,
        method: req.method,
        url: req.url,
        statusCode: req.statusCode,
        type: req.type,
        fromCache: req.fromCache
      }))
      return Object.assign({}, action, { networkCalls: calls })
    })

    const transcationProperties = this.buildTransactionProperties(actionsWithNetwork)

    return {
      id: this.generateSessionId(),
      name: 'collect',
      url: tabInfo.url || '',
      sessionId: session.sessionId,
      extensionVersion: chrome.runtime.getManifest().version,
      mode: 'collect',
      result: session.result || 'interrupted',
      startedAt: session.startTime,
      endedAt: session.endTime || Date.now(),
      targetTab: {
        tabId: session.tabId,
        url: tabInfo.url || '',
        title: tabInfo.title || ''
      },
      pagetagName: session.pagetagName || '',
      pageConfig: session.pageConfig || {},
      transcationProperties
    }
  },

  /**
   * 将动作列表按 group 路径构建成录制同款的扁平 id/pid 层级结构。
   * 分组节点只保留最精简字段，操作节点保留采集字段并去掉冗余的 group 数组。
   */
  buildTransactionProperties(actions) {
    const tree = this.buildGroupTree(actions)
    const nameMap = this.dedupGroupNames(tree.roots)
    return this.flattenGroupTree(tree.roots, nameMap)
  },

  /**
   * 将动作列表按 group 路径构建成录制同款的层级结构。
   *
   * 关键行为：
   *   1. 弹窗类分组（type === 'dialog'）不再跨非连续动作复用；每次“进入”弹窗都创建新实例。
   *   2. 当一条动作之后紧接着出现了不在当前路径中的弹窗时，认为该弹窗由这条动作触发，
   *      模拟录制模式的 anchorTarget 效果，把弹窗分组挂到触发动作所在的父分组下，
   *      并紧跟在触发动作之后。
   *   3. 同一弹窗被多次打开时，每一次打开都会生成独立子分组，避免后发生的弹窗内容
   *      被塞到第一次打开的弹窗实例里、导致时间顺序错乱。
   */
  buildGroupTree(actions) {
    const roots = []
    const nodeMap = new Map()
    const DEFAULT_PAGE_KEY = '__collect_default_page__'

    const pageGroup = {
      type: 'page',
      propertiesName: '主页面',
      key: DEFAULT_PAGE_KEY,
      url: '',
      fixedKey: true
    }

    let defaultPageNode = null
    let effectivePath = []
    let stack = []

    function sameGroup(a, b) {
      return (a.type || '') === (b.type || '') && (a.key || a.propertiesName) === (b.key || b.propertiesName)
    }

    function commonPrefixLength(a, b) {
      let len = 0
      while (len < a.length && len < b.length && sameGroup(a[len], b[len])) len++
      return len
    }

    function groupInPath(group, path) {
      return path.some(g => sameGroup(g, group))
    }

    for (const action of actions || []) {
      const path = Array.isArray(action.group)
        ? action.group.filter(g => g && (g.key || g.propertiesName))
        : []

      let displayPath = path

      // 无分组信息时挂到当前上下文（保持时间顺序），没有任何上下文再用默认主页面兜底。
      if (path.length === 0) {
        const deepestNode = stack.length > 0 ? stack[stack.length - 1] : null
        if (deepestNode) {
          deepestNode.entries.push({ kind: 'action', action })
        } else {
          if (!defaultPageNode) {
            defaultPageNode = {
              _key: DEFAULT_PAGE_KEY,
              type: 'page',
              propertiesName: '主页面',
              key: DEFAULT_PAGE_KEY,
              url: '',
              parentKey: null,
              entries: []
            }
            nodeMap.set(DEFAULT_PAGE_KEY, defaultPageNode)
            roots.push({ kind: 'group', node: defaultPageNode })
          }
          defaultPageNode.entries.push({ kind: 'action', action })
        }
        continue
      }

      // 推断当前动作在导出时应处的 displayPath。
      if (effectivePath.length > 0) {
        const currDeepest = path[path.length - 1]
        const prevDeepest = effectivePath[effectivePath.length - 1]

        if (sameGroup(currDeepest, prevDeepest)) {
          // 与上一条动作处于同一最深分组，沿用已锚定的上下文。
          displayPath = effectivePath
        } else if (currDeepest.type === 'dialog' && !groupInPath(currDeepest, effectivePath)) {
          // 新弹窗：挂到上一条动作所在路径之后（模拟 anchorTarget）。
          const commonLen = commonPrefixLength(effectivePath, path)
          if (commonLen >= 1) {
            displayPath = effectivePath.concat(path.slice(commonLen))
          }
        }
        // 其余情况使用原始 path。
      }

      // 按 displayPath 构建/复用分组节点。
      let commonLength = 0
      while (commonLength < effectivePath.length &&
             commonLength < displayPath.length &&
             sameGroup(effectivePath[commonLength], displayPath[commonLength])) {
        commonLength++
      }

      // 回退到公共前缀所在节点。
      stack = stack.slice(0, commonLength)

      // 为新增的分组后缀逐级创建/复用节点。
      // 弹窗类分组每次进入都创建独立实例；其它分组（页面/页签/折叠面板）按完整路径复用，
      // 避免弹窗关闭后回到原分组时又生成 客户基本信息_1 / 基本信息_1 等重复分组。
      for (let i = commonLength; i < displayPath.length; i++) {
        const g = displayPath[i]
        const parentKey = i > 0 ? (stack[i - 1]._key || '') : ''
        const baseNodeKey = (parentKey ? parentKey + '|' : '') + (g.type || 'group') + ':' + (g.key || g.propertiesName)
        const isDialog = g.type === 'dialog'
        const nodeKey = isDialog ? baseNodeKey + '@@' + action.timestamp : baseNodeKey

        let node = nodeMap.get(nodeKey)
        let isNewNode = false
        if (!node || isDialog) {
          node = {
            _key: nodeKey,
            type: g.type || 'group',
            propertiesName: g.propertiesName || '分组',
            key: g.key || '',
            url: g.url || '',
            parentKey: parentKey || null,
            entries: []
          }
          if (!isDialog) {
            nodeMap.set(nodeKey, node)
          }
          isNewNode = true
          if (stack.length > 0) {
            stack[stack.length - 1].entries.push({ kind: 'group', node })
          } else {
            roots.push({ kind: 'group', node })
          }
        }

        stack.push(node)
      }

      // 将动作挂到最深处分组。
      const deepestNode = stack[stack.length - 1]
      if (deepestNode) {
        deepestNode.entries.push({ kind: 'action', action })
      }

      effectivePath = displayPath
    }

    return { roots, nodeMap }
  },

  dedupGroupNames(roots) {
    const usedNames = new Set()
    const names = new Map()

    function reserve(entry) {
      if (entry.kind !== 'group') return
      const node = entry.node
      const baseName = (node.propertiesName || '').replace(/\//g, '或')
      let uniqueName = baseName
      if (baseName && usedNames.has(baseName)) {
        let index = 1
        while (usedNames.has(baseName + '_' + index)) index++
        uniqueName = baseName + '_' + index
      }
      if (baseName) usedNames.add(uniqueName)
      names.set(node, uniqueName)
      node.entries.filter(e => e.kind === 'group').forEach(reserve)
    }

    roots.forEach(reserve)
    return names
  },

  flattenGroupTree(roots, nameMap) {
    const result = []

    function visitGroup(groupId, parentId, node) {
      result.push({
        propertiesID: groupId,
        propertiesPID: parentId,
        type: node.type,
        propertiesName: nameMap.get(node) || node.propertiesName,
        key: node.key,
        url: node.url
      })

      node.entries.forEach(entry => {
        if (entry.kind === 'group') {
          visitGroup(CollectService.generateSessionId(), groupId, entry.node)
        } else {
          const exported = Object.assign({}, entry.action)
          delete exported.group
          result.push(Object.assign(exported, {
            propertiesID: CollectService.generateSessionId(),
            propertiesPID: groupId,
            type: 'ele'
          }))
        }
      })
    }

    roots.forEach(entry => {
      if (entry.kind === 'group') {
        visitGroup(CollectService.generateSessionId(), null, entry.node)
      }
    })

    return result
  },

  formatDate(ts) {
    const d = new Date(ts)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  },

  sanitizeFileName(name) {
    if (!name || typeof name !== 'string') return ''
    return name.replace(/[\\/:*?"<>|]/g, '_').trim()
  },

  async downloadJson(payload, filename) {
    try {
      console.log('[CollectService] try offscreen download')
      await this.downloadJsonOffscreen(payload, filename)
      console.log('[CollectService] offscreen download success')
    } catch (e) {
      console.warn('[CollectService] offscreen download failed, fallback to data url', e)
      await this.downloadJsonDataUrl(payload, filename)
    }
  },

  async downloadJsonOffscreen(payload, filename) {
    await this.ensureOffscreen()
    console.log('[CollectService] send collectDownloadJson to offscreen')
    const resp = await chrome.runtime.sendMessage({
      type: 'collectDownloadJson',
      payload,
      filename
    })
    console.log('[CollectService] offscreen response', resp)
    if (!resp || !resp.ok) {
      throw new Error(resp.error || 'offscreen download failed')
    }

    // 在 service worker 中重建 Blob 并触发下载（offscreen 无法访问 chrome.downloads）。
    const blob = new Blob([resp.arrayBuffer], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    try {
      await chrome.downloads.download({ url, filename, saveAs: false })
      console.log('[CollectService] download started from service worker')
    } finally {
      // 下载已启动，30 秒后释放 blob URL。
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    }
  },

  async downloadJsonDataUrl(payload, filename) {
    const json = JSON.stringify(payload, null, 2)
    // btoa 不能直接处理中文，先转成 UTF-8 字节序列。
    const base64 = btoa(unescape(encodeURIComponent(json)))
    const url = 'data:application/json;base64,' + base64
    console.log('[CollectService] fallback download data url, size=', json.length)
    await chrome.downloads.download({ url, filename, saveAs: false })
  },

  /**
   * 将采集结果 JSON 上传到 Telemetry 服务。
   * 配置项：APP_DEFAULT_CONFIG.collect.telemetryHost
   * 接口：POST /api/v2/telemetry/batches，无鉴权。
   * 上传失败只记录日志，不抛异常，避免影响本地下载。
   */
  async uploadJson(payload) {
    const host = String(
      (APP_DEFAULT_CONFIG.collect && APP_DEFAULT_CONFIG.collect.telemetryHost) || ''
    ).trim().replace(/\/+$/, '')
    if (!host) {
      console.log('[CollectService] telemetryHost not configured, skip upload')
      return { skipped: true }
    }

    const url = host + '/api/v2/telemetry/batches'
    const body = JSON.stringify(payload)
    console.log('[CollectService] uploading to', url, 'size=', body.length)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!resp.ok) {
        // 尽量读取服务端返回的具体错误信息，方便排查 400。
        let serverMsg = ''
        try {
          serverMsg = await resp.text()
        } catch (_) {}
        throw new Error('HTTP ' + resp.status + ' ' + resp.statusText + (serverMsg ? ' | ' + serverMsg.slice(0, 500) : ''))
      }

      console.log('[CollectService] upload success', resp.status)
      return { uploaded: true, status: resp.status }
    } catch (err) {
      console.error('[CollectService] upload failed', err)
      return { uploaded: false, error: err.message }
    }
  },

  async ensureOffscreen() {
    if (this.offscreenReady) return this.offscreenReady
    this.offscreenReady = (async () => {
      try {
        console.log('[CollectService] create offscreen document')
        await chrome.offscreen.createDocument({
          url: chrome.runtime.getURL(COLLECT_OFFSCREEN_DOC),
          reasons: ['BLOBS'],
          justification: '生成采集 JSON 的 blob 供 service worker 下载'
        })
        console.log('[CollectService] offscreen document created')
      } catch (e) {
        // 文档已存在时会抛错，忽略。
        console.log('[CollectService] offscreen create skipped/failed', e.message)
      }
    })()
    return this.offscreenReady
  },

  async addAction(tabId, frameId, action) {
    await this.init()
    const session = this.getActiveSession(tabId)
    if (!session) return null
    action.frameId = frameId
    action.seq = session.nextSeq++
    session.actions.push(action)
    await this.persist()
    return action.seq
  },

  async updateAction(tabId, clientId, updates) {
    await this.init()
    const session = this.getActiveSession(tabId)
    if (!session || !clientId) return null
    const action = session.actions.find(a => a.clientId === clientId)
    if (!action) return null
    Object.assign(action, updates)
    await this.persist()
    return action.seq
  },

  async setPageConfig(tabId, pageConfig) {
    await this.init()
    const session = this.getActiveSession(tabId)
    if (!session) return null
    // 只记录开始采集页面的一次（首次写入为准，即使为空对象）。
    if (session.pageConfig !== null) return session.pageConfig
    session.pageConfig = pageConfig || {}
    await this.persist()
    return session.pageConfig
  },

  async setPagetagName(tabId, pagetagName) {
    await this.init()
    const session = this.getActiveSession(tabId)
    if (!session) return null
    if (session.pagetagName) return session.pagetagName
    session.pagetagName = pagetagName || ''
    await this.persist()
    return session.pagetagName
  },

  async addNetworkRequest(details) {
    await this.init()
    const session = this.getActiveSession(details.tabId)
    if (!session) return
    // 过滤扩展自身发起的请求。
    if (details.initiator && details.initiator.startsWith(chrome.runtime.getURL(''))) return
    session.networkRequests.push({
      requestId: details.requestId,
      timestamp: details.timeStamp,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      type: details.type,
      fromCache: details.fromCache
    })
    // 避免网络请求无限增长导致内存过大，超过 5000 条时压缩归档（保留最近 2000 条）。
    if (session.networkRequests.length > 5000) {
      session.networkRequests = session.networkRequests.slice(-2000)
    }
    this.schedulePersist()
  },

  async updateTabInfo(tabId) {
    await this.init()
    try {
      const session = this.sessions.get(tabId)
      if (!session) return
      const tab = await chrome.tabs.get(tabId)
      session.tabInfo = { url: tab.url, title: tab.title }
      await this.persist()
    } catch (e) {
      // 标签页可能已关闭。
    }
  }
}

// 初始化：恢复已有会话。
CollectService.init().catch(e => console.warn('[CollectService] init failed', e))

// ==================== 消息路由 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message.type
  const tabId = sender.tab ? sender.tab.id : message.tabId

  if (type === 'collectInit') {
    console.log('[CollectService] collectInit from tab', tabId)
    CollectService.init().then(() => {
      const session = CollectService.getActiveSession(tabId)
      console.log('[CollectService] collectInit response', { active: !!session, sessionId: session ? session.sessionId : null })
      sendResponse({ active: !!session, sessionId: session ? session.sessionId : null })
    })
    return true
  }

  if (type === 'collectStart') {
    CollectService.init().then(async () => {
      const result = await CollectService.startCollect(tabId)
      await CollectService.updateTabInfo(tabId)
      sendResponse(result)
      try {
        console.log('[CollectService] broadcast collectStarted to tab', tabId)
        await chrome.tabs.sendMessage(tabId, { type: 'collectStarted', sessionId: result.sessionId })
      } catch (e) {
        console.warn('[CollectService] broadcast collectStarted failed', e)
      }
    })
    return true
  }

  if (type === 'collectAction') {
    CollectService.init().then(() => {
      CollectService.addAction(tabId, sender.frameId, message.action).then(seq => {
        sendResponse({ seq })
      })
    })
    return true
  }

  if (type === 'collectActionUpdate') {
    CollectService.init().then(() => {
      CollectService.updateAction(tabId, message.clientId, message.updates).then(seq => {
        sendResponse({ seq })
      })
    })
    return true
  }

  if (type === 'collectPageConfig') {
    CollectService.init().then(() => {
      CollectService.setPageConfig(tabId, message.pageConfig).then(config => {
        sendResponse({ pageConfig: config })
      })
    })
    return true
  }

  if (type === 'collectPagetagName') {
    CollectService.init().then(() => {
      CollectService.setPagetagName(tabId, message.pagetagName).then(name => {
        sendResponse({ pagetagName: name })
      })
    })
    return true
  }

  if (type === 'collectEnd') {
    console.log('[CollectService] collectEnd from tab', tabId, 'result=', message.result)
    CollectService.init().then(() => {
      CollectService.endCollect(tabId, message.result).then(result => {
        console.log('[CollectService] endCollect result', result)
        try {
          chrome.tabs.sendMessage(tabId, { type: 'collectStopped', result: message.result })
        } catch (e) {}
        sendResponse(result)
      }).catch(err => {
        console.error('[CollectService] endCollect error', err)
        sendResponse({ error: err.message })
      })
    })
    return true
  }

  return false
})

// ==================== 接口监听 ====================
chrome.webRequest.onCompleted.addListener(
  details => {
    CollectService.addNetworkRequest(details).catch(e => console.warn('[CollectService] network', e))
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] }
)

// ==================== 标签页生命周期 ====================
chrome.tabs.onRemoved.addListener(tabId => {
  const session = CollectService.sessions.get(tabId)
  if (!session || session.status !== 'collecting') return
  session.status = 'interrupted'
  session.endTime = Date.now()
  session.result = 'interrupted'
  CollectService.finalize(session).finally(async () => {
    CollectService.sessions.delete(tabId)
    await CollectService.persist()
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const session = CollectService.sessions.get(tabId)
  if (!session || !changeInfo.url) return
  session.tabInfo = { url: tab.url, title: tab.title }
  CollectService.persist().catch(() => {})
})
