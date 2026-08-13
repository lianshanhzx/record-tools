/**
 * recordManager.js — 录制数据管理模块
 * 负责录制动作数据的存储、列表渲染、过滤去重、行编辑等操作。
 *
 * 依赖：
 *   - Utils (libs/utils.js)
 *   - escHtml (popup/index.js 全局函数)
 *   - jQuery (libs/jquery.js)
 */

const RecordManager = {
  recordActionList: [],
  recordInfoLit: [],
  currentRecordInfo: {},
  recordDataUrl: '',
  // 分组折叠状态，key 为组节点 key，true 表示折叠（默认展开）
  groupCollapseState: {},

  /**
   * 更新录制计数显示。
   * 调用位置：recordManager.js → handleMessage / popup/index.js → clearBtn 点击
   */
  updateRecordCount() {
    const el = document.getElementById('recordCount')
    if (el) el.textContent = this.recordInfoLit.length + ' 条'
  },

  /**
   * 更新当前编辑中的录制动作并刷新列表。
   * 调用位置：popup/index.js → saveCmdBtn / saveNameBtn / saveValBtn / deleteCmdBtn 点击
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

    // 渲染单条记录行，depth 用于计算缩进
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

    function normalizePath(item) {
      return Array.isArray(item && item.group)
        ? item.group.filter(g => g && (g.key || g.name))
        : []
    }

    function sameGroup(a, b) {
      return (a.type || '') === (b.type || '') && (a.key || a.name) === (b.key || b.name)
    }

    const pageGroup = {
      type: 'page',
      name: '主页面',
      key: (typeof ElementGrouper !== 'undefined' && ElementGrouper.PAGE_GROUP_KEY) || '__page__',
      fixedKey: true
    }

    /**
     * 计算用于展示的有效分组路径。
     * 普通记录沿用自身路径；锚点增量记录改为：锚点父路径 + 增量内容自身的相对路径。
     */
    function displayPath(item, anchorByTarget) {
      const ownPath = normalizePath(item)
      if (!item.anchorTarget) {
        return ownPath.length > 0 ? ownPath : [pageGroup]
      }

      const anchor = anchorByTarget.get(item.anchorTarget)
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
     */
    function buildDisplayTree(items) {
      const roots = []
      const nodeMap = new Map()
      const anchorByTarget = new Map()

      ;(items || []).forEach(item => {
        if (item.target) anchorByTarget.set(item.target, item)
      })

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

    // 渲染分组标题行
    function renderHeader(node, depth) {
      const collapsed = !!self.groupCollapseState[node.key]
      const typeLabels = (typeof ElementGrouper !== 'undefined' && ElementGrouper.GROUP_TYPE_LABELS) || {}
      const typeLabel = typeLabels[node.type] || '分组'
      const indent = 16 + depth * 14
      html += '<div class="list-group-header group-type-' + escHtml(node.type) + '" data-group-key="' + escHtml(node.key) + '" style="padding-left:' + indent + 'px">'
      html += '<span class="group-arrow">' + (collapsed ? '▸' : '▾') + '</span>'
      html += '<span class="group-type-badge">' + escHtml(typeLabel) + '</span>'
      html += '<span class="group-name" title="' + escHtml(node.name) + '">' + escHtml(node.name) + '</span>'
      html += '<span class="group-count">' + node.count + ' 条</span>'
      html += '</div>'
    }

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

    function hasChildGroup(node) {
      return node.entries.some(entry => entry.kind === 'group')
    }

    if (!data || data.length === 0) {
      document.getElementById('listBody').innerHTML = ''
      return
    }

    const roots = buildDisplayTree(data)
    roots.forEach(node => {
      // 仅有纯主页面记录时继续保持平铺；存在子分组时显示主页面标题以明确层级。
      const showHeader = !(roots.length === 1 && node.type === 'page' && !hasChildGroup(node))
      renderNode(node, 0, showHeader)
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
   * 调用位置：recordManager.js → handleMessage
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
  findContextRecordIndex(target, anchorTarget) {
    if (!target) return -1
    const anchor = anchorTarget || ''
    return this.recordActionList.findIndex(item => {
      return item.target === target && (item.anchorTarget || '') === anchor
    })
  },

  /**
   * 同名去重只在同一锚点上下文内执行，不同按钮打开的复用弹窗保留各自原始字段名。
   */
  computedSameContextName(list, name, anchorTarget) {
    const anchor = anchorTarget || ''
    return list.filter(item => {
      if ((item.anchorTarget || '') !== anchor || !item.propertiesName) return false
      const arr = item.propertiesName.split('-')
      return arr[0] === name
    }).length
  },

  /**
   * 处理来自 content 的录制消息（addActionData / startRecord）。
   * 调用位置：popup/index.js → chrome.runtime.onMessage 监听
   */
  handleMessage(message) {
    if (message.type !== 'addActionData' && message.type !== 'startRecord' && message.type !== 'addScannedElements') return;
    if (message.type === 'addActionData') {
      const target = message.data.target
      const name = message.data.propertiesName
      const byTarget = this.findContextRecordIndex(target, message.data.anchorTarget)
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
          options: message.data.options && message.data.options.length > 0
            ? message.data.options : this.recordActionList[byTarget].options,
          anchorTarget: message.data.anchorTarget || this.recordActionList[byTarget].anchorTarget,
          anchorPropertiesName: message.data.anchorPropertiesName || this.recordActionList[byTarget].anchorPropertiesName,
          recorded: true,
          manualRecord: true
        }
      } else {
        if (this.recordActionList.length > 0) {
          const cnt = this.computedSameContextName(this.recordActionList, name, message.data.anchorTarget)
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
      for (const el of elements) {
        const target = el.target
        const name = el.propertiesName
        const byTarget = this.findContextRecordIndex(target, el.anchorTarget)
        if (byTarget >= 0) {
          this.recordActionList[byTarget] = {
            ...this.recordActionList[byTarget],
            command: el.command,
            propertiesName: el.propertiesName,
            action: el.action,
            group: el.group || this.recordActionList[byTarget].group,
            kind: el.kind || this.recordActionList[byTarget].kind,
            scanIndex: typeof el.scanIndex === 'number' ? el.scanIndex : this.recordActionList[byTarget].scanIndex,
            options: el.options && el.options.length > 0
              ? el.options : this.recordActionList[byTarget].options,
            anchorTarget: el.anchorTarget || this.recordActionList[byTarget].anchorTarget,
            anchorPropertiesName: el.anchorPropertiesName || this.recordActionList[byTarget].anchorPropertiesName,
            recorded: this.recordActionList[byTarget].recorded || this.isVisibleRecord(el),
            manualRecord: this.recordActionList[byTarget].manualRecord || false
          }
        } else {
          if (this.recordActionList.length > 0) {
            const cnt = this.computedSameContextName(this.recordActionList, name, el.anchorTarget)
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
      this.recordDataUrl = message.data
    }
  },

  /**
   * 清空所有录制数据。
   * 调用位置：popup/index.js → clearBtn 点击
   */
  clearAll() {
    document.getElementById('listBody').innerHTML = ''
    this.recordActionList = []
    this.recordInfoLit = []
    this.currentRecordInfo = {}
    this.recordDataUrl = ''
    this.groupCollapseState = {}
    this.updateRecordCount()
  },

  /**
   * 初始化列表行点击编辑及编辑按钮事件绑定。
   * 调用位置：popup/index.js → main
   */
  initEditBindings() {
    const self = this

    $('#saveCmdBtn').click(function () {
      self.currentRecordInfo.command = $('#editCmd').val()
      self.updateRecorder()
    })

    $('#deleteCmdBtn').click(function () {
      self.recordActionList = self.recordActionList.filter(item => item.id !== self.currentRecordInfo.id)
      self.recordInfoLit = self.recordInfoLit.filter(item => item.id !== self.currentRecordInfo.id)
      setTimeout(() => self.renderRecordList(self.recordInfoLit), 0)
      self.updateRecordCount()
    })

    $('#saveNameBtn').click(function () {
      self.currentRecordInfo.propertiesName = $('#editName').val()
      self.updateRecorder()
    })

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
    function copyText(text, onSuccess) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess, () => fallbackCopyText(text, onSuccess))
        return
      }
      fallbackCopyText(text, onSuccess)
    }
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

    // 组标题行点击：折叠/展开该组，折叠状态按组 key 记忆
    $(document).on('click', '.list-group-header', function () {
      const key = $(this).attr('data-group-key')
      self.groupCollapseState[key] = !self.groupCollapseState[key]
      self.renderRecordList(self.recordInfoLit)
    })
  }
}
