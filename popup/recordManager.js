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
   * 渲染录制动作列表到 DOM（按显示区域树形分组）。
   * 通过 libs/elementGrouper.js → buildTree 将扁平列表构建为树，
   * 组标题行支持折叠/展开（状态记录在 groupCollapseState 中，默认展开），
   * 序号跨组全局连续编号，与原有列表语义保持一致。
   * 当所有记录都属于"主页面"默认组时，保持原有平铺渲染，不显示组标题。
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
      html += '<span class="col-name" title="' + escHtml(name || '') + '">' + manualBadge + escHtml(name || '') + '</span>'
      html += '<span class="col-target" title="' + escHtml(item.target || '') + '">'
      html += '<span class="col-target-text">' + escHtml(item.target || '') + '</span>'
      html += '<button type="button" class="copy-target-btn" title="复制 Target">复制</button>'
      html += '</span>'
      html += '<span class="col-val" title="' + escHtml(valTitle) + '">' + escHtml(valText) + '</span>'
      html += '</div>'
    }

    // 递归统计组内（含子组）记录条数
    function countNodeItems(node) {
      let count = node.items.length
      for (const child of node.children) count += countNodeItems(child)
      return count
    }

    // 递归渲染组节点：组标题行 + 直接记录 + 子组
    function renderNode(node, depth) {
      const collapsed = !!self.groupCollapseState[node.key]
      const typeLabels = (typeof ElementGrouper !== 'undefined' && ElementGrouper.GROUP_TYPE_LABELS) || {}
      const typeLabel = typeLabels[node.type] || '分组'
      const indent = 16 + depth * 14
      html += '<div class="list-group-header group-type-' + escHtml(node.type) + '" data-group-key="' + escHtml(node.key) + '" style="padding-left:' + indent + 'px">'
      html += '<span class="group-arrow">' + (collapsed ? '▸' : '▾') + '</span>'
      html += '<span class="group-type-badge">' + escHtml(typeLabel) + '</span>'
      html += '<span class="group-name" title="' + escHtml(node.name) + '">' + escHtml(node.name) + '</span>'
      html += '<span class="group-count">' + countNodeItems(node) + ' 条</span>'
      html += '</div>'
      if (!collapsed) {
        node.items.forEach(item => renderRow(item, depth + 1))
        node.children.forEach(child => renderNode(child, depth + 1))
      }
    }

    const tree = (typeof ElementGrouper !== 'undefined') ? ElementGrouper.buildTree(data) : null
    if (!tree || tree.length === 0) {
      document.getElementById('listBody').innerHTML = ''
      return
    }
    // 仅存在"主页面"默认组时保持原有平铺样式
    if (tree.length === 1 && tree[0].type === 'page') {
      tree[0].items.forEach(item => renderRow(item, 0))
    } else {
      tree.forEach(node => renderNode(node, 0))
    }
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
   * 处理来自 content 的录制消息（addActionData / startRecord）。
   * 调用位置：popup/index.js → chrome.runtime.onMessage 监听
   */
  handleMessage(message) {
    if (message.type !== 'addActionData' && message.type !== 'startRecord' && message.type !== 'addScannedElements') return;
    if (message.type === 'addActionData') {
      const target = message.data.target
      const name = message.data.propertiesName
      const byTarget = target ? this.recordActionList.findIndex(a => a.target === target) : -1
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
          options: message.data.options || this.recordActionList[byTarget].options,
          recorded: true,
          manualRecord: true
        }
      } else {
        if (this.recordActionList.length > 0) {
          const cnt = this.computedSamePropertiesName(this.recordActionList, name)
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
        const byTarget = target ? this.recordActionList.findIndex(a => a.target === target) : -1
        if (byTarget >= 0) {
          this.recordActionList[byTarget] = {
            ...this.recordActionList[byTarget],
            command: el.command,
            propertiesName: el.propertiesName,
            action: el.action,
            group: el.group || this.recordActionList[byTarget].group,
            kind: el.kind || this.recordActionList[byTarget].kind,
            scanIndex: typeof el.scanIndex === 'number' ? el.scanIndex : this.recordActionList[byTarget].scanIndex,
            options: el.options || this.recordActionList[byTarget].options,
            recorded: this.recordActionList[byTarget].recorded || this.isVisibleRecord(el),
            manualRecord: this.recordActionList[byTarget].manualRecord || false
          }
        } else {
          if (this.recordActionList.length > 0) {
            const cnt = this.computedSamePropertiesName(this.recordActionList, name)
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
