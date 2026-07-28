chrome.runtime.sendMessage({ type: "initMonitor" }, (response) => {
  if (response && response.monitorStates) {
    startRecordEvent()
  }
})


let url = '';
ACTION_TYPE_ATTRIBUTE = 'ATTRIBUTE'
let nameMap = {}
let currId = ''
let listenDomList = []
let _snapshot = {
  clickDom: new Set(),
  id: 0,

  idMap: new Map(),

  actions: [],

  pendingTreeSelect: null,

  lastTreeSelect: null,

  _docu: null,

  getActions() {

    console.log('----getActions-----', this.actions)
    return this.actions
  },


  listenerHandle(event) {
    const labelDom = event && event.currentTarget && event.currentTarget.querySelector?.('label')
    const labelName = labelDom?.innerText || ''
    if (currId) {
      nameMap[currId] = labelName
    }
  },


  destroy() {

    console.log('----destroy-----')
    try {
      nameMap = {}
      currId = ''
      this.pendingTreeSelect = null
      this.lastTreeSelect = null
      if (listenDomList.length > 0) {
        listenDomList.forEach(item => {
          item.removeAttribute('isonclick')
          item.removeAttribute('isonclicked')
          item.removeEventListener('click', this.listenerHandle)
        })
        listenDomList = []
      }
    } catch (error) {
      console.log(error)
    }
  },

  getFormDom(element) {
    if (element.nodeName === 'FORM') {
      return element
    } else if (element.parentNode && element.parentNode.nodeName) {
      const formDom = this.getFormDom(element.parentNode)
      return formDom || null
    }
  },



  setOnClickFlag(form) {
    const allLabels = form.getElementsByTagName?.('label')
    if (allLabels && allLabels.length > 0) {
      for (let index = 0; index < allLabels.length; index++) {
        const element = allLabels[index];
        if (element.parentElement && !element.parentElement.getAttribute?.('isonclick')) {
          element.parentElement.setAttribute('isonclick', true)
        }
      }
    }
  },

  getLableValue(element) {
    if (nameMap[currId]) {
      return
    }
    if (element.id !== '') {
      const labelDom = document.querySelector('label[for="' + element.id + '"]')
      if (labelDom && labelDom.innerText) {
        nameMap[currId] = labelDom.innerText
      }
    } else if (element.form) {
      this.setOnClickFlag(element.form)
    } else {
      if (this.getFormDom(element.parentNode)) {
        this.setOnClickFlag(this.getFormDom(element.parentNode))
      }
    }

    const needList = document.querySelectorAll('div[isonclick="true"]')
    for (let index = 0; index < needList.length; index++) {
      const needNode = needList[index];
      if (needNode.onclick) {
        return
      }
      if (!needNode.getAttribute('isonclicked')) {
        needNode.setAttribute('isonclicked', true)
        listenDomList.push(needNode)
        needNode.addEventListener('click', this.listenerHandle, {
          capture: true
        })
      }
    }

    console.log()
  },

  serialization(parent) {
    let element = this.parseElement(parent);
    if (parent.children.length == 0) {
      parent.textContent && (element.textContent = parent.textContent);
      return element;
    }
    Array.from(parent.children, child => {
      element.children.push(this.serialization(child));
    });
    return element;
  },

  parseElement(element, id) {
    let attributes = {};
    for (const { name, value } of Array.from(element.attributes)) {
      attributes[name] = value;
    }
    if (!id) {
      id = this.getID();
      this.idMap.set(element, id);
    }

    let labelChName = getChineseLabelByElement(element)

    labelChName = labelChName?.replace(/[^\w\d\u4e00-\u9fa5]/g, '');

    let xp = new SmartSelector(element).getSelector();
    let actionType = '';

    console.log('----element--1111---', element, element.type, element['command'])

    if (element['command'] === 'fill_date_field') {
      actionType = 'fill_date_field';
      element['command'] = 'input'
    } else if (element['command'] === 'input' || element['command'] === 'fill_form_field') {
      actionType = 'fill_form_field';
    } else if (element['command'] === 'click') {
      actionType = 'click_element_by_index';
    } else if (element['command'] === 'selectOption' || element['command'] === 'select') {
      actionType = 'select_option';
    } else if (element['command'] === 'select_tree_option') {
      actionType = 'select_tree_option';
    }

    return {
      id: id,
      action: actionType,
      command: element['command'],
      target: xp,
      targetType: 'xpath',
      tagName: element.tagName.toLowerCase(),
      propertiesName: labelChName || '',
      attributes: attributes
    };
  },

  uuid() {
    var s = [];
    var hexDigits = "0123456789abcdef";
    for (var i = 0; i < 36; i++) {
      s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
    }

    s[14] = "4";
    s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);
    s[8] = s[13] = s[18] = s[23] = "-";

    var uuid = s.join("");
    return uuid;

  },

  getID() {
    return this.uuid();
  },

  getInputValue(element) {
    if (!element) return ''

    // 1. 优先使用原生 property descriptor 读取真实值（兼容 Vue/React 等框架）
    const tagName = element.tagName
    if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
      const TagProto = tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
      const descriptor = Object.getOwnPropertyDescriptor(TagProto.prototype, 'value')
      if (descriptor && descriptor.get) {
        const realValue = descriptor.get.call(element)
        if (realValue || realValue === 0) return String(realValue)
      }
    }

    // 2. 兜底读取 element.value
    if (element.value || element.value === 0) return String(element.value)

    // 3. 针对 Element UI 日期选择器：尝试从组件实例中读取 value
    const dateEditor = element.closest('.el-date-editor, .tsscdatepicker')
    if (dateEditor) {
      const vm = dateEditor.__vue__ || dateEditor.closest('.tsscdatepicker')?.__vue__
      if (vm) {
        const val = vm.value || vm.$data?.value || vm.modelValue || vm.$props?.value
        if (val || val === 0) return String(val)
      }
    }

    return ''
  },

  monitorDateInput(inputElement, action) {
    if (!inputElement || !action) return
    const self = this
    let resolved = false
    let checkCount = 0
    const maxChecks = 150
    const initialValue = self.getInputValue(inputElement)

    const check = () => {
      if (resolved) return
      checkCount++
      const value = self.getInputValue(inputElement)
      if (value && value !== initialValue) {
        resolved = true
        const idx = self.actions.findIndex(a => a.id === action.id)
        if (idx >= 0) {
          self.actions[idx].value = value
          if (self.actions[idx].attributes) {
            self.actions[idx].attributes.value = value
          }
          sendBackMessage('addActionData', self.actions[idx])
        }
        return
      }
      if (checkCount < maxChecks) {
        setTimeout(check, 200)
      }
    }

    setTimeout(check, 300)
  },

  setAttributeAction(element) {
    let attributes = {
      type: ACTION_TYPE_ATTRIBUTE
    };
    attributes.value = this.getInputValue(element)
    return this.setAction(element, attributes);
  },

  getTreeTriggerInput(element) {
    if (!element || !element.closest) {
      return null
    }
    const input = element.closest('.el-input')?.querySelector('input:not([type="hidden"]), textarea')
    if (!input || input.closest('.el-select')) {
      return null
    }
    return input
  },

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

  hasVisibleTreePopup() {
    const trees = document.querySelectorAll('.el-tree, [role="tree"], .ant-tree, .ivu-tree, .t-tree')
    for (const tree of trees) {
      if (tree.offsetParent !== null) {
        return true
      }
    }
    return false
  },

  getTreeNodeText(treeNode) {
    const label = treeNode?.querySelector?.('.el-tree-node__label, .ant-tree-title, .ivu-tree-title, .t-tree__label')
    return (label?.innerText || treeNode?.innerText || '').trim()
  },

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
   * 判断一次点击是否属于“无效空白区域”
   *
   * 手动录制时，用户经常会误点到页面中没有实际业务意义的空白容器上。
   * 这类点击生成的 click 动作在回放时通常找不到有效目标，导致回放失败。
   * 同时满足以下所有条件时，会被视为无效空白点击并忽略：
   *   1. 不是 button/a/input 等交互元素，也不在交互元素内部；
   *   2. 没有可见文本内容；
   *   3. 没有子元素（即不包含图标、图片等任何可见内容）；
   *   4. 没有原生 onclick 属性；
   *   5. 鼠标样式不是 pointer（说明页面没有把它当作可点击元素）。
   *
   * 注意：真正的按钮、链接、图标以及已被其它分支处理的组件（如下拉框、
   * 日期选择器、树形选择器）不会被误判。
   */
  isInvalidBlankClick(element) {
    if (!element) return false

    // 1. 本身属于交互元素或位于交互元素内部（例如按钮内的图标、空白处）
    const interactiveSelector =
      'button, a, input, textarea, select, label, details, summary, ' +
      '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [onclick]'
    if (element.closest(interactiveSelector)) {
      return false
    }

    // 2. 有可见文本、有子元素、或存在原生 onclick，认为是有意义的点击
    const hasVisibleText = !!(element.innerText || '').trim()
    const hasChildren = !!(element.children && element.children.length)
    if (hasVisibleText || hasChildren || element.onclick) {
      return false
    }

    // 3. 页面通过 cursor: pointer 提示可点击，同样保留
    try {
      if (window.getComputedStyle(element).cursor === 'pointer') {
        return false
      }
    } catch (e) {
      // 某些特殊元素可能无法获取计算样式，保守起见不当作空白
      return false
    }

    return true
  },

  startTreeSelectCandidate(inputElement, action) {
    if (!inputElement || !action) {
      return
    }
    this.pendingTreeSelect = {
      id: action.id,
      target: action.target,
      inputElement,
      valueBefore: inputElement.value || '',
      finalizing: false,
      timestamp: Date.now()
    }
  },

  clearExpiredTreeSelect() {
    if (this.pendingTreeSelect && Date.now() - this.pendingTreeSelect.timestamp > 15000) {
      this.pendingTreeSelect = null
    }
  },

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

      const actionIndex = this.actions.findIndex(item => item.id === pending.id || item.target === pending.target)
      if (actionIndex === -1) {
        this.pendingTreeSelect = null
        return
      }

      const action = this.actions[actionIndex]
      action.command = 'select_tree_option'
      action.value = finalValue || selectedText
      if (action.attributes) {
        action.attributes.value = action.value
      }
      this.actions[actionIndex] = action
      this.lastTreeSelect = {
        inputElement,
        timestamp: Date.now()
      }
      this.pendingTreeSelect = null

      sendBackMessage('addActionData', action);
    }, 150)

    return true
  },



  setAction(element, otherParam = {}) {
    console.log('---setAction---', element, otherParam);

    const id = this.idMap.get(element);
    const action = Object.assign(
      this.parseElement(element, id),
      { timestamp: Date.now() },
      otherParam
    );
    action.command = action.command || action.attributes.command

    currId = action.id
    this.getLableValue(element)


    const lastAction = this.actions[this.actions.length - 1];
    if (this.actions.length > 0 && lastAction.command == 'select' && element.command == 'selectOption') {
      let lastEle = null
      if (lastAction.targetType == 'xpath') {
        lastEle = XPathHelper.$(lastAction.target)
      } else if (lastAction.targetType == 'css') {
        lastEle = document.querySelector(lastAction.target)
      }
      setTimeout(() => {
        if (lastEle && lastEle.value) {
          lastAction.value = lastEle.value
        } else {
          const selectEle = lastEle.closest(".el-select")
          const multiEles = selectEle.querySelectorAll(".el-select__tags-text")

          let selectValueArr = []
          if (multiEles && multiEles.length > 0) {
            multiEles.forEach(item => {
              if (item.innerText) {
                selectValueArr.push(item.innerText)
              }
            })
            lastAction.value = selectValueArr.join(',')
          }
        }

        this.actions[this.actions.length - 1] = lastAction

        sendBackMessage('addActionData', lastAction);

      }, 100);

    } else {

      this.actions.push(action);
      sendBackMessage('addActionData', action);
      return action
    }
  },


  getInputLabel(input) {
  },



  listener(document) {

    console.log('---listener---', document);

    this._docu = document;
    this._docu.addEventListener("change", event => {
      const { target } = event;
      if (this.shouldIgnoreTreeChange(target)) {
        return
      }
      const dateEditor = target.closest('.el-date-editor, .tsscdatepicker')
      if (dateEditor) {
        target.command = 'fill_date_field'
        target.commandCnStr = '日期选择'
        this.setAttributeAction(target)
      } else {
        target.command = 'input'
        target.label = this.getInputLabel(target)
        target.commandCnStr = '输入'
        this.setAttributeAction(target)
      }
    }, {
      capture: true
    });


    this._docu.addEventListener("click", event => {
      const { target } = event;
      this.clearExpiredTreeSelect()

      const treeNodeEle = this.getTreeNodeElement(target)
      if (treeNodeEle && this.handleTreeNodeClick(treeNodeEle)) {
        return
      }
      if (this.pendingTreeSelect && this.isInTreePopup(target)) {
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
        selectInputEle = selectEle.querySelector('input')
        selectInputEle.command = 'select'
        selectInputEle.commandCnStr = '下拉框xpath选择'

        this.setAttributeAction(selectInputEle);

      } else if (selectOptionEle) {
        selectOptionEle.command = 'selectOption'
        selectOptionEle.commandCnStr = '下拉框xpath选择'

        this.setAttributeAction(selectOptionEle);
      } else if (dateIpt) {
        const dateInput = dateIpt.querySelector('input:not([type="hidden"])') || target
        dateInput.command = 'fill_date_field'
        dateInput.commandCnStr = '日期选择'
        const action = this.setAttributeAction(dateInput)
        if (action) {
          this.monitorDateInput(dateInput, action)
        }
      } else {
        const treeInputEle = this.getTreeTriggerInput(target)
        if (treeInputEle) {
          treeInputEle.command = 'click'
          treeInputEle.commandCnStr = '点击'
          const action = this.setAttributeAction(treeInputEle);
          this.startTreeSelectCandidate(treeInputEle, action)
        } else if (!target.matches('input, textarea')) {
          // 过滤掉空白区域的无效点击，避免把没有业务意义的点击录入动作列表
          if (this.isInvalidBlankClick(target)) {
            return
          }
          target.command = 'click'
          target.commandCnStr = '点击'
          this.setAttributeAction(target);
        }
      }

    }, {
      capture: true
    });
  }
}





function startRecordEvent() {
  const startUrl = window.location.href;
  sendBackMessage('startRecord', startUrl);
  _snapshot.listener(document)
}

function continueRecordEvent() {
  _snapshot.listener(document)
}

function pauseRecordEvent() {
  const actions = _snapshot.getActions().map(item => {
    return {
      ...item,
      name: nameMap[item.id] || ''
    }
  })
  _snapshot.destroy()
  sendBackMessage('stopRecord', actions);
}

function stopRecordEvent() {
  const actions = _snapshot.getActions().map(item => {
    return {
      ...item,
      name: nameMap[item.id] || ''
    }
  })
  _snapshot.destroy()
  sendBackMessage('stopRecord', actions);
}


function sendBackMessage(_type, data) {
  chrome.runtime.sendMessage({ type: _type, data: data, url: url }, (response) => {
  });
}



chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'start' || request.type === 'startRecording') {
    startRecordEvent();
    sendResponse({ status: 'started' });
    return true;
  }
  if (request.type === 'stopRecording') {
    stopRecordEvent();
    sendResponse({ status: 'stopped' });
    return true;
  }
  if (request.type === 'pauseRecording') {
    pauseRecordEvent();
    sendResponse({ status: 'paused' });
    return true;
  }
  if (request.type === 'continueRecording') {
    continueRecordEvent();
    sendResponse({ status: 'continued' });
    return true;
  }
  if (request.type === 'ping') {
    sendResponse({ alive: true })
    return true
  }
  if (request.type === 'scanFields') {
    const fields = AutoFormFill.scanFields()
    sendResponse({ fields })
    return true
  }
  if (request.type === 'logToConsole') {
    console.log('[自动填表] ' + request.tag + ' ======')
    try { console.log(JSON.parse(request.data)); } catch (e) { console.log(request.data); }
    sendResponse({ ok: true })
    return true
  }
  if (request.type === 'executeActions') {
    AutoFormFill.executeActions(request.actions).then(results => {
      for (const r of results) {
        if (r.result === 'ok' || r.result.startsWith('ok')) {
          let xpath = ''
          const el = AutoFormFill.findElementByLabel(r.label, r.action)
          if (el && typeof SmartSelector !== 'undefined') {
            try { xpath = new SmartSelector(el).getSelector() } catch (e) { }
          }
          chrome.runtime.sendMessage({
            type: 'addActionData',
            data: {
              command: r.action === 'fill_input' ? 'input' : 'select',
              target: xpath || ('label="' + r.label + '"'),
              targetType: xpath ? 'xpath' : 'label',
              tagName: el ? el.tagName.toLowerCase() : 'input',
              value: r.value || '',
              propertiesName: r.label || '',
              id: AutoFormFill._uuid(),
              timestamp: Date.now(),
              attributes: { value: r.value || '', type: 'ATTRIBUTE' }
            }
          })
        }
      }
      chrome.runtime.sendMessage({ type: 'actionComplete', data: results })
    })
    sendResponse({ started: true })
    return true
  }
})

document.addEventListener('DOMContentLoaded', function () {
  console.log('DOMContentLoaded')
})

window.onload = () => {
  sendBackMessage('refresh', {})
}
