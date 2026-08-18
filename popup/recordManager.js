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
      this.ensurePageOrder(incoming)
      const index = this.scannedElementList.findIndex(item =>
        item.target === incoming.target &&
        (item.anchorTarget || '') === (incoming.anchorTarget || '') &&
        (item.pageKey || '') === (incoming.pageKey || '')
      )
      if (index >= 0) this.scannedElementList[index] = Object.assign({}, this.scannedElementList[index], incoming)
      else this.scannedElementList.push(Object.assign({}, incoming))
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
   * 把 currentRecordInfo 的修改写回列表并刷新渲染。
   * 注意：recordInfoLit 中的对象与 currentRecordInfo 是同引用，因此这里的
   * 循环其实只是"确认存在"，真正的写回通过引用直接生效。
   * 调用位置：popup/index.js → saveCmdBtn / saveNameBtn / saveValBtn 点击
   * （deleteCmdBtn 不经过这里，直接在事件里过滤列表后重渲染）。
   */
  updateRecorder() {
    for (let item of this.recordInfoLit) {
      if (item.id === this.currentRecordInfo.id) { item = this.currentRecordInfo; break }
    }
    setTimeout(() => this.renderRecordList(this.recordInfoLit), 0)
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
     * 行 id 由 item.id + '_' + item.timestamp 组成，供行点击时反查记录。
     */
    function renderRow(item, depth) {
      let name = item.propertiesName
      if (!name && item.attributes && item.attributes.placeholder) name = item.attributes.placeholder
      idx++
      const indent = 16 + depth * 14

      // 人工录制标记
      const manualBadge = item.manualRecord ? '<span class="manual-badge">人工</span>' : ''

      // 锚点关系标记：展示该元素由哪个按钮触发而出现在列表中
      const anchorBadge = item.anchorPropertiesName
        ? '<span class="anchor-badge" title="由 ' + escHtml(item.anchorPropertiesName) + ' 触发">→ ' + escHtml(item.anchorPropertiesName) + '</span>'
        : ''

      // 下拉框选项提示
      let valText = item.value || ''
      let valTitle = valText
      if (item.options && item.options.length > 0) {
        valText = valText ? valText + '（' + item.options.length + '项）' : '（' + item.options.length + '项）'
        valTitle = (item.value || '') + '\n选项：' + item.options.join(' / ')
      }

      html += '<div class="list-row" style="padding-left:' + indent + 'px" id="' + item.id + '_' + item.timestamp + '">'
      html += '<span class="col-seq">' + idx + '</span>'
      html += '<span class="col-cmd">' + escHtml(item.command || '') + '</span>'
      html += '<span class="col-name" title="' + escHtml(name || '') + '">' + manualBadge + escHtml(name || '') + anchorBadge + '</span>'
      html += '<span class="col-target" title="' + escHtml(item.target || '') + '">'
      html += '<span class="col-target-text">' + escHtml(item.target || '') + '</span>'
      html += '<button type="button" class="copy-target-btn" title="复制 Target">复制</button>'
      html += '</span>'
      html += '<span class="col-val" title="' + escHtml(valTitle) + '">' + escHtml(valText) + '</span>'
      html += '</div>'
    }

    /** 提取记录的 group 路径，过滤掉无 key 的脏分组项，返回有效的分组数组。 */
    function normalizePath(item) {
      return Array.isArray(item && item.group)
        ? item.group.filter(g => g && (g.key || g.name))
        : []
    }

    /** 判断两个分组节点是否表示同一个组（type + key 都相同），key 缺失时回退比较 name。 */
    function sameGroup(a, b) {
      return (a.type || '') === (b.type || '') && (a.key || a.name) === (b.key || b.name)
    }

    // 兜底页面组：无分组信息的记录统一归入"主页面"。
    const pageGroup = {
      type: 'page',
      name: '主页面',
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
      const anchor = anchorByTarget.get((item.pageKey || '') + '\n' + item.anchorTarget)
      if (!anchor) return ownPath.length > 0 ? ownPath : [pageGroup]

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
          key: (g.key || g.name) + '@@anchor=' + item.anchorTarget
        })
      })
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

      // 先建立 target -> 记录 的索引，供 displayPath 反查锚点记录。
      ;(items || []).forEach(item => {
        if (item.target) anchorByTarget.set((item.pageKey || '') + '\n' + item.target, item)
      })

      /**
       * 沿路径逐级查找/创建分组节点；已存在则复用并累加 count。
       * fixedKey 的节点（如主页面）直接以自身 key 作为 nodeKey，不再拼接父路径。
       */
      function ensurePath(path) {
        let parent = null
        let parentKey = ''
        let node = null

        path.forEach(g => {
          const part = (g.type || 'group') + ':' + (g.key || g.name)
          const nodeKey = g.fixedKey ? g.key : (parentKey ? parentKey + '|' + part : '|' + part)
          node = nodeMap.get(nodeKey)
          if (!node) {
            node = {
              key: nodeKey,
              type: g.type || 'group',
              name: g.name || '分组',
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
        })

        return node
      }

      ;(items || []).forEach(item => {
        const node = ensurePath(displayPath(item, anchorByTarget))
        if (node) node.entries.push({ kind: 'item', item: item })
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
      const screenshotDisabled = self.screenshotCaptureGroupKey !== null || isHistoricalPage ? ' disabled' : ''
      const screenshotText = self.screenshotCaptureGroupKey === node.key ? self.screenshotCaptureText : '截图'
      const groupTitle = node.type === 'page' && node.url ? node.name + ' - ' + node.url : node.name
      html += '<div class="list-group-header group-type-' + escHtml(node.type) + '" data-group-key="' + escHtml(node.key) + '" style="padding-left:' + indent + 'px">'
      html += '<span class="group-arrow">' + (collapsed ? '▸' : '▾') + '</span>'
      html += '<span class="group-type-badge">' + escHtml(typeLabel) + '</span>'
      html += '<span class="group-name" title="' + escHtml(groupTitle) + '">' + escHtml(node.name) + '</span>'
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
      return
    }

    const roots = buildDisplayTree(data)
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
    return item.kind === 'button' || item.command === 'click'
  },

  /**
   * 判断记录是否应在列表中显示。
   * 规则：按钮仅在已被人工录制后显示；其他元素默认显示。
   */
  isVisibleRecord(item) {
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
   * 计算同名 propertiesName 的数量，用于去重命名。
   * 只比较 '-' 分隔后的首段：同名元素按"名称-N"递增命名，N 为已存在的同名个数。
   * 注意：与 computedSameContextName 不同，本方法不限定锚点上下文，
   * 且当前无调用方（保留为历史语义）。
   */
  computedSamePropertiesName(list, name) {
    return list.filter(item => {
      if (!item.propertiesName) return false
      const arr = item.propertiesName.split('-')
      return arr[0] === name
    }).length
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

  /**
   * 同名去重只在同一锚点上下文内执行，不同按钮打开的复用弹窗保留各自原始字段名。
   */
  computedSameContextName(list, name, anchorTarget, pageKey) {
    const anchor = anchorTarget || ''
    return list.filter(item => {
      if ((item.anchorTarget || '') !== anchor ||
          (item.pageKey || '') !== (pageKey || '') || !item.propertiesName) return false
      const arr = item.propertiesName.split('-')
      return arr[0] === name
    }).length
  },

  /**
   * 处理来自 content 的录制消息（addActionData / startRecord / addScannedElements）。
   * 调用位置：popup/index.js → chrome.runtime.onMessage 监听
   *
   * 三条分支：
   *   - addActionData：人工录制动作入库（命中上下文则合并字段，否则去重命名后追加）。
   *   - addScannedElements：扫描元素入库；replacePageKey 表示页面切换，先清掉该页的
   *     旧扫描记录（但保留 manualRecord 的人工动作），再合并新扫描快照。
   *   - startRecord：仅被过滤，说明存在该消息类型但此处不处理（参数未使用）。
   */
  handleMessage(message) {
    if (message.type !== 'addActionData' && message.type !== 'startRecord' && message.type !== 'addScannedElements') return;
    if (message.type === 'addActionData') {
      this.ensurePageOrder(message.data)
      const target = message.data.target
      const name = message.data.propertiesName
      this.currentPageKey = message.data.pageKey || this.currentPageKey
      // 同一 target+anchorTarget 已有记录：只合并可变字段，保留历史，标记为已录制。
      const byTarget = this.findContextRecordIndex(target, message.data.anchorTarget, message.data.pageKey)
      if (byTarget >= 0) {
        this.recordActionList[byTarget] = {
          ...this.recordActionList[byTarget],
          value: message.data.value,
          command: message.data.command,
          propertiesName: message.data.propertiesName,
          action: message.data.action,
          group: message.data.group || this.recordActionList[byTarget].group,
          kind: message.data.kind || this.recordActionList[byTarget].kind,
          scanIndex: typeof message.data.scanIndex === 'number' ? message.data.scanIndex : this.recordActionList[byTarget].scanIndex,
          pageUrl: message.data.pageUrl || this.recordActionList[byTarget].pageUrl,
          pageOrder: typeof message.data.pageOrder === 'number' ? message.data.pageOrder : this.recordActionList[byTarget].pageOrder,
          options: message.data.options && message.data.options.length > 0
            ? message.data.options : this.recordActionList[byTarget].options,
          anchorTarget: message.data.anchorTarget || this.recordActionList[byTarget].anchorTarget,
          anchorPropertiesName: message.data.anchorPropertiesName || this.recordActionList[byTarget].anchorPropertiesName,
          recorded: true,
          manualRecord: true
        }
      } else {
        // 新记录：同一锚点上下文内已存在同名元素时，按"名称-N"追加后缀去重。
        if (this.recordActionList.length > 0) {
          const cnt = this.computedSameContextName(this.recordActionList, name, message.data.anchorTarget, message.data.pageKey)
          if (cnt > 0) message.data.propertiesName = name + '-' + cnt
        }
        message.data.recorded = true
        message.data.manualRecord = true
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
        this.ensurePageOrder(el)
        const target = el.target
        const name = el.propertiesName
        const byTarget = this.findContextRecordIndex(target, el.anchorTarget, el.pageKey)
        if (byTarget >= 0) {
          // 已存在（可能是人工录制过、也可能是上次扫描的）：
          // recorded 取"已有值或当前扫描可见性"的并集，人工状态不被扫描覆盖。
          this.recordActionList[byTarget] = {
            ...this.recordActionList[byTarget],
            command: el.command,
            propertiesName: el.propertiesName,
            action: el.action,
            group: el.group || this.recordActionList[byTarget].group,
            kind: el.kind || this.recordActionList[byTarget].kind,
            scanIndex: typeof el.scanIndex === 'number' ? el.scanIndex : this.recordActionList[byTarget].scanIndex,
            pageUrl: el.pageUrl || this.recordActionList[byTarget].pageUrl,
            pageOrder: typeof el.pageOrder === 'number' ? el.pageOrder : this.recordActionList[byTarget].pageOrder,
            options: el.options && el.options.length > 0
              ? el.options : this.recordActionList[byTarget].options,
            anchorTarget: el.anchorTarget || this.recordActionList[byTarget].anchorTarget,
            anchorPropertiesName: el.anchorPropertiesName || this.recordActionList[byTarget].anchorPropertiesName,
            recorded: this.recordActionList[byTarget].recorded || this.isVisibleRecord(el),
            manualRecord: this.recordActionList[byTarget].manualRecord || false
          }
        } else {
          if (this.recordActionList.length > 0) {
            const cnt = this.computedSameContextName(this.recordActionList, name, el.anchorTarget, el.pageKey)
            if (cnt > 0) el.propertiesName = name + '-' + cnt
          }
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
    this.groupScreenshots = {}
    this.displayGroupMap = new Map()
    this.displayRoots = []
    this.groupCollapseState = {}
    this.currentPageKey = ''
    this.pageOrderMap = new Map()
    this.nextPageOrder = 0
    this.updateRecordCount()
  },

  /** 按展示树节点 key 反查分组节点（供删除/截图/折叠等按键使用）。 */
  getGroupNode(groupKey) {
    return this.displayGroupMap.get(groupKey) || null
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
    this.currentRecordInfo = {}

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
      button.disabled = this.screenshotCaptureGroupKey !== null || isHistoricalPage
      button.textContent = groupKey === this.screenshotCaptureGroupKey
        ? this.screenshotCaptureText
        : '截图'
    })
  },

  /** 追加一张截图到分组并重渲染（渲染标题上的截图数量）。 */
  addGroupScreenshot(groupKey, screenshotPath) {
    if (!this.groupScreenshots[groupKey]) this.groupScreenshots[groupKey] = []
    this.groupScreenshots[groupKey].push(screenshotPath)
    this.renderRecordList(this.recordInfoLit)
  },

  /** 从分组移除指定截图并重渲染（磁盘文件删除由调用方负责）。 */
  removeGroupScreenshot(groupKey, screenshotPath) {
    this.groupScreenshots[groupKey] = this.getGroupScreenshots(groupKey).filter(path => path !== screenshotPath)
    this.renderRecordList(this.recordInfoLit)
  },

  /**
   * 输出平行节点列表，通过 id/pid 表达操作列表中的父子层级。
   * 分组节点使用 page/tab/collapse/dialog，操作节点统一使用 ele。
   * 结构：{ id, pid, type, key?, name?, url?, screenshots?, ...动作字段 }
   * 分组节点携带其下的截图地址数组；操作节点通过 exportAction 精简字段。
   */
  buildExportGroups() {
    const result = []

    /** 将内部记录精简为可导出的动作对象（剔除渲染/定位内部字段，保留录入内容）。 */
    function exportAction(item, parentId) {
      const {
        group,
        attributes,
        disabled,
        required,
        readonly,
        tagName,
        kind,
        label,
        placeholder,
        title,
        type,
        options,
        scanIndex,
        pageKey,
        pageUrl,
        routeIdentity,
        pageOrder,
        ...action
      } = item
      const attr = Object.assign({}, attributes || {})

      ;['disabled', 'required', 'readonly'].forEach(key => {
        if (typeof item[key] !== 'undefined') attr[key] = item[key]
      })

      return Object.assign(action, {
        id: item.id,
        pid: parentId,
        type: 'ele',
        params: { label_text: item.propertiesName, value: item.value || '' },
        attr: attr
      })
    }

    /** 递归把展示树节点平铺为导出列表；分组节点附带其截图地址。 */
    function exportNode(node, parentId, screenshots) {
      result.push({
        id: node.key,
        pid: parentId,
        type: node.type,
        key: node.key,
        name: node.name,
        url: node.url || '',
        screenshots: (screenshots[node.key] || []).slice()
      })

      node.entries.forEach(entry => {
        if (entry.kind === 'item') {
          // 无名称的条目不导出（既无定位也无录入内容，导出无意义）。
          if (!entry.item.propertiesName) return
          result.push(exportAction(entry.item, node.key))
        } else {
          exportNode(entry.node, node.key, screenshots)
        }
      })
    }

    this.displayRoots.forEach(node => exportNode(node, null, this.groupScreenshots))
    return result
  },

  /**
   * 初始化列表行点击编辑及编辑按钮事件绑定。
   * 调用位置：popup/index.js → main
   *
   * 绑定清单：
   *   - 保存命令 / 名称 / 值：把输入框值写回 currentRecordInfo 后刷新列表。
   *   - 删除记录：直接从两个列表按 id 过滤，不经过 updateRecorder。
   *   - 复制 Target 按钮、行点击（选中并回填编辑框）。
   *   - 分组操作：截图、查看截图列表、删除分组。
   *   - 截图对话框 / 预览 / 单张删除。
   *   - 分组标题折叠/展开（状态按组 key 记忆）。
   */
  initEditBindings() {
    const self = this

    // 保存编辑后的命令
    $('#saveCmdBtn').click(function () {
      self.currentRecordInfo.command = $('#editCmd').val()
      self.updateRecorder()
    })

    // 删除当前选中记录（列表对象引用与 currentRecordInfo 一致，按 id 过滤即可）
    $('#deleteCmdBtn').click(function () {
      self.recordActionList = self.recordActionList.filter(item => item.id !== self.currentRecordInfo.id)
      self.recordInfoLit = self.recordInfoLit.filter(item => item.id !== self.currentRecordInfo.id)
      setTimeout(() => self.renderRecordList(self.recordInfoLit), 0)
      self.updateRecordCount()
    })

    // 保存编辑后的名称
    $('#saveNameBtn').click(function () {
      self.currentRecordInfo.propertiesName = $('#editName').val()
      self.updateRecorder()
    })

    // 保存编辑后的值
    $('#saveValBtn').click(function () {
      self.currentRecordInfo.value = $('#editVal').val()
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

    // 行点击：唯一高亮当前行，并按 id_timestamp 反查记录填入编辑框。
    $(document).on('click', '.list-row', function () {
      $(this).siblings().removeClass('active')
      $(this).addClass('active')
      const id = $(this).attr('id')
      for (let item of self.recordInfoLit) {
        if (item.id + '_' + item.timestamp === id) {
          self.currentRecordInfo = item
          break
        }
      }
      $('#editCmd').val(self.currentRecordInfo.command || '')
      $('#editName').val(self.currentRecordInfo.propertiesName || '')
      $('#editVal').val(self.currentRecordInfo.value || '')
    })

    // 分组截图按钮：整页滚动截图，期间禁用所有截图按钮，完成后追加到分组。
    $(document).on('click', '.group-screenshot-btn', async function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      const button = this
      const groupKey = button.getAttribute('data-group-key')
      const groupNode = self.getGroupNode(groupKey)
      if (!groupNode) return

      const tab = await getCurrentTab()
      if (!tab || !tab.id) {
        alert('无法获取目标页面')
        return
      }

      self.setScreenshotCaptureState(groupKey, '正在截图中')
      try {
        const screenshotPath = await ScreenshotService.captureFullPage(tab, groupNode, (current, total) => {
          self.setScreenshotCaptureState(groupKey, '正在截图中 ' + current + '/' + total)
        })
        self.addGroupScreenshot(groupKey, screenshotPath)
      } catch (error) {
        alert('截图失败: ' + error.message)
      } finally {
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
      if (!confirm('确定删除分组“' + groupNode.name + '”及其下所有操作吗？此操作无法撤销。')) return
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
    document.getElementById('screenshotDialogTitle').textContent = node.name + ' - 截图 ' + paths.length
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
