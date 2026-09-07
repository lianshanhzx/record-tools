/**
 * recordManager.js — 录制数据管理模块（popup 侧）
 *
 * 职责：
 *   - 接收 content 侧上报的扫描元素 / 录制动作，按 "pageKey + target + anchorTarget"
 *     三元组合并去重，维护最终的记录列表（recordActionList）。
 *   - 依据元素的 group 分组路径构建展示树，并管理折叠状态、分组截图。
 *   - 提供行内编辑、分组/记录删除、导出（buildExportGroups）等能力。
 *
 * 关键设计约束：
 *   - 本模块运行在 popup 中，无法直接访问目标页面 DOM；
 *     元素身份完全依赖 content 侧生成的 target（XPath）与 pageKey / anchorTarget。
 *   - 同一 XPath 可因不同按钮锚点（anchorTarget）打开复用弹窗而重复出现，
 *     因此去重键必须是 "pageKey + target + anchorTarget" 三元组，而非 target 单独。
 *
 * 依赖：
 *   - Utils (libs/utils.js)
 *   - escHtml (popup/index.js 全局函数)
 *   - jQuery (libs/jquery.js)
 *   - ElementGrouper（仅用于取 PAGE_GROUP_KEY / GROUP_TYPE_LABELS，纯常量）
 *   - ScreenshotService（分组截图）
 */

const RecordManager = {
  // 全部记录（含扫描元素与人工录制动作），是列表数据的最终权威来源。
  recordActionList: [],
  // 经过过滤/排序/可见性筛选后用于渲染的记录列表。
  recordInfoLit: [],
  // 最近一次收到的扫描元素快照（按三元组去重后的合并结果）。
  scannedElementList: [],
  // 当前选中/编辑中的记录引用（与 recordInfoLit 中的对象同引用）。
  currentRecordInfo: {},
  // 最近一次 startRecord 上报的页面数据地址（页面级 URL 标识）。
  recordDataUrl: '',
  // 当前录制会话的页面标识，仅在开始录制或重录时初始化。
  pageId: '',
  // key 为分组节点 key，value 为该分组下的截图相对地址数组。
  groupScreenshots: {},
  // 分组树索引：node.key -> 展示树节点，用于按 key 快速反查分组。
  displayGroupMap: new Map(),
  // 最近一次渲染的展示树根节点列表。
  displayRoots: [],
  // 分组折叠状态，key 为组节点 key，true 表示折叠（默认展开）
  groupCollapseState: {},
  // 正在截图的组 key（非 null 时所有截图按钮禁用，避免并发截图）。
  screenshotCaptureGroupKey: null,
  screenshotCaptureText: '正在截图中',
  // 当前活动页面 key，用于判断分组是否属于历史页面（决定是否允许截图）。
  currentPageKey: '',
  // pageKey -> 页面展示顺序（页面首次出现的先后）。
  pageOrderMap: new Map(),
  nextPageOrder: 0,
  // 当前待粘贴记录的内部 key；仅在 popup 生命周期内保留。
  cutRecordKey: '',
  // 用户首次调整顺序后启用，避免后续渲染再次按 scanIndex 还原。
  manualOrderEnabled: false,
  nextRecordKey: 1,
  deletedScanKeys: new Set(),
  selectedRecordKeys: new Set(),
  replayStateMap: new Map(),

  /** 为 DOM 操作分配稳定 key，避免依赖可能重复的 id/timestamp。 */
  ensureRecordKey(item) {
    if (item && !item._recordKey) item._recordKey = 'record-' + this.nextRecordKey++
    return item ? item._recordKey : ''
  },

  getScanKey(item) {
    if (!item || !item.target) return ''
    return (item.pageKey || '') + '\n' + (item.target || '') + '\n' + (item.anchorTarget || '') + '\n' + (item.anchorRecordKey || '')
  },

  debugLog(event, data) {
    try {
      if (window.localStorage.getItem('__record_tools_debug__') !== '1') return
      console.info('[RecordTools][RecordManager]', event, data || {})
    } catch (e) {}
  },

  /** 将自动填表动作中的下拉选项同步到对应的扫描元素，保证两种导出都能使用。 */
  syncActionOptionsToScanned(messageData) {
    if (!messageData || !Array.isArray(messageData.options) || messageData.options.length === 0) return
    const candidates = this.scannedElementList.filter(item => {
      const samePage = (item.pageKey || '') === (messageData.pageKey || '')
      const sameContext = (item.anchorTarget || '') === (messageData.anchorTarget || '')
      const sameTarget = item.target === messageData.target
      const sameName = item.propertiesName === messageData.propertiesName || item.realLabel === messageData.realLabel
      return samePage && sameContext && (sameTarget || sameName)
    })
    for (const item of candidates) item.options = messageData.options.slice()
  },

  /** 为记录分配/复用页面顺序号，保证同一页面的记录在排序中始终相邻。 */
  ensurePageOrder(item) {
    const pageKey = item && item.pageKey ? item.pageKey : ''
    if (!this.pageOrderMap.has(pageKey)) {
      this.pageOrderMap.set(pageKey, this.nextPageOrder++)
    }
    item.pageOrder = this.pageOrderMap.get(pageKey)
    return item.pageOrder
  },

  /** 合并增量扫描元素快照：与已存在元素按三元组去重，命中则覆盖式合并，否则追加。 */
  mergeScannedElements(elements) {
    for (const incoming of elements || []) {
      const scanKey = this.getScanKey(incoming)
      if (scanKey && this.deletedScanKeys.has(scanKey)) continue
      this.ensurePageOrder(incoming)
      const index = this.scannedElementList.findIndex(item =>
        item.target === incoming.target &&
        (item.anchorTarget || '') === (incoming.anchorTarget || '') &&
        (item.anchorRecordKey || '') === (incoming.anchorRecordKey || '') &&
        (item.pageKey || '') === (incoming.pageKey || '')
      )
      if (index >= 0) {
        const existing = this.scannedElementList[index]
        const screenshotPosition = existing.screenshotPosition
        this.scannedElementList[index] = Object.assign({}, existing, incoming, {
          propertiesID: existing.propertiesID,
          options: Array.isArray(incoming.options) && incoming.options.length > 0
            ? incoming.options : (Array.isArray(existing.options) ? existing.options : []),
          scanPosition: incoming.position || existing.scanPosition,
          screenshotPosition: screenshotPosition,
          position: screenshotPosition || incoming.position || existing.position,
          positionStatus: screenshotPosition ? existing.positionStatus : incoming.positionStatus
        })
      } else {
        this.scannedElementList.push(Object.assign({}, incoming, { scanPosition: incoming.position }))
      }
    }
    this.scannedElementList = this.sortByScanIndex(this.scannedElementList)
  },

  /**
   * 更新录制计数显示。
   * 调用位置：recordManager.js → handleMessage / popup/index.js → clearBtn 点击
   */
  updateRecordCount() {
    const el = document.getElementById('recordCount')
    if (el) el.textContent = this.recordInfoLit.length + ' 条'
  },

  /**
   * 刷新 currentRecordInfo 修改后的列表。
   * recordInfoLit 中的对象与 currentRecordInfo 是同引用，修改已直接生效。
   * 调用位置：popup/index.js → saveCmdBtn / saveNameBtn / saveValBtn 点击
   * （deleteCmdBtn 不经过这里，直接在事件里过滤列表后重渲染）。
   */
  updateRecorder() {
    this.renderRecordList(this.recordInfoLit)
  },

  /**
   * 渲染录制动作列表到 DOM（按显示区域构建有序树）。
   *
   * 锚点记录的增量分组会挂到锚点所在分组下，并作为子分组插在锚点记录之后。
   * 分组节点内部使用 entries 同时保存记录和子分组，避免为了插入子分组而把
   * 锚点原来的分组切割成多个同名分组。
   *
   * 调用位置：recordManager.js → handleMessage / updateRecorder / popup/index.js
   */
  renderRecordList(data) {
    const self = this
    let html = ''
    let idx = 0

    /**
     * 渲染单条记录行，depth 用于计算缩进。
     * 每行通过内部稳定 key 供按钮和行点击反查记录。
     */
    function renderRow(item, depth) {
      let name = item.propertiesName
      if (!name && item.attributes && item.attributes.placeholder) name = item.attributes.placeholder
      idx++
      const indent = 16 + depth * 14
      const recordKey = self.ensureRecordKey(item)
      const isCut = self.cutRecordKey === recordKey
      const replayState = self.replayStateMap.get(recordKey) || {}
      const emptyValue = self.isFormRecord(item) && !self.hasReplayValue(item)
      if (emptyValue) self.selectedRecordKeys.delete(recordKey)
       const replayClass = emptyValue ? ' replay-empty-value' : (replayState.status ? ' replay-' + replayState.status : '')
        const replayLabels = { running: '执行中', success: '校验成功', failed: '失败', skipped: '已跳过', cancelled: '已取消' }
        const replayLabel = replayLabels[replayState.status]

      // 人工录制标记
      const manualBadge = item.manualRecord ? '<span class="manual-badge">人工</span>' : ''

      // 锚点关系标记：展示该元素由哪个按钮触发而出现在列表中
      const anchorBadge = item.anchorPropertiesName
        ? '<span class="anchor-badge" title="由 ' + escHtml(item.anchorPropertiesName) + ' 触发">→ ' + escHtml(item.anchorPropertiesName) + '</span>'
        : ''

      // 下拉框选项提示
      let valText = item.objectValue || ''
      let valTitle = valText
      if (item.options && item.options.length > 0) {
        valText = valText ? valText + '（' + item.options.length + '项）' : '（' + item.options.length + '项）'
        valTitle = (item.objectValue || '') + '\n选项：' + item.options.join(' / ')
      }

      html += '<div class="list-row' + (isCut ? ' cut-pending' : '') + replayClass + '" style="padding-left:' + indent + 'px" data-record-key="' + escHtml(recordKey) + '">'
      html += '<span class="col-select"><input type="checkbox" class="record-select" data-record-key="' + escHtml(recordKey) + '"' + (self.selectedRecordKeys.has(recordKey) ? ' checked' : '') + (emptyValue || (typeof ReplayService !== 'undefined' && ReplayService.running) ? ' disabled' : '') + ' title="选择此记录"></span>'
      html += '<span class="col-seq">' + idx + '</span>'
      html += '<span class="col-cmd">' + escHtml(item.eventTypeName || '') + '</span>'
        const replayTitle = replayState.error || (replayState.expectedValue !== undefined ? '期望: ' + replayState.expectedValue + '，实际: ' + replayState.actualValue : '')
        html += '<span class="col-name" title="' + escHtml(name || '') + '">' + manualBadge + escHtml(name || '') + anchorBadge + (replayLabel ? '<span class="replay-state ' + escHtml(replayState.status) + '" title="' + escHtml(replayTitle) + '">' + escHtml(replayLabel) + '</span>' : '') + '</span>'
      html += '<span class="col-target" title="' + escHtml(item.target || '') + '">'
      html += '<span class="col-target-text">' + escHtml(item.target || '') + '</span>'
      html += '<button type="button" class="copy-target-btn" title="复制 Target">复制</button>'
      html += '</span>'
      html += '<span class="col-val" title="' + escHtml(valTitle) + '">' + escHtml(valText) + '</span>'
      html += '<span class="col-actions">'
      if (self.cutRecordKey && !isCut) {
        html += '<button type="button" class="row-action-btn paste-record-btn" data-record-key="' + escHtml(recordKey) + '">粘贴</button>'
      } else {
        html += '<button type="button" class="row-action-btn cut-record-btn" data-record-key="' + escHtml(recordKey) + '">' + (isCut ? '已剪切' : '剪切') + '</button>'
      }
      html += '<button type="button" class="row-action-btn delete-record-btn" data-record-key="' + escHtml(recordKey) + '">删除</button>'
      html += '</span>'
      html += '</div>'
    }

    /** 提取记录的 group 路径，过滤掉无 key 的脏分组项，返回有效的分组数组。 */
    function normalizePath(item) {
      return Array.isArray(item && item.group)
        ? item.group.filter(g => g && (g.key || g.propertiesName))
        : []
    }

    /** 判断两个分组节点是否表示同一个组（type + key 都相同）。 */
    function sameGroup(a, b) {
      return (a.type || '') === (b.type || '') && (a.key || a.propertiesName) === (b.key || b.propertiesName)
    }

    // 兜底页面组：无分组信息的记录统一归入"主页面"。
    const pageGroup = {
      type: 'page',
      propertiesName: '主页面',
      key: (typeof ElementGrouper !== 'undefined' && ElementGrouper.PAGE_GROUP_KEY) || '__page__',
      fixedKey: true
    }

    /**
     * 计算用于展示的有效分组路径。
     * 普通记录沿用自身路径；锚点增量记录改为：锚点父路径 + 增量内容自身的相对路径。
     *
     * 增量路径算法：
     *   1. 先求锚点路径与自身路径的公共前缀长度（commonLength）；
     *   2. 以锚点完整路径为父路径；
     *   3. 自身路径从公共前缀之后的部分作为相对路径；
     *   4. 相对路径的第一个分组追加 "@@anchor=<target>" 到 key 上，
     *      使同一复用弹窗由不同按钮打开时拥有独立的子分组，但显示名称保持不变。
     */
    function displayPath(item, anchorByTarget) {
      const ownPath = normalizePath(item)
      if (!item.anchorTarget) {
        return ownPath.length > 0 ? ownPath : [pageGroup]
      }

      // 反查锚点记录（需与 content 侧 contextKey 使用相同拼接规则：pageKey\n+target）。
      const anchorKey = (item.pageKey || '') + '\n' + item.anchorTarget + '\n' + (item.anchorRecordKey || '')
      const anchor = anchorByTarget.get(anchorKey) ||
        (!item.anchorRecordKey ? anchorByTarget.get((item.pageKey || '') + '\n' + item.anchorTarget + '\n') : null)
      if (!anchor) {
        self.debugLog('anchor-not-found', {
          target: item.target || '',
          anchorTarget: item.anchorTarget || '',
          anchorRecordKey: item.anchorRecordKey || ''
        })
        return ownPath.length > 0 ? ownPath : [pageGroup]
      }

      const anchorPath = normalizePath(anchor)
      let commonLength = 0
      while (commonLength < anchorPath.length &&
             commonLength < ownPath.length &&
             sameGroup(anchorPath[commonLength], ownPath[commonLength])) {
        commonLength++
      }

      const parentPath = anchorPath.length > 0 ? anchorPath : [pageGroup]
      const relativePath = ownPath.slice(commonLength).map((g, index) => {
        if (index !== 0) return g
        // 同一弹窗组件可被多个按钮复用；首个相对分组加入锚点上下文，
        // 使 A/B 按钮各自拥有独立子分组，同时保持显示名称不变。
        return Object.assign({}, g, {
          key: (g.key || g.propertiesName) + '@@anchor=' + item.anchorTarget + '@@record=' + (item.anchorRecordKey || '')
        })
      })
      if (relativePath.length === 0) return ownPath.length > 0 ? ownPath : [pageGroup]
      return parentPath.concat(relativePath)
    }

    /**
     * 构建保留组内顺序的展示树。
     * node.entries 中的 item/group 顺序就是最终渲染顺序。
     * 分组节点 key 由父子路径逐级拼接（'|' 分隔），保证同名嵌套分组也能区分。
     */
    function buildDisplayTree(items) {
      const roots = []
      const nodeMap = new Map()
      const anchorByTarget = new Map()
      const leafNodeByItem = new Map()
      const anchoredGroups = []

      // 先建立 target -> 记录 的索引，供 displayPath 反查锚点记录。
      ;(items || []).forEach(item => {
        if (!item.target) return
        const key = (item.pageKey || '') + '\n' + item.target
        const existing = anchorByTarget.get(key)
        if (!existing || (existing.anchorTarget && !item.anchorTarget)) anchorByTarget.set(key, item)
        if (!item.anchorTarget) {
          anchorByTarget.set(key + '\n', item)
          // 人工按钮动作使用 propertiesID 作为点击实例身份，供后续弹窗反查。
            if (item.manualRecord && item.propertiesID) {
              anchorByTarget.set(key + '\n' + item.propertiesID, item)
            }
            if (item.manualRecord && item.triggerRecordKey) {
              anchorByTarget.set(key + '\n' + item.triggerRecordKey, item)
            }
        }
        else anchorByTarget.set(key + '\n' + (item.anchorRecordKey || ''), item)
        if (item.anchorTarget) {
          self.debugLog('anchored-item-indexed', {
            target: item.target || '',
            anchorTarget: item.anchorTarget || '',
            anchorRecordKey: item.anchorRecordKey || '',
            propertiesID: item.propertiesID || ''
          })
        }
      })

      /**
       * 沿路径逐级查找/创建分组节点；已存在则复用并累加 count。
       * fixedKey 的节点（如主页面）直接以自身 key 作为 nodeKey，不再拼接父路径。
       */
      function ensurePath(path) {
        let parent = null
        let parentKey = ''
        let node = null
        const nodes = []

        path.forEach(g => {
          const part = (g.type || 'group') + ':' + (g.key || g.propertiesName)
          const nodeKey = g.fixedKey ? g.key : (parentKey ? parentKey + '|' + part : '|' + part)
          node = nodeMap.get(nodeKey)
          if (!node) {
            node = {
              key: nodeKey,
              type: g.type || 'group',
              propertiesName: g.propertiesName || '分组',
              url: g.url || '',
              path: parent ? parent.path.concat([g]) : [g],
              entries: [],
              count: 0
            }
            nodeMap.set(nodeKey, node)
            if (parent) {
              parent.entries.push({ kind: 'group', node: node })
            } else {
              roots.push(node)
            }
          }
          node.count++
          parent = node
          parentKey = nodeKey
          nodes.push(node)
        })

        return { leaf: node, nodes: nodes }
      }

      ;(items || []).forEach(item => {
        const path = displayPath(item, anchorByTarget)
        const pathResult = ensurePath(path)
        if (!pathResult.leaf) return
        pathResult.leaf.entries.push({ kind: 'item', item: item })
        leafNodeByItem.set(item, pathResult.leaf)

        // 弹窗元素的扫描结果可能因异步消息顺序先于触发按钮到达。
        // 记录其首个相对分组，待整棵树创建完成后再定位到锚点记录之后。
        if (item.anchorTarget) {
          const anchorKey = (item.pageKey || '') + '\n' + item.anchorTarget + '\n' + (item.anchorRecordKey || '')
          const anchor = anchorByTarget.get(anchorKey) ||
            (!item.anchorRecordKey ? anchorByTarget.get((item.pageKey || '') + '\n' + item.anchorTarget + '\n') : null)
          const anchorPath = anchor ? normalizePath(anchor) : []
          const relativeNode = pathResult.nodes[anchorPath.length]
          if (relativeNode) anchoredGroups.push({ item: item, node: relativeNode })
        }
      })

      const movedGroups = new Set()
      anchoredGroups.forEach(({ item, node }) => {
        const anchorKey = (item.pageKey || '') + '\n' + item.anchorTarget + '\n' + (item.anchorRecordKey || '')
        const anchor = anchorByTarget.get(anchorKey) ||
          (!item.anchorRecordKey ? anchorByTarget.get((item.pageKey || '') + '\n' + item.anchorTarget + '\n') : null)
        const anchorParent = anchor && leafNodeByItem.get(anchor)
        if (!anchorParent) return

        // 没有新增分组的锚点记录（例如确认框按钮）也必须按触发关系排序，
        // 不能让扫描消息的到达顺序决定它出现在触发按钮之前还是之后。
        const itemParent = leafNodeByItem.get(item)
        if (itemParent === anchorParent) {
          const itemEntryIndex = anchorParent.entries.findIndex(entry => entry.kind === 'item' && entry.item === item)
          const anchorEntryIndex = anchorParent.entries.findIndex(entry => entry.kind === 'item' && entry.item === anchor)
          if (itemEntryIndex >= 0 && anchorEntryIndex >= 0 && itemEntryIndex !== anchorEntryIndex) {
            const itemEntry = anchorParent.entries.splice(itemEntryIndex, 1)[0]
            const adjustedAnchorIndex = itemEntryIndex < anchorEntryIndex ? anchorEntryIndex - 1 : anchorEntryIndex
            anchorParent.entries.splice(adjustedAnchorIndex + 1, 0, itemEntry)
          }
          return
        }

        if (movedGroups.has(node)) return
        const groupEntryIndex = anchorParent.entries.findIndex(entry => entry.kind === 'group' && entry.node === node)
        const anchorEntryIndex = anchorParent.entries.findIndex(entry => entry.kind === 'item' && entry.item === anchor)
        if (groupEntryIndex < 0 || anchorEntryIndex < 0) return

        const groupEntry = anchorParent.entries.splice(groupEntryIndex, 1)[0]
        const adjustedAnchorIndex = groupEntryIndex < anchorEntryIndex ? anchorEntryIndex - 1 : anchorEntryIndex
        anchorParent.entries.splice(adjustedAnchorIndex + 1, 0, groupEntry)
        movedGroups.add(node)
      })

      return roots
    }

    /**
     * 渲染分组标题行。
     * 截图按钮在"正有其他分组截图"或"该组属于历史页面"时禁用，
     * 目的是保证截图抓取与当前页面状态一致（历史页面 DOM 已不匹配）。
     */
    function renderHeader(node, depth) {
      const collapsed = !!self.groupCollapseState[node.key]
      const typeLabels = (typeof ElementGrouper !== 'undefined' && ElementGrouper.GROUP_TYPE_LABELS) || {}
      const typeLabel = typeLabels[node.type] || '分组'
      const indent = 16 + depth * 14
      const screenshotCount = self.getGroupScreenshotCount(node.key)
      const nodePageKey = node.path && node.path[0] ? node.path[0].key : ''
      const isHistoricalPage = !!self.currentPageKey && nodePageKey !== self.currentPageKey
      const screenshotDisabled = (self.screenshotCaptureGroupKey !== null && self.screenshotCaptureGroupKey !== node.key) || isHistoricalPage
        ? ' disabled'
        : ''
      const screenshotText = self.screenshotCaptureGroupKey === node.key ? self.screenshotCaptureText : '截图'
      const groupTitle = node.type === 'page' && node.url ? node.propertiesName + ' - ' + node.url : node.propertiesName
      const groupRecords = self.getGroupReplayRecords(node)
      const selectedGroupCount = groupRecords.filter(item => self.selectedRecordKeys.has(self.ensureRecordKey(item))).length
      const groupChecked = groupRecords.length > 0 && selectedGroupCount === groupRecords.length ? ' checked' : ''
      const groupDisabled = groupRecords.length === 0 || (typeof ReplayService !== 'undefined' && ReplayService.running) ? ' disabled' : ''
      html += '<div class="list-group-header group-type-' + escHtml(node.type) + '" data-group-key="' + escHtml(node.key) + '" style="padding-left:' + indent + 'px">'
      html += '<span class="group-arrow">' + (collapsed ? '▸' : '▾') + '</span>'
      html += '<input type="checkbox" class="group-select" data-group-key="' + escHtml(node.key) + '"' + groupChecked + groupDisabled + ' title="选择当前分组记录">'
      html += '<span class="group-type-badge">' + escHtml(typeLabel) + '</span>'
      html += '<span class="group-name" title="' + escHtml(groupTitle) + '">' + escHtml(node.propertiesName) + '</span>'
      html += '<span class="group-count">' + node.count + ' 条</span>'
      html += '<button type="button" class="group-screenshot-list" data-group-key="' + escHtml(node.key) + '">截图 ' + screenshotCount + '</button>'
      html += '<button type="button" class="group-screenshot-btn" data-group-key="' + escHtml(node.key) + '"' + screenshotDisabled + '>' + escHtml(screenshotText) + '</button>'
      html += '<button type="button" class="group-delete-btn" data-group-key="' + escHtml(node.key) + '">删除</button>'
      html += '</div>'
    }

    /** 递归渲染节点：标题栏 + 展开（折叠则只渲染标题）时渲染子条目。 */
    function renderNode(node, depth, showHeader) {
      if (showHeader) renderHeader(node, depth)
      if (showHeader && self.groupCollapseState[node.key]) return

      const entryDepth = showHeader ? depth + 1 : depth
      node.entries.forEach(entry => {
        if (entry.kind === 'item') {
          renderRow(entry.item, entryDepth)
        } else {
          renderNode(entry.node, entryDepth, true)
        }
      })
    }

    if (!data || data.length === 0) {
      self.displayRoots = []
      self.displayGroupMap = new Map()
      document.getElementById('listBody').innerHTML = ''
      self.updateSelectionUi()
      return
    }

    const roots = buildDisplayTree(data)
    self.debugLog('display-tree-built', {
      itemCount: data.length,
      rootCount: roots.length,
      rootNames: roots.map(root => root.propertiesName)
    })
    self.displayRoots = roots
    self.displayGroupMap = new Map()
    // 递归建立 group key -> 节点索引，供 getGroupNode / 截图 / 删除等按键反查分组。
    function indexNode(node) {
      self.displayGroupMap.set(node.key, node)
      node.entries.forEach(entry => {
        if (entry.kind === 'group') indexNode(entry.node)
      })
    }
    roots.forEach(indexNode)
    roots.forEach(node => {
      // 截图入口位于分组标题，因此主页面也始终显示标题。
      renderNode(node, 0, true)
    })

    document.getElementById('listBody').innerHTML = html
    self.updateSelectionUi()
  },

  /**
   * 过滤掉录制工具自身按钮产生的动作数据。
   * 调用位置：recordManager.js → handleMessage
   */
  filterRecordListData(data) {
    return data.filter(r =>
      r.target !== '//*[@id="record_stop_btn"]' &&
      r.target !== '//*[@id="record_pause_btn"]' &&
      r.target !== '//*[@id="record_continue_btn"]' &&
      r.target !== 'xpath=#record_stop_btn' &&
      r.target !== 'xpath=#record_pause_btn' &&
      r.target !== 'xpath=#record_continue_btn'
    )
  },

  /**
   * 判断记录是否为按钮类型。
   */
  isButtonRecord(item) {
    return item.kind === 'button' || item.eventTypeValue === 'click'
  },

  isFormRecord(item) {
    if (!item) return false
    const tagName = String(item.tagName || '').toLowerCase()
    const kind = String(item.kind || '').toLowerCase()
    const action = Utils.normalizeEventType(item.eventTypeValue)
    return ['input', 'textarea', 'select'].includes(tagName) ||
      ['input', 'textarea', 'select', 'radio', 'checkbox', 'date'].includes(kind) ||
      ['input', 'select:click', 'select:tree', 'radio', 'date'].includes(action)
  },

  hasReplayValue(item) {
    if (item && item.hasRecordedValue === true) return true
    if (!item || item.objectValue === null || typeof item.objectValue === 'undefined') return false
    if (typeof item.objectValue === 'number' || typeof item.objectValue === 'boolean') return true
    return String(item.objectValue).trim().length > 0
  },

  isReplayableRecord(item) {
    return !!(item && item.target && (!this.isFormRecord(item) || this.hasReplayValue(item)))
  },

  /**
   * 判断记录是否应在列表中显示。
   * 规则：禁用元素不显示；按钮仅在已被录制后显示；其他元素默认显示。
   */
  isVisibleRecord(item) {
    if (item.disabled) return false
    if (this.isButtonRecord(item)) {
      return item.recorded === true
    }
    return true
  },

  /**
   * 按扫描位置排序记录。
   * 有 scanIndex 的排在前面并按 scanIndex 升序；无 scanIndex 的按 timestamp 排在后面。
   */
  sortByScanIndex(data) {
    return (data || []).slice().sort((a, b) => {
      if (this.manualOrderEnabled) {
        const orderA = typeof a.manualOrder === 'number' ? a.manualOrder : Number.MAX_SAFE_INTEGER
        const orderB = typeof b.manualOrder === 'number' ? b.manualOrder : Number.MAX_SAFE_INTEGER
        if (orderA !== orderB) return orderA - orderB
      }
      const pageA = typeof a.pageOrder === 'number' ? a.pageOrder : 0
      const pageB = typeof b.pageOrder === 'number' ? b.pageOrder : 0
      if (pageA !== pageB) return pageA - pageB
      const hasA = typeof a.scanIndex === 'number'
      const hasB = typeof b.scanIndex === 'number'
      if (hasA && hasB) return a.scanIndex - b.scanIndex
      if (hasA && !hasB) return -1
      if (!hasA && hasB) return 1
      return (a.timestamp || 0) - (b.timestamp || 0)
    })
  },

  /**
   * 同一 XPath 可在不同按钮锚点下重复出现，只有 target 和 anchorTarget 都相同才视为同一记录。
   */
  findContextRecordIndex(target, anchorTarget, pageKey) {
    if (!target) return -1
    const anchor = anchorTarget || ''
    return this.recordActionList.findIndex(item => {
      return item.target === target &&
        (item.anchorTarget || '') === anchor &&
        (item.pageKey || '') === (pageKey || '')
    })
  },

  refreshVisibleRecords() {
    this.recordInfoLit = this.sortByScanIndex(
      this.filterRecordListData(this.recordActionList).filter(item => this.isVisibleRecord(item))
    )
    this.renderRecordList(this.recordInfoLit)
    this.updateRecordCount()
  },

  getRecordByKey(recordKey) {
    return this.recordActionList.find(item => this.ensureRecordKey(item) === recordKey) || null
  },

  findScannedContextRecordIndex(target, anchorTarget, anchorRecordKey, pageKey) {
    if (!target) return -1
    return this.recordActionList.findIndex(item => item.target === target &&
      (item.anchorTarget || '') === (anchorTarget || '') &&
      (item.anchorRecordKey || '') === (anchorRecordKey || '') &&
      (item.pageKey || '') === (pageKey || ''))
  },

  updateSelectionUi() {
    const visibleKeys = (this.recordInfoLit || []).filter(item => this.isReplayableRecord(item)).map(item => this.ensureRecordKey(item))
    const selectedVisible = visibleKeys.filter(key => this.selectedRecordKeys.has(key))
    const selectAll = document.getElementById('selectAllRecords')
    if (selectAll) {
      selectAll.disabled = visibleKeys.length === 0 || (typeof ReplayService !== 'undefined' && ReplayService.running)
      selectAll.checked = visibleKeys.length > 0 && selectedVisible.length === visibleKeys.length
      selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleKeys.length
    }
    const summary = document.getElementById('replaySelection')
    if (summary) summary.textContent = '已选择 ' + selectedVisible.length + ' 条'
    this.updateGroupSelectionUi()
  },

  getGroupReplayRecords(node) {
    const records = []
    const collect = current => {
      ;(current && current.entries || []).forEach(entry => {
        if (entry.kind === 'item' && this.isReplayableRecord(entry.item)) records.push(entry.item)
        else collect(entry.node)
      })
    }
    collect(node)
    return records
  },

  updateGroupSelectionUi() {
    document.querySelectorAll('.group-select').forEach(input => {
      const node = this.getGroupNode(input.getAttribute('data-group-key'))
      const records = this.getGroupReplayRecords(node)
      const selected = records.filter(item => this.selectedRecordKeys.has(this.ensureRecordKey(item))).length
      input.checked = records.length > 0 && selected === records.length
      input.indeterminate = selected > 0 && selected < records.length
    })
  },

  selectGroupRecords(groupKey, selected) {
    const node = this.getGroupNode(groupKey)
    this.getGroupReplayRecords(node).forEach(item => {
      const key = this.ensureRecordKey(item)
      if (selected) this.selectedRecordKeys.add(key)
      else this.selectedRecordKeys.delete(key)
    })
    this.renderRecordList(this.recordInfoLit)
    this.updateSelectionUi()
  },

  toggleRecordSelection(recordKey, selected) {
    if (selected) this.selectedRecordKeys.add(recordKey)
    else this.selectedRecordKeys.delete(recordKey)
    this.updateSelectionUi()
  },

  selectAllVisibleRecords(selected) {
    ;(this.recordInfoLit || []).filter(item => this.isReplayableRecord(item)).forEach(item => {
      const key = this.ensureRecordKey(item)
      if (selected) this.selectedRecordKeys.add(key)
      else this.selectedRecordKeys.delete(key)
    })
    this.renderRecordList(this.recordInfoLit)
    this.updateSelectionUi()
  },

  getReplayRecords() {
    const visible = this.recordInfoLit || []
    const replayable = visible.filter(item => this.isReplayableRecord(item))
    const selected = replayable.filter(item => this.selectedRecordKeys.has(this.ensureRecordKey(item)))
    return selected.length > 0 ? selected : replayable
  },

  getEmptyValueRecords(records) {
    return (records || []).filter(item => this.isFormRecord(item) && !this.hasReplayValue(item))
  },

  resetReplayStates(records) {
    this.replayStateMap.clear()
    ;(records || []).forEach(item => this.replayStateMap.set(this.ensureRecordKey(item), { status: 'pending' }))
    this.renderRecordList(this.recordInfoLit)
  },

   setReplayState(recordKey, status, error, details) {
     this.replayStateMap.set(recordKey, Object.assign({ status, error: error || '' }, details || {}))
    this.renderRecordList(this.recordInfoLit)
  },

  clearCurrentRecord() {
    this.currentRecordInfo = {}
    $('#editCmd').val('')
    $('#editName').val('')
    $('#editVal').val('')
  },

  deleteRecord(recordKey) {
    const record = this.getRecordByKey(recordKey)
    if (!record) return false
    const scanKey = this.getScanKey(record)
    if (scanKey) this.deletedScanKeys.add(scanKey)
    this.recordActionList = this.recordActionList.filter(item => item !== record)
    if (scanKey) {
      this.scannedElementList = this.scannedElementList.filter(item => this.getScanKey(item) !== scanKey)
    }
    if (this.currentRecordInfo === record) this.clearCurrentRecord()
    if (this.cutRecordKey === recordKey) this.cutRecordKey = ''
    this.selectedRecordKeys.delete(recordKey)
    this.replayStateMap.delete(recordKey)
    this.refreshVisibleRecords()
    return true
  },

  cutRecord(recordKey) {
    if (!this.getRecordByKey(recordKey)) return
    this.cutRecordKey = recordKey
    this.renderRecordList(this.recordInfoLit)
  },

  pasteRecordBefore(targetRecordKey) {
    const source = this.getRecordByKey(this.cutRecordKey)
    const target = this.getRecordByKey(targetRecordKey)
    if (!source || !target || source === target) return false

    const sourceScanKey = this.getScanKey(source)
    if (sourceScanKey) {
      this.deletedScanKeys.add(sourceScanKey)
      this.scannedElementList = this.scannedElementList.filter(item => this.getScanKey(item) !== sourceScanKey)
    }

    // 跨分组移动时采用目标记录的页面、分组及锚点上下文。
    source.group = Array.isArray(target.group) ? target.group.map(group => Object.assign({}, group)) : []
    source.pageKey = target.pageKey
    source.pageUrl = target.pageUrl
    source.routeIdentity = target.routeIdentity
    source.pageOrder = target.pageOrder
    source.anchorTarget = target.anchorTarget || ''
    source.anchorPropertiesName = target.anchorPropertiesName || ''
    this.clearScreenshotPosition(source)

    const ordered = this.sortByScanIndex(this.recordActionList).filter(item => item !== source)
    const targetIndex = ordered.indexOf(target)
    if (targetIndex < 0) return false
    ordered.splice(targetIndex, 0, source)
    ordered.forEach((item, index) => { item.manualOrder = index })
    this.recordActionList = ordered
    this.manualOrderEnabled = true
    this.cutRecordKey = ''
    this.refreshVisibleRecords()
    return true
  },

  /**
   * 为操作分配全列表唯一名称。分组和锚点上下文不参与判断，避免导出时出现重名字段。
   */
  getUniquePropertiesName(name, ignoredItem) {
    const baseName = name || ''
    if (!baseName) return baseName
    const usedNames = new Set(this.recordActionList
      .filter(item => item !== ignoredItem && item.propertiesName)
      .map(item => item.propertiesName))
    const currentName = ignoredItem && ignoredItem.propertiesName
    if (currentName === baseName ||
        (usedNames.has(baseName) && new RegExp('^' + baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_\\d+$').test(currentName))) {
      return currentName
    }
    if (!usedNames.has(baseName)) return baseName

    let index = 1
    while (usedNames.has(baseName + '_' + index)) index++
    return baseName + '_' + index
  },

  /**
   * 处理来自 content 的录制消息（addActionData / startRecord / addScannedElements）。
   * 调用位置：popup/index.js → chrome.runtime.onMessage 监听
   *
   * 三条分支：
   *   - addActionData：人工录制动作入库（命中上下文则合并字段，否则全列表去重命名后追加）。
   *   - addScannedElements：扫描元素入库；replacePageKey 表示页面切换，先清掉该页的
   *     旧扫描记录（但保留 manualRecord 的人工动作），再合并新扫描快照。
   *   - startRecord：仅被过滤，说明存在该消息类型但此处不处理（参数未使用）。
   */
  handleMessage(message) {
    if (message.type !== 'addActionData' && message.type !== 'startRecord' && message.type !== 'addScannedElements') return;
    if (message.type === 'addActionData') {
      const isManualRecord = message.data.manualRecord === true
      const scanKey = this.getScanKey(message.data)
      if (scanKey) this.deletedScanKeys.delete(scanKey)
      this.ensureRecordKey(message.data)
      this.ensurePageOrder(message.data)
      const target = message.data.target
      const name = message.data.propertiesName
      this.currentPageKey = message.data.pageKey || this.currentPageKey
      this.syncActionOptionsToScanned(message.data)
      // 普通按钮的每次有效人工点击都保留独立记录；输入/选择类动作仍按原语义合并。
      const keepManualButton = isManualRecord && this.isButtonRecord(message.data)
      const byTarget = keepManualButton
        ? -1
        : this.findContextRecordIndex(target, message.data.anchorTarget, message.data.pageKey)
      if (byTarget >= 0) {
        const existing = this.recordActionList[byTarget]
        this.recordActionList[byTarget] = {
          ...existing,
          objectValue: message.data.objectValue,
          eventTypeValue: message.data.eventTypeValue,
          eventTypeName: message.data.eventTypeName,
          propertiesName: this.getUniquePropertiesName(message.data.propertiesName, existing),
          realLabel: message.data.realLabel || existing.realLabel || '',
          rect: message.data.rect || existing.rect || {},
          mothed: message.data.mothed || 'By.XPATH',
          elementType: message.data.target,
          transcationType: 'playwright',
          group: message.data.group || existing.group,
          kind: message.data.kind || existing.kind,
          scanIndex: typeof message.data.scanIndex === 'number' ? message.data.scanIndex : existing.scanIndex,
          pageUrl: message.data.pageUrl || existing.pageUrl,
          pageOrder: typeof message.data.pageOrder === 'number' ? message.data.pageOrder : existing.pageOrder,
          options: message.data.options && message.data.options.length > 0
            ? message.data.options : existing.options,
          anchorTarget: message.data.anchorTarget || existing.anchorTarget,
          anchorPropertiesName: message.data.anchorPropertiesName || existing.anchorPropertiesName,
          anchorRecordKey: message.data.anchorRecordKey || existing.anchorRecordKey,
          recorded: true,
          manualRecord: existing.manualRecord || isManualRecord
        }
      } else {
        message.data.propertiesName = this.getUniquePropertiesName(name)
        message.data.recorded = true
        message.data.manualRecord = isManualRecord
        this.recordActionList.push(message.data)
      }
      this.recordInfoLit = this.sortByScanIndex(this.filterRecordListData(this.recordActionList).filter(r => this.isVisibleRecord(r)))
      this.currentRecordInfo = {}
      this.renderRecordList(this.recordInfoLit)
      this.updateRecordCount()
    } else if (message.type === 'addScannedElements') {
      const elements = message.data || []
      this.currentPageKey = message.currentPageKey || this.currentPageKey
      // 页面切换：清除该页旧扫描，但人工录制动作（manualRecord）保留不删。
      if (message.replacePageKey) {
        this.scannedElementList = this.scannedElementList.filter(item => item.pageKey !== message.replacePageKey)
        this.recordActionList = this.recordActionList.filter(item =>
          item.pageKey !== message.replacePageKey || item.manualRecord === true
        )
      }
      this.mergeScannedElements(elements)
      for (const el of elements) {
        const scanKey = this.getScanKey(el)
        if (scanKey && this.deletedScanKeys.has(scanKey)) continue
        this.ensureRecordKey(el)
        this.ensurePageOrder(el)
        const target = el.target
        const name = el.propertiesName
        const byTarget = this.findScannedContextRecordIndex(target, el.anchorTarget, el.anchorRecordKey, el.pageKey)
        if (byTarget >= 0) {
          // 已存在（可能是人工录制过、也可能是上次扫描的）：
          // 保留首次分配的 propertiesID，人工状态也不被扫描覆盖。
          const existing = this.recordActionList[byTarget]
          this.recordActionList[byTarget] = {
            ...existing,
            eventTypeValue: existing.manualRecord ? existing.eventTypeValue : el.eventTypeValue,
            eventTypeName: existing.manualRecord ? existing.eventTypeName : el.eventTypeName,
            propertiesName: this.getUniquePropertiesName(el.propertiesName, existing),
            realLabel: el.realLabel || existing.realLabel || '',
            rect: el.rect || existing.rect || {},
            mothed: el.mothed || 'By.XPATH',
            elementType: el.target,
            transcationType: 'playwright',
            group: el.group || existing.group,
            kind: el.kind || existing.kind,
            scanIndex: typeof el.scanIndex === 'number' ? el.scanIndex : existing.scanIndex,
            pageUrl: el.pageUrl || existing.pageUrl,
            pageOrder: typeof el.pageOrder === 'number' ? el.pageOrder : existing.pageOrder,
            scanPosition: el.position || existing.scanPosition,
            position: existing.screenshotPosition || el.position || existing.position,
            options: el.options && el.options.length > 0
              ? el.options : existing.options,
            disabled: el.disabled,
            anchorTarget: el.anchorTarget || existing.anchorTarget,
            anchorPropertiesName: el.anchorPropertiesName || existing.anchorPropertiesName,
            anchorRecordKey: el.anchorRecordKey || existing.anchorRecordKey,
            recorded: existing.recorded || this.isVisibleRecord(el),
            manualRecord: existing.manualRecord || false
          }
        } else {
          el.propertiesName = this.getUniquePropertiesName(name)
          // 扫描阶段：按钮默认隐藏，其他元素默认显示；均未人工录制
          el.recorded = !this.isButtonRecord(el)
          el.manualRecord = false
          if (!el.options) el.options = []
          this.recordActionList.push(el)
        }
      }
      this.recordInfoLit = this.sortByScanIndex(this.filterRecordListData(this.recordActionList).filter(r => this.isVisibleRecord(r)))
      this.currentRecordInfo = {}
      this.renderRecordList(this.recordInfoLit)
      this.updateRecordCount()
    } else if (message.type === 'startRecord') {
      // startRecord 只记录首个页面数据地址，用于页面级标识，不进入动作列表。
      if (!this.recordDataUrl) this.recordDataUrl = message.data
    }
  },

  /**
   * 清空所有录制数据（含截图、分组折叠状态、页面顺序映射）。
   * 调用位置：popup/index.js → clearBtn 点击
   */
  clearAll() {
    document.getElementById('listBody').innerHTML = ''
    this.recordActionList = []
    this.recordInfoLit = []
    this.scannedElementList = []
    this.currentRecordInfo = {}
    this.recordDataUrl = ''
    this.pageId = ''
    this.groupScreenshots = {}
    this.displayGroupMap = new Map()
    this.displayRoots = []
    this.groupCollapseState = {}
    this.currentPageKey = ''
    this.pageOrderMap = new Map()
    this.nextPageOrder = 0
    this.cutRecordKey = ''
    this.manualOrderEnabled = false
    this.nextRecordKey = 1
    this.deletedScanKeys = new Set()
    this.selectedRecordKeys = new Set()
    this.replayStateMap = new Map()
    this.updateRecordCount()
  },

  /** 按展示树节点 key 反查分组节点（供删除/截图/折叠等按键使用）。 */
  getGroupNode(groupKey) {
    return this.displayGroupMap.get(groupKey) || null
  },

  /** 收集分组直接包含的元素记录，坐标只绑定到其直接父分组截图。 */
  getGroupItems(node) {
    if (!node) return []
    return node.entries
      .filter(entry => entry.kind === 'item')
      .map(entry => entry.item)
  },

  /** 收集分组全部后代元素，仅用于计算自动截图停止边界。 */
  getGroupBoundaryItems(node) {
    const items = []
    function collect(currentNode) {
      currentNode.entries.forEach(entry => {
        if (entry.kind === 'item') items.push(entry.item)
        else collect(entry.node)
      })
    }
    if (node) collect(node)
    return items
  },

  /**
   * 删除指定分组及其子分组内的全部操作记录。
   * 同时清理该组及其子组的截图与折叠状态；返回删除的记录条数。
   * 注意：这里不删除磁盘上的截图文件（仅清掉展示引用），
   * 与截图列表中单张删除（走 ScreenshotService.deleteScreenshot）不同。
   */
  deleteGroup(groupKey) {
    const node = this.getGroupNode(groupKey)
    if (!node) return 0

    // 收集该子树下所有记录（引用比较，避免误删同名元素）。
    const items = new Set()
    function collectItems(currentNode) {
      currentNode.entries.forEach(entry => {
        if (entry.kind === 'item') items.add(entry.item)
        else collectItems(entry.node)
      })
    }
    collectItems(node)

    this.recordActionList = this.recordActionList.filter(item => !items.has(item))
    this.recordInfoLit = this.recordInfoLit.filter(item => !items.has(item))
    items.forEach(item => {
      const scanKey = this.getScanKey(item)
      if (scanKey) this.deletedScanKeys.add(scanKey)
    })
    this.scannedElementList = this.scannedElementList.filter(item => {
      const scanKey = this.getScanKey(item)
      return !scanKey || !this.deletedScanKeys.has(scanKey)
    })
    if (items.has(this.currentRecordInfo)) this.clearCurrentRecord()
    if ([...items].some(item => this.ensureRecordKey(item) === this.cutRecordKey)) this.cutRecordKey = ''

    // 递归清理该组及其子组的截图引用与折叠状态，避免残留孤儿数据。
    function clearGroupState(currentNode, manager) {
      delete manager.groupScreenshots[currentNode.key]
      delete manager.groupCollapseState[currentNode.key]
      currentNode.entries.forEach(entry => {
        if (entry.kind === 'group') clearGroupState(entry.node, manager)
      })
    }
    clearGroupState(node, this)

    this.renderRecordList(this.recordInfoLit)
    this.updateRecordCount()
    return items.size
  },

  getGroupScreenshots(groupKey) {
    return this.groupScreenshots[groupKey] || []
  },

  getGroupScreenshotCount(groupKey) {
    return this.getGroupScreenshots(groupKey).length
  },

  /**
   * 切换"正在截图"状态并同步所有截图按钮。
   * 无论截图按钮属于哪组，截图期间全部禁用；按钮文字为当前截图的组显示进度。
   * 状态结束（groupKey 传 null）时恢复为"截图"并解除禁用（历史页面组除外）。
   */
  setScreenshotCaptureState(groupKey, text) {
    this.screenshotCaptureGroupKey = groupKey || null
    this.screenshotCaptureText = text || '正在截图中'
    document.querySelectorAll('.group-screenshot-btn').forEach(button => {
      const groupKey = button.getAttribute('data-group-key')
      const node = this.getGroupNode(groupKey)
      const nodePageKey = node && node.path && node.path[0] ? node.path[0].key : ''
      const isHistoricalPage = !!this.currentPageKey && nodePageKey !== this.currentPageKey
      const isCurrentCapture = groupKey === this.screenshotCaptureGroupKey
      button.disabled = (this.screenshotCaptureGroupKey !== null && !isCurrentCapture) || isHistoricalPage
      button.textContent = groupKey === this.screenshotCaptureGroupKey
        ? this.screenshotCaptureText
        : '截图'
    })
  },

  /** 每个分组只保留一张当前有效截图。 */
  addGroupScreenshot(groupKey, screenshotPath) {
    this.groupScreenshots[groupKey] = screenshotPath ? [screenshotPath] : []
    this.renderRecordList(this.recordInfoLit)
  },

  /** 把截图画布归一化坐标写回操作记录，并保留扫描阶段的原始坐标。 */
  applyScreenshotPositions(items, positions) {
    ;(items || []).forEach(item => {
      const screenshotPosition = positions && positions[item.propertiesID]
      if (!screenshotPosition) return
      if (!item.scanPosition && item.position) item.scanPosition = item.position
      item.screenshotPosition = screenshotPosition.status === 'captured'
        ? {
            x1: screenshotPosition.x,
            y1: screenshotPosition.y,
            x2: screenshotPosition.x + screenshotPosition.width,
            y2: screenshotPosition.y + screenshotPosition.height
          }
        : null
      item.position = item.screenshotPosition
      item.positionStatus = screenshotPosition.status

      const scanned = this.scannedElementList.find(candidate => candidate.propertiesID === item.propertiesID)
      if (scanned && scanned !== item) {
        if (!scanned.scanPosition && scanned.position) scanned.scanPosition = scanned.position
        scanned.screenshotPosition = item.screenshotPosition
        scanned.position = item.position
        scanned.positionStatus = item.positionStatus
      }
    })
  },

  clearScreenshotPosition(item) {
    if (!item) return
    item.screenshotPosition = null
    item.position = null
    item.positionStatus = 'not-captured'
  },

  /** 从分组移除指定截图并重渲染（磁盘文件删除由调用方负责）。 */
  removeGroupScreenshot(groupKey, screenshotPath) {
    this.groupScreenshots[groupKey] = this.getGroupScreenshots(groupKey).filter(path => path !== screenshotPath)
    if (this.groupScreenshots[groupKey].length === 0) {
      this.getGroupItems(this.getGroupNode(groupKey)).forEach(item => {
        this.clearScreenshotPosition(item)
        const scanned = this.scannedElementList.find(candidate => candidate.propertiesID === item.propertiesID)
        if (scanned && scanned !== item) {
          this.clearScreenshotPosition(scanned)
        }
      })
    }
    this.renderRecordList(this.recordInfoLit)
  },

  /**
   * 输出平行节点列表，通过 propertiesID/propertiesPID 表达父子层级。
   * 分组节点使用 page/tab/collapse/dialog，操作节点统一使用 ele。
   * 结构：{ propertiesID, propertiesPID, type, propertiesName, ...对接字段 }
   * 分组节点携带其下的截图地址数组；操作节点通过 exportAction 精简字段。
   */
  buildExportGroups() {
    const result = []
    const usedNames = new Set()
    const groupNames = new Map()

    /** 按导出顺序分配全局唯一名称，重复项依次追加 _1、_2。 */
    function getUniqueExportName(name) {
      const baseName = (name || '').replace("/", "或")
      if (!baseName || !usedNames.has(baseName)) {
        if (baseName) usedNames.add(baseName)
        return baseName
      }

      let index = 1
      while (usedNames.has(baseName + '_' + index)) index++
      const uniqueName = baseName + '_' + index
      usedNames.add(uniqueName)
      return uniqueName
    }

    // 先预留全部分组名称，确保重复页面组稳定命名为“主页面_1”等。
    function reserveGroupNames(node) {
      groupNames.set(node, getUniqueExportName(node.propertiesName))
      node.entries.forEach(entry => {
        if (entry.kind === 'group') reserveGroupNames(entry.node)
      })
    }
    this.displayRoots.forEach(reserveGroupNames)

    /** 将内部记录转换为稳定的对接平台字段结构。 */
    function exportAction(item, parentId) {
      const attr = Object.assign({}, item.attributes || {})
      const scanned = RecordManager.scannedElementList.find(candidate =>
        (candidate.propertiesID && candidate.propertiesID === item.propertiesID) ||
        (candidate.target === item.target &&
          (candidate.anchorTarget || '') === (item.anchorTarget || '') &&
          (candidate.pageKey || '') === (item.pageKey || '')) ||
        (candidate.propertiesName === item.propertiesName &&
          candidate.kind === 'select' &&
          Utils.normalizeEventType(item.eventTypeValue) === 'select:click')
      )
      const options = Array.isArray(item.options) && item.options.length > 0
        ? item.options
        : (scanned && Array.isArray(scanned.options) ? scanned.options : [])

      ;['disabled', 'required', 'readonly'].forEach(key => {
        if (typeof item[key] !== 'undefined') attr[key] = item[key]
      })

      return {
        propertiesID: item.propertiesID,
        propertiesPID: parentId,
        type: 'ele',
        propertiesName: getUniqueExportName(item.propertiesName),
        eventTypeValue: Utils.normalizeEventType(item.eventTypeValue),
        eventTypeName: Utils.getEventTypeName(item.eventTypeValue),
        elementType: item.target || '',
        mothed: 'By.XPATH',
        target: item.target || '',
        options: options.slice(),
        objectValue: item.objectValue || '',
        transcationType: 'playwright',
        realLabel: item.realLabel || '',
        regionId: '',
        regionLabel: '',
        rect: JSON.stringify(item.screenshotPosition || item.rect || item.scanPosition || item.position || {}),
        positionStatus: item.positionStatus || (item.screenshotPosition ? 'captured' : 'not-captured'),
        attr: attr
      }
    }

    /** 递归把展示树节点平铺为导出列表；分组节点附带其截图地址。 */
    function exportNode(node, parentId, screenshots) {
      const propertiesID = Utils.uuid()
      result.push({
        propertiesID: propertiesID,
        propertiesPID: parentId,
        type: node.type,
        key: node.key,
        propertiesName: groupNames.get(node),
        eventTypeValue: 'click',
        eventTypeName: '点击',
        elementType: '',
        mothed: '',
        options: '',
        objectValue: '',
        transcationType: 'playwright',
        realLabel: '',
        regionId: '',
        regionLabel: '',
        rect: JSON.stringify({}),
        url: node.url || '',
        screenCapture: (screenshots[node.key] || []).slice()
      })

      node.entries.forEach(entry => {
        if (entry.kind === 'item') {
          // 无名称的条目不导出（既无定位也无录入内容，导出无意义）。
          if (!entry.item.propertiesName) return
          result.push(exportAction(entry.item, propertiesID))
        } else {
          exportNode(entry.node, propertiesID, screenshots)
        }
      })
    }

    this.displayRoots.forEach(node => exportNode(node, null, this.groupScreenshots))
    this.debugLog('export-groups-built', {
      groupCount: result.filter(item => item.type !== 'ele').length,
      actionCount: result.filter(item => item.type === 'ele').length,
      groups: result.filter(item => item.type !== 'ele').map(item => ({
        propertiesName: item.propertiesName,
        propertiesPID: item.propertiesPID
      }))
    })
    return result
  },

  /**
   * 初始化列表行点击编辑及编辑按钮事件绑定。
   * 调用位置：popup/index.js → main
   *
   * 绑定清单：
   *   - 保存事件类型 / 名称 / 对象值：把输入框值写回 currentRecordInfo 后刷新列表。
   *   - 剪切、粘贴、删除普通操作记录。
   *   - 复制 Target 按钮、行点击（选中并回填编辑框）。
   *   - 分组操作：截图、查看截图列表、删除分组。
   *   - 截图对话框 / 预览 / 单张删除。
   *   - 分组标题折叠/展开（状态按组 key 记忆）。
   */
  initEditBindings() {
    const self = this

    $(document).on('click', '.record-select', function (e) { e.stopImmediatePropagation() })
    $(document).on('change', '.record-select', function () {
      self.toggleRecordSelection($(this).attr('data-record-key'), this.checked)
    })
    $(document).on('click', '.group-select', function (e) { e.stopImmediatePropagation() })
    $(document).on('change', '.group-select', function () {
      self.selectGroupRecords($(this).attr('data-group-key'), this.checked)
    })

    // 保存编辑后的事件类型
    $('#saveCmdBtn').click(function () {
      self.currentRecordInfo.eventTypeValue = $('#editCmd').val()
      self.currentRecordInfo.eventTypeName = Utils.getEventTypeName(self.currentRecordInfo.eventTypeValue)
      self.updateRecorder()
    })

    // 删除当前选中记录。
    $('#deleteCmdBtn').click(function () {
      const recordKey = self.ensureRecordKey(self.currentRecordInfo)
      if (!recordKey) return
      if (!confirm('确定删除当前操作吗？此操作无法撤销。')) return
      self.deleteRecord(recordKey)
    })

    // 保存编辑后的名称
    $('#saveNameBtn').click(function () {
      self.currentRecordInfo.propertiesName = self.getUniquePropertiesName(
        $('#editName').val(),
        self.currentRecordInfo
      )
      self.updateRecorder()
    })

    // 保存编辑后的值
    $('#saveValBtn').click(function () {
      self.currentRecordInfo.objectValue = $('#editVal').val()
      self.updateRecorder()
    })

    // 复制 Target 内容到剪贴板，阻止触发行选中
    function fallbackCopyText(text, onSuccess) {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        if (document.execCommand('copy')) onSuccess()
      } finally {
        document.body.removeChild(textarea)
      }
    }
    // 优先使用异步剪贴板 API，失败时降级到隐藏 textarea + execCommand。
    function copyText(text, onSuccess) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess, () => fallbackCopyText(text, onSuccess))
        return
      }
      fallbackCopyText(text, onSuccess)
    }
    // 复制 Target 按钮：取行内 .col-target-text 文案，复制后短暂显示"已复制"。
    $(document).on('click', '.copy-target-btn', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      const btn = $(this)
      const text = btn.siblings('.col-target-text').text()
      const prevTimer = btn.data('copyTimer')
      if (prevTimer) clearTimeout(prevTimer)
      copyText(text, function () {
        btn.addClass('copied').text('已复制')
        btn.data('copyTimer', setTimeout(function () {
          btn.removeClass('copied').text('复制')
        }, 1000))
      })
    })

    $(document).on('click', '.cut-record-btn', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      self.cutRecord($(this).attr('data-record-key'))
    })

    $(document).on('click', '.paste-record-btn', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      self.pasteRecordBefore($(this).attr('data-record-key'))
    })

    $(document).on('click', '.delete-record-btn', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      const recordKey = $(this).attr('data-record-key')
      if (!confirm('确定删除本行操作吗？此操作无法撤销。')) return
      self.deleteRecord(recordKey)
    })

    // 行点击：唯一高亮当前行，并按稳定记录 key 反查记录填入编辑框。
    $(document).on('click', '.list-row', function () {
      $(this).siblings().removeClass('active')
      $(this).addClass('active')
      self.currentRecordInfo = self.getRecordByKey($(this).attr('data-record-key')) || {}
      $('#editCmd').val(self.currentRecordInfo.eventTypeValue || '')
      $('#editName').val(self.currentRecordInfo.propertiesName || '')
      $('#editVal').val(self.currentRecordInfo.objectValue || '')
    })

    // 分组截图按钮：截图期间当前按钮可再次点击，用于停止滚动并生成已捕获内容。
    $(document).on('click', '.group-screenshot-btn', async function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      const button = this
      const groupKey = button.getAttribute('data-group-key')
      const groupNode = self.getGroupNode(groupKey)
      if (!groupNode) return

      if (self.screenshotCaptureGroupKey === groupKey && ScreenshotService.isCapturing) {
        ScreenshotService.requestStop()
        self.setScreenshotCaptureState(groupKey, '正在停止并生成')
        return
      }

      if (self.screenshotCaptureGroupKey !== null || ScreenshotService.isCapturing) return
      self.setScreenshotCaptureState(groupKey, '准备截图')

      let captureItems = []
      try {
        const tab = await getCurrentTab()
        if (!tab || !tab.id) throw new Error('无法获取目标页面')

        captureItems = self.getGroupItems(groupNode).filter(item => item.propertiesID && item.target)
        const boundaryItems = self.getGroupBoundaryItems(groupNode).filter(item => item.target)
        groupNode.captureItems = captureItems.map(item => ({ propertiesID: item.propertiesID, target: item.target }))
        groupNode.captureBoundaryItems = boundaryItems.map(item => ({ propertiesID: item.propertiesID, target: item.target }))
        self.setScreenshotCaptureState(groupKey, '停止并生成')
        const screenshot = await ScreenshotService.captureFullPage(tab, groupNode, (current, total) => {
          self.setScreenshotCaptureState(groupKey, current === 'uploading' ? '正在上传' : '停止并生成 ' + current + '/' + total)
        })
        const previousPath = self.getGroupScreenshots(groupKey)[0]
        self.applyScreenshotPositions(captureItems, screenshot.positions)
        self.addGroupScreenshot(groupKey, screenshot.path)
        if (previousPath && previousPath !== screenshot.path) {
          try { await ScreenshotService.deleteScreenshot(previousPath) } catch (e) {}
        }
        if (screenshot.localDownloadError) {
          alert('截图上传成功，但本地下载失败：' + screenshot.localDownloadError)
        }
      } catch (error) {
        alert('截图失败: ' + error.message)
      } finally {
        delete groupNode.captureItems
        delete groupNode.captureBoundaryItems
        self.setScreenshotCaptureState(null)
      }
    })

    // 查看分组截图列表（打开对话框）
    $(document).on('click', '.group-screenshot-list', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      self.openScreenshotDialog($(this).attr('data-group-key'))
    })

    // 删除整个分组（先二次确认，避免误删）
    $(document).on('click', '.group-delete-btn', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      const groupKey = $(this).attr('data-group-key')
      const groupNode = self.getGroupNode(groupKey)
      if (!groupNode) return
      if (!confirm('确定删除分组“' + groupNode.propertiesName + '”及其下所有操作吗？此操作无法撤销。')) return
      self.deleteGroup(groupKey)
    })

    // 关闭截图列表对话框
    $('#closeScreenshotDialog').click(function () {
      self.closeScreenshotDialog()
    })

    // 关闭截图预览层
    $('#closeScreenshotPreview').click(function () {
      self.closeScreenshotPreview()
    })

    // 缩略图 / 预览按钮：打开大图预览
    $(document).on('click', '.screenshot-thumb, .preview-screenshot-btn', function () {
      self.openScreenshotPreview($(this).attr('data-screenshot-path'))
    })

    // 单张删除截图：先删磁盘文件，再移除展示引用并刷新对话框
    $(document).on('click', '.delete-screenshot-btn', async function () {
      const groupKey = $(this).attr('data-group-key')
      const screenshotPath = $(this).attr('data-screenshot-path')
      if (!confirm('确定删除这张截图吗？')) return
      await ScreenshotService.deleteScreenshot(screenshotPath)
      self.removeGroupScreenshot(groupKey, screenshotPath)
      self.openScreenshotDialog(groupKey)
    })

    // 组标题行点击：折叠/展开该组，折叠状态按组 key 记忆
    $(document).on('click', '.list-group-header', function () {
      const key = $(this).attr('data-group-key')
      self.groupCollapseState[key] = !self.groupCollapseState[key]
      self.renderRecordList(self.recordInfoLit)
    })
  },

  /** 打开分组截图列表对话框（无截图时显示空态）。 */
  openScreenshotDialog(groupKey) {
    const node = this.getGroupNode(groupKey)
    if (!node) return
    const paths = this.getGroupScreenshots(groupKey)
    document.getElementById('screenshotDialogTitle').textContent = node.propertiesName + ' - 截图 ' + paths.length
    let html = ''
    if (paths.length === 0) {
      html = '<div class="screenshot-empty">该分组暂无截图</div>'
    } else {
      // 每张截图：缩略图 + 文件名 + 预览/删除按钮（缩略图本身也可点开预览）。
      paths.forEach(path => {
        const previewUrl = ScreenshotService.getPreviewUrl(path)
        const fileName = path.split('/').pop()
        html += '<div class="screenshot-item">'
        if (previewUrl) {
          html += '<img class="screenshot-thumb" src="' + escHtml(previewUrl) + '" data-screenshot-path="' + escHtml(path) + '" alt="' + escHtml(fileName) + '">'
        } else {
          html += '<div class="screenshot-thumb screenshot-empty">预览不可用</div>'
        }
        html += '<span class="screenshot-file-name" title="' + escHtml(path) + '">' + escHtml(fileName) + '</span>'
        html += '<span class="screenshot-item-actions">'
        if (previewUrl) html += '<button type="button" class="preview-screenshot-btn" data-screenshot-path="' + escHtml(path) + '">预览</button>'
        html += '<button type="button" class="delete delete-screenshot-btn" data-group-key="' + escHtml(groupKey) + '" data-screenshot-path="' + escHtml(path) + '">删除</button>'
        html += '</span></div>'
      })
    }
    document.getElementById('screenshotDialogBody').innerHTML = html
    document.getElementById('screenshotDialog').classList.add('open')
    document.getElementById('screenshotDialog').setAttribute('aria-hidden', 'false')
  },

  closeScreenshotDialog() {
    document.getElementById('screenshotDialog').classList.remove('open')
    document.getElementById('screenshotDialog').setAttribute('aria-hidden', 'true')
  },

  /** 打开大图预览：加载截图到预览层图片并显示（无预览地址则忽略）。 */
  openScreenshotPreview(screenshotPath) {
    const previewUrl = ScreenshotService.getPreviewUrl(screenshotPath)
    if (!previewUrl) return
    document.getElementById('screenshotPreviewImage').src = previewUrl
    document.getElementById('screenshotPreview').classList.add('open')
    document.getElementById('screenshotPreview').setAttribute('aria-hidden', 'false')
  },

  /** 关闭大图预览并清空图片地址，避免再次打开时闪旧图。 */
  closeScreenshotPreview() {
    document.getElementById('screenshotPreview').classList.remove('open')
    document.getElementById('screenshotPreview').setAttribute('aria-hidden', 'true')
    document.getElementById('screenshotPreviewImage').removeAttribute('src')
  }
}
