/**
 * collect/collector.js — Content 侧采集核心
 *
 * 职责：
 *   - 根据后台会话状态启动/停止采集。
 *   - 监听页面 click/change 事件，生成原始动作并上报 background。
 *   - 复用现有工具函数（SmartSelector、elementBusinessName、ElementGrouper 等）。
 *   - 排除采集标记 UI 自身产生的事件。
 *
 * 设计原则：
 *   - 不依赖 Recorder/EventMonitor 的 popup 上报通路，避免污染录制功能。
 *   - 仅采集“测试人员操作了的有效元素”。
 */

const Collector = {
  _collecting: false,
  _sessionId: null,
  _doc: null,
  _changeHandler: null,
  _clickHandler: null,
  _frameUrl: location.href,
  _lastAction: null,

  async init() {
    // record 模式下完全不启用采集逻辑，避免任何副作用。
    if (typeof APP_MODE !== 'undefined' && APP_MODE === 'record') {
      console.log('[Collector] record mode, skip collect init')
      return
    }

    console.log('[Collector] init, mode=', APP_MODE, 'frame=', window === window.top ? 'top' : 'iframe', location.href)

    // 页面加载后询问后台：当前标签页是否处于采集会话中。
    this.queryAndStart()

    // 页面卸载前 flush（主要为了清理可能的定时器，动作本身已即时上报）。
    window.addEventListener('pagehide', () => {
      this.stopLocal()
    }, { once: true })
  },

  async queryAndStart() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'collectInit' })
      console.log('[Collector] collectInit response', resp)
      if (resp && resp.active && resp.sessionId) {
        this.start(resp.sessionId)
      }
    } catch (e) {
      console.warn('[Collector] collectInit failed', e)
    }
  },

  start(sessionId) {
    if (this._collecting) {
      console.log('[Collector] already collecting')
      return
    }
    console.log('[Collector] start', sessionId)
    this._collecting = true
    this._sessionId = sessionId
    this._doc = document
    this.attachListeners()
    // 标记 UI 与页面配置只在顶层页面处理，避免在每个 iframe 里都出现。
    if (window === window.top) {
      if (typeof CollectOverlay !== 'undefined') {
        console.log('[Collector] show overlay')
        CollectOverlay.show()
      }
      this.reportPageConfig()
      this.reportPagetagName()
    }
  },

  stopLocal() {
    if (!this._collecting) return
    this.detachListeners()
    this._collecting = false
    if (window === window.top && typeof CollectOverlay !== 'undefined') {
      CollectOverlay.hide()
    }
  },

  /**
   * 上报开始采集页面中的「天元相关配置」弹窗内容（每个会话只上报一次，由后台首次写入为准）。
   * 弹窗可能晚于页面渲染出现，短轮询等待（最长约 3 秒）；页面跳转让位前若仍未抓到则按当前结果收尾。
   */
  reportPageConfig() {
    const maxAttempts = 5
    const intervalMs = 300
    let attempts = 0
    let sent = false

    const finalize = (config) => {
      if (sent) return
      sent = true
      console.log('[Collector] pageConfig finalize', config)
      chrome.runtime.sendMessage({ type: 'collectPageConfig', pageConfig: config }).catch(() => {})
    }

    const poll = () => {
      const config = this.scanPageConfig()
      if (Object.keys(config).length > 0) {
        finalize(config)
        return
      }
      attempts++
      if (attempts >= maxAttempts) {
        finalize({})
        return
      }
      setTimeout(poll, intervalMs)
    }
    poll()

    // 页面跳转前若还没上报，立即按当前扫描结果收尾，
    // 避免把新页面的配置当成开始页的 pageConfig。
    window.addEventListener('pagehide', () => {
      finalize(this.scanPageConfig())
    }, { once: true })
  },

  /**
   * 上报采集开始时顶部 tags-view 中激活页签的名称（pagetagName）。
   */
  reportPagetagName() {
    const name = this.scanPagetagName()
    if (!name) return
    console.log('[Collector] pagetagName', name)
    chrome.runtime.sendMessage({ type: 'collectPagetagName', pagetagName: name }).catch(() => {})
  },

  /**
   * 扫描 tags-view 中当前激活页签的显示文本。
   */
  scanPagetagName() {
    const activeItem = document.querySelector('.tags-view-wrapper > li.is-active')
    if (!activeItem) return ''
    const span = activeItem.querySelector('span')
    return span ? (span.innerText || span.textContent || '').trim() : ''
  },

  /**
   * 扫描「天元相关配置」弹窗（默认隐藏，DOM 中已存在），解析为键值对象。
   * 未找到弹窗时返回空对象。
   */
  scanPageConfig() {
    const dialog = this.findTianyuanDialog()
    if (!dialog) return {}

    const config = {}
    const body = dialog.querySelector('.el-dialog__body') || dialog
    const paragraphs = body.querySelectorAll('p')
    paragraphs.forEach(p => {
      const spans = p.querySelectorAll('span')
      if (spans.length === 0) return
      const label = (spans[0].innerText || spans[0].textContent || '').trim()
      const key = label.replace(/[：:]\s*$/, '').trim()
      if (!key) return
      let value = ''
      if (spans.length > 1) {
        value = Array.prototype.slice.call(spans, 1)
          .map(s => (s.innerText || s.textContent || '').trim())
          .join('')
          .trim()
      }
      config[key] = value
    })
    return config
  },

  findTianyuanDialog() {
    const dialogs = document.querySelectorAll('.el-dialog, [role="dialog"]')
    for (const dialog of dialogs) {
      const label = dialog.getAttribute('aria-label') || ''
      if (label.includes('天元相关配置')) return dialog
      const title = dialog.querySelector('.el-dialog__title, .el-dialog__header')
      const titleText = title ? (title.innerText || title.textContent || '') : ''
      if (titleText.includes('天元相关配置')) return dialog
    }
    return null
  },

  attachListeners() {
    if (!this._doc) return
    this._changeHandler = event => this.handleChange(event)
    this._clickHandler = event => this.handleClick(event)
    this._doc.addEventListener('change', this._changeHandler, { capture: true })
    this._doc.addEventListener('click', this._clickHandler, { capture: true })
  },

  detachListeners() {
    if (!this._doc) return
    if (this._changeHandler) {
      this._doc.removeEventListener('change', this._changeHandler, { capture: true })
    }
    if (this._clickHandler) {
      this._doc.removeEventListener('click', this._clickHandler, { capture: true })
    }
    this._changeHandler = null
    this._clickHandler = null
  },

  isEventFromOverlay(event) {
    if (typeof CollectOverlay === 'undefined') return false
    const host = CollectOverlay.hostElement
    if (!host) return false
    const path = event.composedPath ? event.composedPath() : []
    return path.some(el => el === host)
  },

  shouldIgnoreEvent(event) {
    // 脚本触发、扩展自身 UI、非信任事件均忽略。
    if (!event.isTrusted) return true
    if (this.isEventFromOverlay(event)) return true
    return false
  },

  /**
   * 判断元素是否为弹窗/抽屉的包装器或遮罩层。
   * 点击这些区域通常不是用户的有效操作（如点击遮罩但未关闭弹窗），
   * 记录后会把同一弹窗的内容错误地切割到两个分组里。
   */
  isDialogWrapperElement(element) {
    if (!element || typeof element.matches !== 'function') return false
    return element.matches(
      '.el-dialog__wrapper, .el-drawer__wrapper, .v-modal, .modal-backdrop, ' +
      '.el-message-box__wrapper, [class*="dialog__wrapper"], [class*="drawer__wrapper"]'
    )
  },

  handleChange(event) {
    if (!this._collecting) return
    if (this.shouldIgnoreEvent(event)) return

    const { target } = event
    if (TreeSelectHandler && TreeSelectHandler.shouldIgnoreTreeChange && TreeSelectHandler.shouldIgnoreTreeChange(target)) {
      return
    }

    // Element UI 下拉框：选项点击已由 click 处理器合并记录，change 事件在此去重，避免重复。
    if (target.closest('.el-select')) {
      const now = Date.now()
      if (this._lastAction && this._lastAction.eventTypeValue === 'select' && now - this._lastAction.timestamp < 1000) {
        return
      }
    }

    const dateEditor = target.closest('.el-date-editor, .tsscdatepicker')
    if (dateEditor) {
      this.recordAction(target, 'date', '日期选择')
      return
    }

    const isRadio = target.tagName === 'INPUT' && target.type === 'radio'
    const isSelection = target.tagName === 'SELECT' ||
      (target.tagName === 'INPUT' && target.type === 'checkbox')
    const eventType = isRadio ? 'radio' : (isSelection ? 'select' : 'input')
    const eventName = isRadio ? '单选' : (isSelection ? '下拉框选择' : '输入')
    this.recordAction(target, eventType, eventName)
  },

  handleClick(event) {
    if (!this._collecting) return
    if (this.shouldIgnoreEvent(event)) return

    const { target } = event

    // 忽略弹窗包装器/遮罩层的点击，避免把弹窗内容切到两个分组。
    if (this.isDialogWrapperElement(target)) return

    if (typeof TreeSelectHandler !== 'undefined') {
      TreeSelectHandler.clearExpiredTreeSelect && TreeSelectHandler.clearExpiredTreeSelect()
      const treeNodeEle = TreeSelectHandler.getTreeNodeElement && TreeSelectHandler.getTreeNodeElement(target)
      if (treeNodeEle) {
        // 采集模式不调用 TreeSelectHandler.handleTreeNodeClick，避免其向 popup 发 addActionData。
        this.recordAction(treeNodeEle, 'click', '点击')
        return
      }
      if (TreeSelectHandler.pendingTreeSelect && TreeSelectHandler.isInTreePopup && TreeSelectHandler.isInTreePopup(target)) {
        return
      }
    }

    // Element UI 日期选择器面板内的点击不单独记录，由 change 处理。
    if (target.closest('.el-picker-panel, .el-date-picker, .el-date-range-picker, .el-time-panel')) {
      return
    }

    const selectEle = target.closest('.el-select')
    const selectOptionEle = target.closest('.el-select-dropdown__item')
    const dateIpt = target.closest('.el-date-editor, .tsscdatepicker')

    if (selectEle) {
      const input = selectEle.querySelector('input')
      if (input) {
        this.recordAction(input, 'select', '下拉框xpath选择')
      }
      return
    }

    if (selectOptionEle) {
      // 与录制工具一致：把 select 点击 + 选项点击合并为一条动作。
      if (this.mergeSelectOption(selectOptionEle)) return
      this.recordAction(selectOptionEle, 'selectOption', '下拉框xpath选择')
      return
    }

    if (dateIpt) {
      const input = dateIpt.querySelector('input:not([type="hidden"])') || target
      this.recordAction(input, 'date', '日期选择')
      return
    }

    // 普通按钮/链接。
    const clickAction = this.getClickActionElement(target)
    if (clickAction) {
      this.recordAction(clickAction, 'click', '点击')
      return
    }

    // 表格内自定义单选/多选。
    const tableFormControl = target.closest('td, th') && target.closest('.el-radio, .el-checkbox')
    if (tableFormControl) {
      const inputType = tableFormControl.classList.contains('el-radio') ? 'radio' : 'checkbox'
      const formInput = tableFormControl.querySelector('input[type="' + inputType + '"]') || tableFormControl
      const eventType = inputType === 'radio' ? 'radio' : 'select'
      const eventName = inputType === 'radio' ? '单选' : '下拉框选择'
      const objectValue = inputType === 'radio' ? true : !formInput.checked
      this.recordAction(formInput, eventType, eventName, objectValue)
      return
    }

    if (target.closest('.el-radio, .el-checkbox')) {
      return
    }

    // 树形选择触发框。
    if (typeof TreeSelectHandler !== 'undefined' && TreeSelectHandler.getTreeTriggerInput) {
      const treeInputEle = TreeSelectHandler.getTreeTriggerInput(target)
      if (treeInputEle) {
        this.recordAction(treeInputEle, 'click', '点击')
        return
      }
    }

    // 表格内普通操作按钮。
    if (typeof EventMonitor !== 'undefined' && EventMonitor.getTableActionElement) {
      const tableAction = EventMonitor.getTableActionElement(target)
      if (tableAction) {
        this.recordAction(tableAction, 'click', '点击')
        return
      }
    }

    // 空白区域点击过滤。
    if (typeof EventMonitor !== 'undefined' && EventMonitor.isInvalidBlankClick) {
      if (EventMonitor.isInvalidBlankClick(target)) return
    }

    if (!target.matches || target.matches('input, textarea')) return
    this.recordAction(target, 'click', '点击')
  },

  getClickActionElement(element) {
    if (!element || typeof element.closest !== 'function') return null
    return element.closest(
      'button, a, input[type="button"], input[type="submit"], input[type="reset"], ' +
      '[role="button"], [role="link"], [role="tab"], .el-button'
    )
  },

  extractOptions(element) {
    const dropdown = this.findSelectDropdown(element)
    if (!dropdown) return []
    return this.readDropdownOptions(dropdown)
  },

  /**
   * 找到与本次操作关联的下拉面板，避免把页面上其它下拉框的选项也收集进来。
   * 1. 选项元素：直接取它所在的下拉面板。
   * 2. 下拉框输入元素：取页面中当前可见的那个下拉面板（同一时刻通常只有一个）。
   */
  findSelectDropdown(element) {
    if (element && typeof element.closest === 'function') {
      const inner = element.closest('.el-select-dropdown')
      if (inner) return inner
    }
    return this.findVisibleDropdown()
  },

  findVisibleDropdown() {
    const dropdowns = document.querySelectorAll('.el-select-dropdown')
    for (const dropdown of dropdowns) {
      if (this.isElementVisible(dropdown)) return dropdown
    }
    return null
  },

  isElementVisible(el) {
    if (!el || !el.isConnected) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  },

  readDropdownOptions(dropdown) {
    const result = []
    const items = dropdown.querySelectorAll('.el-select-dropdown__item')
    items.forEach(item => {
      const text = (item.innerText || item.textContent || '').trim()
      if (text && !result.includes(text)) result.push(text)
    })
    return result
  },

  getInputValue(element) {
    // 优先复用 Recorder 的取值逻辑（兼容 Vue/React/Element UI）。
    if (typeof Recorder !== 'undefined' && Recorder.getInputValue) {
      return Recorder.getInputValue(element)
    }
    if (!element) return ''
    const tagName = element.tagName
    if (tagName === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) {
      return !!element.checked
    }
    if (element.value || element.value === 0) return String(element.value)
    return ''
  },

  recordAction(element, eventType, eventTypeName, objectValueOverride) {
    if (!element || !this._collecting) return

    const xpath = this.getXPath(element)
    if (!xpath) return

    const labelChName = typeof getChineseLabelByElement === 'function'
      ? getChineseLabelByElement(element)
      : ''
    const realLabel = typeof getRealLabelByElement === 'function'
      ? (getRealLabelByElement(element) || '')
      : ''

    let group = []
    try {
      if (typeof ElementGrouper !== 'undefined' && ElementGrouper.getGroupPath) {
        group = ElementGrouper.getGroupPath(element)
      }
    } catch (e) {}

    const objectValue = objectValueOverride !== undefined
      ? objectValueOverride
      : this.getInputValue(element)

    // 下拉框选择补充下拉选项列表。
    const isSelectAction = eventType === 'select' || eventType === 'select:click' || eventType === 'selectOption'
    const options = isSelectAction ? this.extractOptions(element) : []

    const action = {
      clientId: this.getClientId(),
      timestamp: Date.now(),
      eventTypeValue: eventType,
      eventTypeName: eventTypeName,
      xpath: xpath,
      mothed: 'By.XPATH',
      transcationType: 'playwright',
      tagName: element.tagName ? element.tagName.toLowerCase() : '',
      propertiesName: typeof labelChName === 'string'
        ? labelChName.replace(/[^\w\d\u4e00-\u9fa5]/g, '')
        : '',
      realLabel: realLabel,
      group: group,
      objectValue: objectValue,
      options: options,
      attributes: this.extractAttributes(element)
    }

    // 即时上报 background，页面跳转也不会丢。
    chrome.runtime.sendMessage({
      type: 'collectAction',
      action: action
    }).catch(() => {})

    this._lastAction = action
  },

  /**
   * 合并下拉框：把紧随其后的选项点击合并到前面的 select 动作里。
   * 与录制工具行为一致，返回 true 表示已合并、不再单独记录 selectOption。
   */
  mergeSelectOption(optionElement) {
    const last = this._lastAction
    if (!last) return false
    if (last.eventTypeValue !== 'select' && last.eventTypeValue !== 'select:click') return false

    const optionText = (optionElement.innerText || optionElement.textContent || '').trim()
    if (!optionText) return false

    // 支持多选：已选值不做覆盖，改为逗号累加去重。
    const current = last.objectValue ? String(last.objectValue) : ''
    const values = current ? current.split(',') : []
    if (!values.includes(optionText)) values.push(optionText)
    const mergedValue = values.join(',')

    last.objectValue = mergedValue

    // 合并下拉选项列表：面板打开期间通常可见。
    if (!last.options || last.options.length === 0) {
      const opts = this.extractOptions(optionElement)
      if (opts && opts.length > 0) last.options = opts
    }

    chrome.runtime.sendMessage({
      type: 'collectActionUpdate',
      clientId: last.clientId,
      updates: last.options && last.options.length > 0
        ? { objectValue: mergedValue, options: last.options }
        : { objectValue: mergedValue }
    }).catch(() => {})
    return true
  },

  getClientId() {
    if (typeof Utils !== 'undefined' && Utils.uuid) return Utils.uuid()
    return 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
  },

  getPageUrl() {
    // pageUrl 为顶层页面地址；iframe 内跨域无法访问时回退为当前 frame 地址。
    if (window === window.top) return this._frameUrl
    try {
      if (window.top && window.top.location) return window.top.location.href
    } catch (e) {}
    return this._frameUrl
  },

  stripQuery(url) {
    if (!url || typeof url !== 'string') return url || ''
    const idx = url.indexOf('?')
    return idx === -1 ? url : url.slice(0, idx)
  },

  getXPath(element) {
    try {
      if (typeof SmartSelector !== 'undefined' && SmartSelector.prototype.getSelector) {
        return new SmartSelector(element).getSelector()
      }
    } catch (e) {}
    try {
      if (typeof XPathHelper !== 'undefined' && XPathHelper.getElementXPath) {
        return XPathHelper.getElementXPath(element)
      }
    } catch (e) {}
    return ''
  },

  extractAttributes(element) {
    const attrs = {}
    const allowlist = (APP_DEFAULT_CONFIG && APP_DEFAULT_CONFIG.collect && APP_DEFAULT_CONFIG.collect.attributesAllowlist)
      || ['id', 'class', 'name', 'type', 'value', 'placeholder', 'title', 'role', 'aria-label', 'data-*']
    if (!element || !element.attributes) return attrs

    for (const { name, value } of Array.from(element.attributes)) {
      if (allowlist.includes(name)) {
        attrs[name] = value
        continue
      }
      for (const pattern of allowlist) {
        if (pattern.endsWith('-*') && name.startsWith(pattern.slice(0, -1))) {
          attrs[name] = value
          break
        }
      }
    }
    return attrs
  }
}

// 监听后台的采集开始/停止广播。放在顶层确保脚本一注入就注册，避免错过 collectStarted。
if (typeof APP_MODE === 'undefined' || APP_MODE !== 'record') {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'collectStarted') {
      console.log('[Collector] receive collectStarted', request.sessionId)
      Collector.start(request.sessionId)
      sendResponse({ started: true })
      return false
    }
      if (request.type === 'collectStopped') {
        console.log('[Collector] receive collectStopped')
        Collector.stopLocal()
        sendResponse({ stopped: true })
        return false
      }
      if (request.type === 'collectPing') {
        sendResponse({ ok: true, collecting: Collector._collecting })
        return false
      }
      return false
    })

  // DOM 就绪后初始化；若已就绪则立即执行。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Collector.init())
  } else {
    Collector.init()
  }
}
