/**
 * treeSelectHandler.js — 树形选择器处理模块
 * 负责树形组件的节点识别、弹窗检测、候选动作管理等逻辑。
 * 兼容 Element UI / Ant Design / iView / TDesign 等主流组件库。
 *
 * 被 content/eventMonitor.js 在事件处理中调用。
 */

const TreeSelectHandler = {
  pendingTreeSelect: null,
  lastTreeSelect: null,

  /**
   * 判断元素是否触发了树形选择器输入框，若是返回对应 input。
   * 调用位置：content/eventMonitor.js → click 事件处理中的树形触发 input 分支
   */
  getTreeTriggerInput(element) {
    if (!element || !element.closest) {
      return null
    }
    const input = element.closest('.el-input')?.querySelector('input:not([type="hidden"]), textarea')
    if (!input || input.closest('.el-select')) {
      return null
    }
    const treeSelectRoot = input.closest(
      '.el-tree-select, .tree-select, .ant-tree-select, .ivu-tree-select, .t-tree-select, ' +
      '[data-tree-select], [aria-haspopup="tree"]'
    )
    if (treeSelectRoot) return input

    const treeSelector = '.el-tree, [role="tree"], .ant-tree, .ivu-tree, .t-tree'
    const controlledIds = []
    let node = input
    // 部分 Element UI 树选择器将 popover 的关联 ID 放在外层 .el-input，
    // 而不是实际 input 上（aria-describedby="el-popover-xxxx"）。
    while (node && node !== document.documentElement) {
      ;['aria-controls', 'aria-owns', 'aria-describedby'].forEach(attribute => {
        const value = node.getAttribute?.(attribute) || ''
        value.split(/\s+/).filter(Boolean).forEach(id => controlledIds.push(id))
      })
      if (node.classList?.contains('el-form-item')) break
      node = node.parentElement
    }
    for (const id of controlledIds) {
      const controlled = document.getElementById(id)
      if (controlled?.querySelector(treeSelector)) return input
    }
    return null
  },

  /**
   * 从点击目标向上查找树形组件中的节点元素。
   * 调用位置：content/eventMonitor.js → click 事件处理中优先处理树形节点
   */
  getTreeNodeElement(element) {
    if (!element || !element.closest) {
      return null
    }
    const tree = element.closest('.el-tree, [role="tree"], .ant-tree, .ivu-tree, .t-tree')
    if (!tree) {
      return null
    }
    return element.closest('.el-tree-node__content, [role="treeitem"], .ant-tree-node-content-wrapper, .ant-tree-title, .ivu-tree-title, .t-tree__label')
  },

  /**
   * 判断元素是否位于树形弹窗/浮层内部。
   * 调用位置：content/eventMonitor.js → click/change 事件处理
   */
  isInTreePopup(element) {
    if (!element || !element.closest) {
      return false
    }
    if (element.closest('.el-tree, [role="tree"], .ant-tree, .ivu-tree, .t-tree')) {
      return true
    }
    const popup = element.closest('.el-popover, .el-popper, .el-dialog, .ant-tree-select-dropdown, .ant-select-dropdown, .ivu-select-dropdown, .t-popup, .t-dialog')
    return !!popup?.querySelector('.el-tree, [role="tree"], .ant-tree, .ivu-tree, .t-tree')
  },

  /**
   * 当前页面是否存在可见的树形组件浮层。
   * 调用位置：treeSelectHandler.js → handleTreeNodeClick
   */
  hasVisibleTreePopup() {
    const trees = document.querySelectorAll('.el-tree, [role="tree"], .ant-tree, .ivu-tree, .t-tree')
    for (const tree of trees) {
      if (tree.offsetParent !== null) {
        return true
      }
    }
    return false
  },

  /**
   * 获取树节点的显示文本。
   * 调用位置：treeSelectHandler.js → handleTreeNodeClick
   */
  getTreeNodeText(treeNode) {
    const label = treeNode?.querySelector?.(
      '.el-tree-node__label, .dropdown-tree .node, .ant-tree-title, .ivu-tree-title, .t-tree__label'
    )
    return (label?.innerText || treeNode?.innerText || '').trim()
  },

  /**
   * 判断树节点是否为叶子节点（不可再展开）。
   * 调用位置：treeSelectHandler.js → handleTreeNodeClick
   */
  isTreeLeafNode(treeNode) {
    const node = treeNode?.closest?.('.el-tree-node, [role="treeitem"], .ant-tree-treenode, .ivu-tree-children li, .t-tree__item')
    if (!node) {
      return false
    }

    const elExpandIcon = node.querySelector('.el-tree-node__expand-icon')
    if (elExpandIcon) {
      return elExpandIcon.classList.contains('is-leaf')
    }

    const ariaExpanded = node.getAttribute('aria-expanded')
    if (ariaExpanded === 'true' || ariaExpanded === 'false') {
      return false
    }

    if (node.querySelector('.ant-tree-switcher:not(.ant-tree-switcher-noop), .ivu-tree-arrow, .t-tree__icon')) {
      return false
    }

    return !node.querySelector('.el-tree-node__children, .ant-tree-child-tree, .ivu-tree-children, .t-tree__item')
  },

  /**
   * 当用户点击树形选择器触发 input 时，记录一个候选动作。
   * 调用位置：content/eventMonitor.js → click 事件处理中的树形触发 input 分支
   */
  startTreeSelectCandidate(inputElement, action) {
    if (!inputElement || !action) {
      return
    }
    this.pendingTreeSelect = {
      propertiesID: action.propertiesID,
      target: action.target,
      inputElement,
      valueBefore: inputElement.value || '',
      finalizing: false,
      timestamp: Date.now()
    }
  },

  /**
   * 清理过期的树形候选动作（默认 15 秒超时）。
   * 调用位置：content/eventMonitor.js → click 事件处理开头 / change 事件处理
   */
  clearExpiredTreeSelect() {
    if (this.pendingTreeSelect && Date.now() - this.pendingTreeSelect.timestamp > 15000) {
      this.pendingTreeSelect = null
    }
  },

  /**
   * 在 change 事件中判断是否应忽略来自树形弹窗的变更。
   * 调用位置：content/eventMonitor.js → change 事件处理开头
   */
  shouldIgnoreTreeChange(element) {
    this.clearExpiredTreeSelect()
    if (this.lastTreeSelect && Date.now() - this.lastTreeSelect.timestamp > 1000) {
      this.lastTreeSelect = null
    }
    if (this.lastTreeSelect && element === this.lastTreeSelect.inputElement) {
      return true
    }
    const pending = this.pendingTreeSelect
    if (!pending) {
      return false
    }
    if (this.isInTreePopup(element)) {
      pending.timestamp = Date.now()
      return true
    }
    return pending.finalizing && element === pending.inputElement
  },

  /**
   * 处理用户在树形弹窗中点击节点的逻辑。
   * 若已选择叶子节点或树弹窗已关闭，则把候选动作更新为最终树选择动作。
   * 调用位置：content/eventMonitor.js → click 事件处理中优先处理树形节点
   * @returns {boolean} 是否已处理
   */
  handleTreeNodeClick(treeNode) {
    const pending = this.pendingTreeSelect
    if (!pending) {
      return false
    }
    pending.timestamp = Date.now()
    pending.finalizing = true
    const selectedText = this.getTreeNodeText(treeNode)
    const isLeafNode = this.isTreeLeafNode(treeNode)

    setTimeout(() => {
      const inputElement = pending.inputElement
      const finalValue = (inputElement?.value || '').trim()
      const popupClosed = !this.hasVisibleTreePopup()

      if (!popupClosed && !isLeafNode) {
        pending.finalizing = false
        return
      }
      if (!finalValue && !selectedText) {
        pending.finalizing = false
        return
      }

      const actionIndex = Recorder.actions.findIndex(item => item.propertiesID === pending.propertiesID || item.target === pending.target)
      if (actionIndex === -1) {
        this.pendingTreeSelect = null
        return
      }

      const action = Recorder.actions[actionIndex]
      action.eventTypeValue = 'select:tree'
      action.eventTypeName = Utils.getEventTypeName(action.eventTypeValue)
      action.objectValue = finalValue || selectedText
      if (action.attributes) {
        action.attributes.value = action.objectValue
      }
      Recorder.actions[actionIndex] = action
      this.lastTreeSelect = {
        inputElement,
        timestamp: Date.now()
      }
      this.pendingTreeSelect = null

      // 调用 content/messageHandler.js 中的 sendBackMessage
      MessageHandler.sendBackMessage('addActionData', action);
    }, 150)

    return true
  }
}
