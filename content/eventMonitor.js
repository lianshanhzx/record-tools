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
   * 注册页面 change 和 click 事件监听（捕获阶段）。
   * 调用位置：content.js → startRecordEvent / continueRecordEvent
   */
  listener(doc) {
    if (this._listening) return

    this._docu = doc
    this._listening = true

    this._changeHandler = event => {
      const { target } = event;
      if (TreeSelectHandler.shouldIgnoreTreeChange(target)) {
        return
      }
      const dateEditor = target.closest('.el-date-editor, .tsscdatepicker')
      if (dateEditor) {
        target.command = 'fill_date_field'
        target.commandCnStr = '日期选择'
        Recorder.setAttributeAction(target)
      } else {
        const isSelection = target.tagName === 'SELECT' ||
          (target.tagName === 'INPUT' && (target.type === 'radio' || target.type === 'checkbox'))
        target.command = isSelection ? 'select' : 'input'
        target.commandCnStr = isSelection ? '选择' : '输入'
        Recorder.setAttributeAction(target)
      }
    }

    this._clickHandler = event => {
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
        dateInput.command = 'fill_date_field'
        dateInput.commandCnStr = '日期选择'
        const action = Recorder.setAttributeAction(dateInput)
        if (action) {
          Recorder.monitorDateInput(dateInput, action)
        }
      } else {
        const treeInputEle = TreeSelectHandler.getTreeTriggerInput(target)
        if (treeInputEle) {
          treeInputEle.command = 'click'
          treeInputEle.commandCnStr = '点击'
          const action = Recorder.setAttributeAction(treeInputEle);
          TreeSelectHandler.startTreeSelectCandidate(treeInputEle, action)
        } else if (!target.matches('input, textarea')) {
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
