/**
 * eventMonitor.js — 事件监听模块
 * 负责在目标页面中注册 change / click 事件监听，
 * 将用户交互分发到 Recorder 和 TreeSelectHandler 进行处理。
 *
 * 依赖：
 *   - Recorder (content/recorder.js)
 *   - TreeSelectHandler (content/treeSelectHandler.js)
 */

const EventMonitor = {
  _docu: null,
  _listening: false,
  _changeHandler: null,
  _clickHandler: null,

  /**
   * 判断一次点击是否属于"无效空白区域"。
   * 同时满足以下条件时视为无效空白点击并忽略：
   *   1. 不是交互元素且不在交互元素内部
   *   2. 没有可见文本内容
   *   3. 没有子元素
   *   4. 没有原生 onclick 属性
   *   5. 鼠标样式不是 pointer
   *
   * 调用位置：eventMonitor.js → click 事件处理中的普通点击分支
   */
  isInvalidBlankClick(element) {
    if (!element) return false

    const interactiveSelector =
      'button, a, input, textarea, select, label, details, summary, ' +
      '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [onclick]'
    if (element.closest(interactiveSelector)) {
      return false
    }

    const hasVisibleText = !!(element.innerText || '').trim()
    const hasChildren = !!(element.children && element.children.length)
    if (hasVisibleText || hasChildren || element.onclick) {
      return false
    }

    try {
      if (window.getComputedStyle(element).cursor === 'pointer') {
        return false
      }
    } catch (e) {
      return false
    }

    return true
  },

  /**
   * 找到表格单元格内可人工录制的操作元素。
   * 表格仍由自动扫描器整体排除；这里仅处理用户实际点击的表单控件和按钮。
   * 很多表格操作使用 span/div 包裹图标，实际 click target 往往是 svg/i，
   * 这类节点自身没有文本、子元素或 onclick，不能直接用作录制目标。
   */
  getTableActionElement(element) {
    if (!element || typeof element.closest !== 'function') return null
    const cell = element.closest('td, th')
    if (!cell) return null

    let current = element
    while (current && current !== cell) {
      if (current.matches && current.matches(
        '[onclick], [role="button"], [role="link"], [role="radio"], [role="checkbox"], [tabindex], button, a, .el-radio, .el-checkbox'
      )) {
        return current
      }
      current = current.parentElement
    }

    current = element
    while (current && current !== cell) {
      const className = typeof current.className === 'string' ? current.className : ''
      if (current.hasAttribute && (
        current.hasAttribute('title') || current.hasAttribute('aria-label') ||
        current.hasAttribute('data-action') || current.hasAttribute('data-command') ||
        /(?:action|operate|operation|btn|button|edit|delete|remove|view|detail|link)/i.test(className)
      )) {
        return current
      }
      try {
        const style = window.getComputedStyle(current)
        if (style.cursor === 'pointer' && (
          current !== element || (current.style && current.style.cursor === 'pointer')
        )) return current
      } catch (e) {}
      current = current.parentElement
    }

    return null
  },

  /**
   * 将按钮内部的文字、图标等点击目标归一到实际可操作的按钮根节点。
   * 表单中的 button 也应作为点击操作，而不是按其父级表单控件处理。
   */
  getClickActionElement(element) {
    if (!element || typeof element.closest !== 'function') return null
    return element.closest(
      'button, a, input[type="button"], input[type="submit"], input[type="reset"], ' +
      '[role="button"], [role="link"], [role="tab"], .el-button'
    )
  },

  /**
   * 注册页面 change 和 click 事件监听（捕获阶段）。
   * 调用位置：content.js → startRecordEvent / continueRecordEvent
   */
  listener(doc) {
    if (this._listening) return

    this._docu = doc
    this._listening = true

    this._changeHandler = event => {
      // 自动填表派发的 change 事件不属于用户录制操作。
      if (!event.isTrusted) return
      const { target } = event;
      if (TreeSelectHandler.shouldIgnoreTreeChange(target)) {
        return
      }
      const dateEditor = target.closest('.el-date-editor, .tsscdatepicker')
      if (dateEditor) {
        target.command = 'date'
        target.commandCnStr = '日期选择'
        Recorder.setAttributeAction(target)
      } else {
        const isRadio = target.tagName === 'INPUT' && target.type === 'radio'
        const isSelection = target.tagName === 'SELECT' ||
          (target.tagName === 'INPUT' && target.type === 'checkbox')
        target.command = isRadio ? 'radio' : (isSelection ? 'select' : 'input')
        target.commandCnStr = isRadio ? '单选' : (isSelection ? '下拉框选择' : '输入')
        Recorder.setAttributeAction(target)
      }
    }

    this._clickHandler = event => {
      // 自动填表及组件内部派发的 click 事件不应被记录为人工操作。
      if (!event.isTrusted) return
      const { target } = event;
      TreeSelectHandler.clearExpiredTreeSelect()

      const treeNodeEle = TreeSelectHandler.getTreeNodeElement(target)
      if (treeNodeEle && TreeSelectHandler.handleTreeNodeClick(treeNodeEle)) {
        return
      }
      if (TreeSelectHandler.pendingTreeSelect && TreeSelectHandler.isInTreePopup(target)) {
        return
      }

      const datePickerPanel = target.closest('.el-picker-panel, .el-date-picker, .el-date-range-picker, .el-time-panel')
      if (datePickerPanel) {
        return
      }

      const selectEle = target.closest(".el-select");
      const selectOptionEle = target.closest(".el-select-dropdown__item");
      const dateIpt = target.closest(".el-date-editor, .tsscdatepicker");
      if (selectEle) {
        const selectInputEle = selectEle.querySelector('input')
        if (selectInputEle) {
          selectInputEle.command = 'select'
          selectInputEle.commandCnStr = '下拉框xpath选择'
          Recorder.setAttributeAction(selectInputEle);
        }

      } else if (selectOptionEle) {
        selectOptionEle.command = 'selectOption'
        selectOptionEle.commandCnStr = '下拉框xpath选择'
        Recorder.setAttributeAction(selectOptionEle);

      } else if (dateIpt) {
        const dateInput = dateIpt.querySelector('input:not([type="hidden"])') || target
        dateInput.command = 'date'
        dateInput.commandCnStr = '日期选择'
        const action = Recorder.setAttributeAction(dateInput)
        if (action) {
          Recorder.monitorDateInput(dateInput, action)
        }
      } else {
        const clickAction = this.getClickActionElement(target)
        if (clickAction) {
          clickAction.command = 'click'
          clickAction.commandCnStr = '点击'
          Recorder.setAttributeAction(clickAction)
          return
        }

        // Element UI 单选/多选通常由内部 input 触发 change；表格内的自定义单选框
        // 可能只派发组件事件，且 table 会被扫描器排除，因此这里补录外层控件。
        const tableFormControl = target.closest('td, th') && target.closest('.el-radio, .el-checkbox')
        if (tableFormControl) {
          const inputType = tableFormControl.classList.contains('el-radio') ? 'radio' : 'checkbox'
          const formInput = tableFormControl.querySelector('input[type="' + inputType + '"]') || tableFormControl
          formInput.command = inputType === 'radio' ? 'radio' : 'select'
          formInput.commandCnStr = inputType === 'radio' ? '单选' : '下拉框选择'
          Recorder.setAction(formInput, {
            type: 'ATTRIBUTE',
            // 捕获阶段发生在浏览器切换 checked 之前，记录点击后的目标状态。
            objectValue: inputType === 'radio' ? true : !formInput.checked,
            hasRecordedValue: true
          })
          return
        }
        if (target.closest('.el-radio, .el-checkbox')) {
          return
        }
        const treeInputEle = TreeSelectHandler.getTreeTriggerInput(target)
        if (treeInputEle) {
          treeInputEle.command = 'click'
          treeInputEle.commandCnStr = '点击'
          const action = Recorder.setAttributeAction(treeInputEle);
          TreeSelectHandler.startTreeSelectCandidate(treeInputEle, action)
        } else if (!target.matches('input, textarea')) {
          const tableAction = this.getTableActionElement(target)
          if (tableAction) {
            tableAction.command = 'click'
            tableAction.commandCnStr = '点击'
            Recorder.setAttributeAction(tableAction)
            return
          }
          if (this.isInvalidBlankClick(target)) {
            return
          }
          target.command = 'click'
          target.commandCnStr = '点击'
          Recorder.setAttributeAction(target);
        }
      }
    }

    this._docu.addEventListener("change", this._changeHandler, { capture: true })
    this._docu.addEventListener("click", this._clickHandler, { capture: true })
  },

  /**
   * 移除 change / click 事件监听。
   * 调用位置：content/messageHandler.js → popupClosed 消息处理
   */
  unlistener() {
    if (!this._listening) return
    if (this._docu) {
      this._docu.removeEventListener("change", this._changeHandler, { capture: true })
      this._docu.removeEventListener("click", this._clickHandler, { capture: true })
    }
    this._docu = null
    this._changeHandler = null
    this._clickHandler = null
    this._listening = false
  }
}
