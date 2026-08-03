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
    console.log('---listener---', doc);

    this._docu = doc;

    // ---------------- change 事件监听 ----------------
    this._docu.addEventListener("change", event => {
      const { target } = event;
      // 调用 treeSelectHandler.js → shouldIgnoreTreeChange
      if (TreeSelectHandler.shouldIgnoreTreeChange(target)) {
        return
      }
      const dateEditor = target.closest('.el-date-editor, .tsscdatepicker')
      if (dateEditor) {
        target.command = 'fill_date_field'
        target.commandCnStr = '日期选择'
        // 调用 recorder.js → setAttributeAction
        Recorder.setAttributeAction(target)
      } else {
        target.command = 'input'
        target.commandCnStr = '输入'
        // 调用 recorder.js → setAttributeAction
        Recorder.setAttributeAction(target)
      }
    }, {
      capture: true
    });

    // ---------------- click 事件监听 ----------------
    this._docu.addEventListener("click", event => {
      const { target } = event;
      // 调用 treeSelectHandler.js → clearExpiredTreeSelect
      TreeSelectHandler.clearExpiredTreeSelect()

      // 优先处理树形选择器节点点击
      // 调用 treeSelectHandler.js → getTreeNodeElement / handleTreeNodeClick
      const treeNodeEle = TreeSelectHandler.getTreeNodeElement(target)
      if (treeNodeEle && TreeSelectHandler.handleTreeNodeClick(treeNodeEle)) {
        return
      }
      // 树形选择器弹窗内的点击，仅刷新候选时间戳，不单独记录
      if (TreeSelectHandler.pendingTreeSelect && TreeSelectHandler.isInTreePopup(target)) {
        return
      }

      // 忽略 Element UI 日期选择器面板上的点击
      const datePickerPanel = target.closest('.el-picker-panel, .el-date-picker, .el-date-range-picker, .el-time-panel')
      if (datePickerPanel) {
        return
      }

      const selectEle = target.closest(".el-select");
      const selectOptionEle = target.closest(".el-select-dropdown__item");
      const dateIpt = target.closest(".el-date-editor, .tsscdatepicker");
      if (selectEle) {
        // 点击下拉框触发区域
        const selectInputEle = selectEle.querySelector('input')
        selectInputEle.command = 'select'
        selectInputEle.commandCnStr = '下拉框xpath选择'
        // 调用 recorder.js → setAttributeAction
        Recorder.setAttributeAction(selectInputEle);

      } else if (selectOptionEle) {
        // 点击下拉选项
        selectOptionEle.command = 'selectOption'
        selectOptionEle.commandCnStr = '下拉框xpath选择'
        // 调用 recorder.js → setAttributeAction
        Recorder.setAttributeAction(selectOptionEle);

      } else if (dateIpt) {
        // 点击日期选择器输入框
        const dateInput = dateIpt.querySelector('input:not([type="hidden"])') || target
        dateInput.command = 'fill_date_field'
        dateInput.commandCnStr = '日期选择'
        // 调用 recorder.js → setAttributeAction / monitorDateInput
        const action = Recorder.setAttributeAction(dateInput)
        if (action) {
          Recorder.monitorDateInput(dateInput, action)
        }
      } else {
        // 树形选择器触发 input
        // 调用 treeSelectHandler.js → getTreeTriggerInput
        const treeInputEle = TreeSelectHandler.getTreeTriggerInput(target)
        if (treeInputEle) {
          treeInputEle.command = 'click'
          treeInputEle.commandCnStr = '点击'
          // 调用 recorder.js → setAttributeAction
          const action = Recorder.setAttributeAction(treeInputEle);
          // 调用 treeSelectHandler.js → startTreeSelectCandidate
          TreeSelectHandler.startTreeSelectCandidate(treeInputEle, action)
        } else if (!target.matches('input, textarea')) {
          // 过滤空白区域无效点击
          if (this.isInvalidBlankClick(target)) {
            return
          }
          target.command = 'click'
          target.commandCnStr = '点击'
          // 调用 recorder.js → setAttributeAction
          Recorder.setAttributeAction(target);
        }
      }

    }, {
      capture: true
    });
  }
}
