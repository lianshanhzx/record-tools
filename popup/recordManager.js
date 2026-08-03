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
   * 渲染录制动作列表到 DOM。
   * 调用位置：recordManager.js → handleMessage / updateRecorder / popup/index.js
   */
  renderRecordList(data) {
    let html = ''
    let idx = 0
    for (let item of data) {
      let name = item.propertiesName
      if (!name && item.attributes && item.attributes.placeholder) name = item.attributes.placeholder
      idx++
      html += '<div class="list-row" id="' + item.id + '_' + item.timestamp + '">'
      html += '<span class="col-seq">' + idx + '</span>'
      html += '<span class="col-cmd">' + escHtml(item.command || '') + '</span>'
      html += '<span class="col-name" title="' + escHtml(name || '') + '">' + escHtml(name || '') + '</span>'
      html += '<span class="col-ttype">' + escHtml(item.targetType || '') + '</span>'
      html += '<span class="col-target" title="' + escHtml(item.target || '') + '">' + escHtml(item.target || '') + '</span>'
      html += '<span class="col-val" title="' + escHtml(item.value || '') + '">' + escHtml(item.value || '') + '</span>'
      html += '</div>'
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
    if (message.type === 'addActionData') {
      const target = message.data.target
      const name = message.data.propertiesName
      const byTarget = target ? this.recordActionList.findIndex(a => a.target === target) : -1
      if (byTarget >= 0) {
        this.recordActionList[byTarget] = { ...this.recordActionList[byTarget], value: message.data.value, command: message.data.command, propertiesName: message.data.propertiesName, action: message.data.action }
      } else {
        if (this.recordActionList.length > 0) {
          const cnt = this.computedSamePropertiesName(this.recordActionList, name)
          if (cnt > 0) message.data.propertiesName = name + '-' + cnt
        }
        this.recordActionList.push(message.data)
      }
      this.recordInfoLit = this.filterRecordListData(this.recordActionList)
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
      self.recordInfoLit = self.recordInfoLit.filter(item => item.id !== self.currentRecordInfo.id)
      setTimeout(() => self.renderRecordList(self.recordInfoLit), 0)
    })

    $('#saveNameBtn').click(function () {
      self.currentRecordInfo.propertiesName = $('#editName').val()
      self.updateRecorder()
    })

    $('#saveValBtn').click(function () {
      self.currentRecordInfo.value = $('#editVal').val()
      self.updateRecorder()
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
  }
}
