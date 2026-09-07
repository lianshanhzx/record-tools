/* 当前页面回放验证器。运行时状态只保存在 content script，不修改 popup 或录制数据。 */
const PageReplayer = {
  taskId: '',
  cancelled: false,
  contextId: '',
  preparedElements: new WeakSet(),
  preparedTargets: new Set(),
  snapshots: new Map(),
  highlightElement: null,
  highlightTimer: null,
  styleElement: null,

  send(type, data) {
    chrome.runtime.sendMessage(Object.assign({ type: type, taskId: this.taskId }, data || {}))
  },

  wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)) },

  find(xpath) {
    try {
      return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
    } catch (error) {
      throw new Error('XPath 语法错误: ' + error.message)
    }
  },

  async waitForElement(xpath, timeout) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (this.cancelled) throw new Error('回放已取消')
      const element = this.find(xpath)
      if (element && element.isConnected) {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') return element
      }
      await this.wait(100)
    }
    throw new Error('未找到可见元素: ' + xpath)
  },

  getContextId(element) {
    const dialog = element && element.closest('[role="dialog"], .el-dialog, .el-drawer, .el-popover')
    const route = window.location.href
    return route + '|' + (dialog ? this.getElementPath(dialog) : 'document')
  },

  getElementPath(element) {
    if (!element) return ''
    const parts = []
    let current = element
    while (current && current !== document.body && parts.length < 6) {
      let index = 1
      let sibling = current
      while ((sibling = sibling.previousElementSibling)) index++
      parts.unshift(current.tagName + ':' + index)
      current = current.parentElement
    }
    return parts.join('/')
  },

  ensureContext(element) {
    const next = this.getContextId(element)
    if (next !== this.contextId) {
      this.contextId = next
      this.preparedElements = new WeakSet()
      this.preparedTargets = new Set()
      this.snapshots = new Map()
    }
  },

  ensureStyle() {
    if (this.styleElement && this.styleElement.isConnected) return
    const style = document.createElement('style')
    style.id = '__ty_record_replay_style'
    style.textContent = '[data-ty-replay-active="1"] { outline: 3px solid #1a73e8 !important; outline-offset: 2px !important; background-color: rgba(26, 115, 232, .12) !important; transition: outline-color .15s, background-color .15s; } [data-ty-replay-result="success"] { outline-color: #1e8e3e !important; background-color: rgba(30, 142, 62, .16) !important; } [data-ty-replay-result="failed"] { outline-color: #d93025 !important; background-color: rgba(217, 48, 37, .16) !important; }'
    ;(document.head || document.documentElement).appendChild(style)
    this.styleElement = style
  },

  highlight(element, result) {
    this.ensureStyle()
    if (this.highlightElement && this.highlightElement !== element) {
      this.highlightElement.removeAttribute('data-ty-replay-active')
      this.highlightElement.removeAttribute('data-ty-replay-result')
    }
    this.highlightElement = element
    element.setAttribute('data-ty-replay-active', '1')
    if (result) element.setAttribute('data-ty-replay-result', result)
    clearTimeout(this.highlightTimer)
    this.highlightTimer = setTimeout(() => {
      if (this.highlightElement === element) {
        element.removeAttribute('data-ty-replay-active')
        element.removeAttribute('data-ty-replay-result')
      }
    }, result === 'failed' ? 1800 : 700)
  },

  setValue(element, value) {
    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    if (descriptor && descriptor.set) descriptor.set.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  },

  async setDateValue(element, value) {
    // Date pickers keep their real value in the component model. Reuse the
    // existing date implementation when it is available, then verify the DOM.
    if (typeof AutoFormFill !== 'undefined' && typeof AutoFormFill.fillDateField === 'function') {
      const result = await AutoFormFill.fillDateField(element, String(value || ''))
      if (result === 'date-update-failed') throw new Error('日期组件未接受录制值: ' + value)
      return result
    }
    this.setValue(element, value)
    element.setAttribute('value', value || '')
    element.dispatchEvent(new Event('blur', { bubbles: true }))
    return 'ok-date-dom'
  },

  readValue(element) {
    if (element.type === 'checkbox' || element.type === 'radio') return !!element.checked
    if (element.tagName === 'SELECT') {
      const option = element.options[element.selectedIndex]
      return option ? (option.value || option.textContent.trim()) : ''
    }
    const select = element.closest('.el-select')
    if (select) {
      const tags = Array.from(select.querySelectorAll('.el-select__tags-text')).map(item => item.textContent.trim()).filter(Boolean)
      if (tags.length > 0) return tags.join(',')
      const selected = select.querySelector('.el-select__selected-item, .el-select__selection-text')
      if (selected && selected.textContent.trim()) return selected.textContent.trim()
    }
    return element.value == null ? '' : String(element.value)
  },

  snapshot(element) {
    if (this.snapshots.has(element)) return
    this.snapshots.set(element, {
      value: element.value,
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      selectedIndex: element.tagName === 'SELECT' ? element.selectedIndex : undefined
    })
  },

  clearElement(element) {
    this.snapshot(element)
    if (element.type === 'radio') {
      if (element.name) {
        const scope = element.form || element.ownerDocument
        scope.querySelectorAll('input[type="radio"][name="' + CSS.escape(element.name) + '"]').forEach(item => {
          if (item.checked) item.checked = false
        })
      } else {
        element.checked = false
      }
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    if (element.type === 'checkbox') {
      if (element.checked) element.click()
      return
    }
    const clearButton = element.closest('.el-select, .el-date-editor, .tsscdatepicker')?.querySelector('.el-input__clear, .el-select__clear')
    if (clearButton && clearButton.getBoundingClientRect().width > 0) {
      clearButton.click()
      return
    }
    if (element.tagName === 'SELECT') {
      element.selectedIndex = -1
      element.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      this.setValue(element, '')
    }
  },

  async prepareElement(element, action, target, timeout) {
    if (!['input', 'date', 'select:click', 'select:tree', 'radio'].includes(action)) return element
    this.ensureContext(element)
    const alreadyPrepared = this.preparedElements.has(element) || this.preparedTargets.has(target)
    if (!alreadyPrepared) {
      this.clearElement(element)
      // Clearing can trigger a framework render and replace the input node.
      this.preparedTargets.add(target)
      this.preparedElements.add(element)
      await this.wait(action === 'select:click' || action === 'date' ? 250 : 180)
      const refreshed = await this.waitForElement(target, timeout)
      this.ensureContext(refreshed)
      return refreshed
    }
    return element
  },

  async select(record, element, timeout) {
    if (element.type === 'checkbox') {
      const expected = typeof record.objectValue === 'boolean' ? record.objectValue : record.checked !== false
      if (element.checked !== expected) element.click()
      return
    }
    const value = String(record.objectValue || '').trim()
    if (element.tagName === 'SELECT') {
      const option = Array.from(element.options).find(item => item.value === String(record.objectValue) || item.textContent.trim() === value)
      if (!option) throw new Error('未找到下拉选项: ' + value)
      element.value = option.value
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    element.click()
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (this.cancelled) throw new Error('回放已取消')
      const candidates = Array.from(document.querySelectorAll('.el-select-dropdown__item, [role="option"]'))
        .filter(item => {
          const rect = item.getBoundingClientRect()
          const style = getComputedStyle(item)
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
            !item.closest('[aria-hidden="true"]') && !item.classList.contains('is-disabled') &&
            item.getAttribute('aria-disabled') !== 'true'
        })
      const option = candidates.find(item => {
        const text = item.textContent.trim()
        return text === value || item.getAttribute('data-value') === String(record.objectValue) || item.getAttribute('value') === String(record.objectValue)
      })
      if (option) {
        const selectedText = option.textContent.trim()
        option.scrollIntoView({ block: 'nearest' })
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
        option.click()
        await this.wait(350)
        return { selectedText: selectedText }
      }
      await this.wait(100)
    }
    throw new Error('未找到下拉选项: ' + value)
  },

  expectedValue(record, element, action) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return typeof record.objectValue === 'boolean' ? record.objectValue : record.checked !== false
    }
    if (action === 'select:click' && element.tagName === 'SELECT') return String(record.objectValue || '')
    return String(record.objectValue || '')
  },

  valuesEqual(actual, expected, element) {
    if (typeof expected === 'boolean') return actual === expected
    if (element.tagName === 'SELECT') {
      const option = element.options[element.selectedIndex]
      return actual === expected || (option && option.textContent.trim() === expected)
    }
    return String(actual).trim() === String(expected).trim()
  },

  async execute(record, timeout) {
    let element = await this.waitForElement(record.target, timeout)
    element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
    const action = Utils.normalizeEventType(record.eventTypeValue)
    element = await this.prepareElement(element, action, record.target, timeout)
    element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
    this.highlight(element)
    if (typeof element.focus === 'function') element.focus()
    let selectionResult = null
    if (action === 'click') element.click()
    else if (action === 'input' || action === 'date') {
      await this.wait(action === 'date' ? 300 : 220)
      if (action === 'date') await this.setDateValue(element, record.objectValue || '')
      else this.setValue(element, record.objectValue || '')
      await this.wait(action === 'date' ? 450 : 350)
    }
    else if (action === 'radio') { if (!element.checked) element.click() }
    else if (action === 'select:click') selectionResult = await this.select(record, element, timeout)
    else if (action === 'select:tree') throw new Error('暂不支持树形选择回放')
    else throw new Error('不支持的事件类型: ' + record.eventTypeValue)
    if (['input', 'date', 'select:click', 'radio'].includes(action)) {
      let expected = this.expectedValue(record, element, action)
      let actual = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.wait(attempt === 0 ? 120 : 180)
        // Controlled components may replace the node after input/change/click.
        // Always validate and retry against the currently connected node.
        if (!element.isConnected || attempt > 0) element = await this.waitForElement(record.target, timeout)
        if (attempt > 0 && (action === 'input' || action === 'date')) {
          if (typeof element.focus === 'function') element.focus()
          if (action === 'date') await this.setDateValue(element, record.objectValue || '')
          else this.setValue(element, record.objectValue || '')
        }
        expected = this.expectedValue(record, element, action)
        actual = this.readValue(element)
        if (this.valuesEqual(actual, expected, element) || (selectionResult && this.valuesEqual(actual, selectionResult.selectedText, element))) {
          this.highlight(element, 'success')
          return { expectedValue: expected, actualValue: actual, validation: 'passed' }
        }
        if (attempt === 0 && action === 'select:click') {
          // A teleported dropdown can rerender between opening and selecting.
          element = await this.waitForElement(record.target, timeout)
          selectionResult = await this.select(record, element, timeout)
        }
      }
      this.highlight(element, 'failed')
      throw new Error('值校验失败，期望: ' + expected + '，实际: ' + actual)
    }
    return { validation: 'not-applicable' }
  },

  restore() {
    this.snapshots.forEach((snapshot, element) => {
      if (!element.isConnected) return
      if (typeof snapshot.checked === 'boolean') element.checked = snapshot.checked
      else if (element.tagName === 'SELECT') element.selectedIndex = snapshot.selectedIndex
      else this.setValue(element, snapshot.value || '')
    })
  },

  cleanup(options) {
    if (options && options.restoreAfterReplay) this.restore()
    if (this.highlightElement) {
      this.highlightElement.removeAttribute('data-ty-replay-active')
      this.highlightElement.removeAttribute('data-ty-replay-result')
    }
    clearTimeout(this.highlightTimer)
    this.highlightElement = null
    this.snapshots = new Map()
    this.preparedElements = new WeakSet()
    this.preparedTargets = new Set()
    this.contextId = ''
  },

  async start(message) {
    if (this.taskId) this.cancelled = true
    this.taskId = message.taskId
    this.cancelled = false
    const records = Array.isArray(message.records) ? message.records : []
    const options = message.options || {}
    const timeout = Number(options.timeout) || 5000
    const stepDelay = Number(options.stepDelay) || 300
    this.send('replayStarted', { total: records.length })
    for (let index = 0; index < records.length; index++) {
      const record = records[index]
      if (this.cancelled) break
      this.send('replayProgress', { recordKey: record.recordKey, index: index, status: 'running' })
      const startedAt = Date.now()
      try {
        const result = await this.execute(record, timeout)
        this.send('replayProgress', Object.assign({ recordKey: record.recordKey, index: index, status: 'success', duration: Date.now() - startedAt }, result))
      } catch (error) {
        const cancelled = this.cancelled || error.message === '回放已取消'
        this.send('replayProgress', { recordKey: record.recordKey, index: index, status: cancelled ? 'cancelled' : 'failed', validation: 'failed', error: error.message, duration: Date.now() - startedAt })
        if (!cancelled) {
          for (let skipped = index + 1; skipped < records.length; skipped++) this.send('replayProgress', { recordKey: records[skipped].recordKey, index: skipped, status: 'skipped' })
        }
        break
      }
      if (index < records.length - 1) await this.wait(stepDelay)
    }
    const cancelled = this.cancelled
    this.cleanup(options)
    this.send('replayComplete', { status: cancelled ? 'cancelled' : 'finished' })
    this.taskId = ''
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'replayStart') {
    PageReplayer.start(message)
    sendResponse({ started: true })
    return true
  }
  if (message.type === 'replayStop') {
    if (!message.taskId || message.taskId === PageReplayer.taskId) PageReplayer.cancelled = true
    sendResponse({ stopped: true })
    return true
  }
})
