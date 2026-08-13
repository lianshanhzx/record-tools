/**
 * recorder.js — 录制核心模块
 * 管理录制状态、动作解析、元素值获取、label 提取等核心逻辑。
 * 被 content.js 入口初始化，供 EventMonitor / MessageHandler 调用。
 *
 * 依赖（由 manifest.json 保证加载顺序）：
 *   - Utils (libs/utils.js)           — uuid 生成
 *   - SmartSelector (libs/smartSelector.js) — XPath 选择器
 *   - XPathHelper (libs/myXPathHelper.js)   — XPath 查找
 *   - getChineseLabelByElement (libs/elementBusinessName.js) — 中文业务名称
 */

const ACTION_TYPE_ATTRIBUTE = 'ATTRIBUTE'

const Recorder = {
  nameMap: {},
  currId: '',
  listenDomList: [],
  scannedPageElements: [],
  idMap: new Map(),
  actions: [],
  _docu: null,
  _dateTimers: [],

  /**
   * 获取已录制的动作列表
   * 调用位置：content.js → pauseRecordEvent / stopRecordEvent
   */
  getActions() {
    console.log('----getActions-----', this.actions)
    return this.actions
  },

  /**
   * 绑定在 label 父容器上的点击事件处理，把 label 文本作为当前动作的业务名称保存。
   * 调用位置：recorder.js → getLableValue 中绑定
   */
  listenerHandle(event) {
    const labelDom = event && event.currentTarget && event.currentTarget.querySelector?.('label')
    const labelName = labelDom?.innerText || ''
    if (Recorder.currId) {
      Recorder.nameMap[Recorder.currId] = labelName
    }
  },

  /**
   * 清理录制状态：清空名称映射、动作列表、解绑 label 监听等。
   * 调用位置：content.js → pauseRecordEvent / stopRecordEvent
   */
  destroy() {
    console.log('----destroy-----')
    try {
      this.nameMap = {}
      this.currId = ''
      if (TreeSelectHandler) {
        TreeSelectHandler.pendingTreeSelect = null
        TreeSelectHandler.lastTreeSelect = null
      }
      if (this.listenDomList.length > 0) {
        this.listenDomList.forEach(item => {
          item.removeAttribute('isonclick')
          item.removeAttribute('isonclicked')
          item.removeEventListener('click', this.listenerHandle)
        })
        this.listenDomList = []
      }
      this._dateTimers.forEach(clearTimeout)
      this._dateTimers = []
      this.actions = []
      this.idMap.clear()
    } catch (error) {
      console.log(error)
    }
  },

  /**
   * 递归向上查找最近的 FORM 元素。
   * 调用位置：recorder.js → getLableValue
   */
  getFormDom(element) {
    if (element.nodeName === 'FORM') {
      return element
    } else if (element.parentNode && element.parentNode.nodeName) {
      const formDom = this.getFormDom(element.parentNode)
      return formDom || null
    }
  },

  /**
   * 为表单内所有 label 的父容器标记 isonclick 属性。
   * 调用位置：recorder.js → getLableValue
   */
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

  /**
   * 尝试为当前动作找到对应的业务名称（label / 表单 label / 中文名称）。
   * 调用位置：recorder.js → setAction
   */
  getLableValue(element) {
    if (this.nameMap[this.currId]) {
      return
    }
    if (element.id !== '') {
      const labelDom = document.querySelector('label[for="' + element.id + '"]')
      if (labelDom && labelDom.innerText) {
        this.nameMap[this.currId] = labelDom.innerText
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
        this.listenDomList.push(needNode)
        needNode.addEventListener('click', this.listenerHandle, {
          capture: true
        })
      }
    }
  },

  /**
   * 解析单个元素，生成录制动作对象。
   * 调用位置：recorder.js → setAction
   */
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

    // 计算元素分组路径（弹窗/页签/折叠面板），供 popup 树形展示使用
    let group = []
    try {
      if (typeof ElementGrouper !== 'undefined') {
        group = ElementGrouper.getGroupPath(element)
      }
    } catch (e) {
      console.warn('[Recorder] 计算分组路径失败:', e)
    }

    return {
      id: id,
      action: actionType,
      command: element['command'],
      target: xp,
      targetType: 'xpath',
      tagName: element.tagName.toLowerCase(),
      propertiesName: labelChName || '',
      group: group,
      attributes: attributes
    };
  },

  /**
   * 为元素分配动作唯一 id，使用 Utils.uuid() 生成。
   * 调用位置：recorder.js → parseElement / setAction
   */
  getID() {
    return Utils.uuid()
  },

  /**
   * 提取下拉框选项文本列表（录制时使用）。
   * 支持原生 <select> 和 Element UI .el-select。
   * @param {Element} element 当前操作的元素
   * @returns {string[]}
   */
  extractSelectOptions(element) {
    if (!element) return []
    if (typeof PageElementScanner !== 'undefined' && typeof PageElementScanner.extractSelectOptions === 'function') {
      return PageElementScanner.extractSelectOptions(element, element)
    }
    return []
  },

  /**
   * 获取输入类元素的真实值（兼容 Vue/React/Element UI）。
   * 调用位置：recorder.js → setAttributeAction / monitorDateInput
   */
  getInputValue(element) {
    if (!element) return ''

    const tagName = element.tagName
    if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
      const TagProto = tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
      const descriptor = Object.getOwnPropertyDescriptor(TagProto.prototype, 'value')
      if (descriptor && descriptor.get) {
        const realValue = descriptor.get.call(element)
        if (realValue || realValue === 0) return String(realValue)
      }
    }

    if (element.value || element.value === 0) return String(element.value)

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

  /**
   * 监听日期选择器输入框的值变化（轮询检测）。
   * 调用位置：content/eventMonitor.js → click 事件处理中日期选择器分支
   */
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
          MessageHandler.sendBackMessage('addActionData', self.actions[idx])
        }
        return
      }
      if (checkCount < maxChecks) {
        self._dateTimers.push(setTimeout(check, 200))
      }
    }

    self._dateTimers.push(setTimeout(check, 300))
  },

  /**
   * 将元素包装为一个"属性动作"并推入录制列表。
   * 调用位置：content/eventMonitor.js → change/click 事件处理
   */
  setAttributeAction(element) {
    let attributes = {
      type: ACTION_TYPE_ATTRIBUTE
    };
    attributes.value = this.getInputValue(element)
    return this.setAction(element, attributes);
  },

  /**
   * 把一个元素包装为动作并推入 actions 列表，同时通知 popup 更新。
   * 针对下拉框选择做了特殊处理：合并 select + selectOption 为一次动作。
   * 调用位置：recorder.js → setAttributeAction / content/eventMonitor.js
   */
  setAction(element, otherParam = {}) {
    console.log('---setAction---', element, otherParam);

    const id = this.idMap.get(element);
    const action = Object.assign(
      this.parseElement(element, id),
      { timestamp: Date.now() },
      otherParam
    );
    action.command = action.command || action.attributes.command

    // 关联扫描信息：命中扫描记录时，使用扫描记录的 target/propertiesName/group/kind/scanIndex，
    // 保留实际元素产生的 command/value/options，保证点击按钮内部子元素也能定位到扫描按钮。
    if (typeof PageElementScannerController !== 'undefined' && typeof PageElementScannerController.findScannedInfoByElement === 'function') {
      const scannedInfo = PageElementScannerController.findScannedInfoByElement(element)
      if (scannedInfo) {
        action.target = scannedInfo.target
        action.propertiesName = scannedInfo.propertiesName
        action.group = scannedInfo.group || action.group
        action.kind = scannedInfo.kind
        action.scanIndex = scannedInfo.scanIndex
        action.anchorTarget = scannedInfo.anchorTarget || ''
        action.anchorPropertiesName = scannedInfo.anchorPropertiesName || ''
        if (scannedInfo.options && scannedInfo.options.length > 0 && (!action.options || action.options.length === 0)) {
          action.options = scannedInfo.options
        }
      }
    }

    // 下拉框选项补充（录制时面板通常已打开，可获取到选项）
    if (action.kind === 'select' || element.command === 'select' || element.command === 'selectOption') {
      const opts = this.extractSelectOptions(element)
      if (opts && opts.length > 0) {
        action.options = opts
      }
    }

    // 人工录制标记：所有 setAction 产生的动作都来自用户真实操作
    action.manualRecord = true
    action.recorded = true

    this.currId = action.id
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

        // 把选项和人工标记同步到合并后的 select 动作
        if (action.options && action.options.length > 0) {
          lastAction.options = action.options
        }
        lastAction.manualRecord = true
        lastAction.recorded = true

        this.actions[this.actions.length - 1] = lastAction

        // 调用 content/messageHandler.js 中的 sendBackMessage
        MessageHandler.sendBackMessage('addActionData', lastAction);

      }, 100);

    } else {

      this.actions.push(action);
      // 调用 content/messageHandler.js 中的 sendBackMessage
      MessageHandler.sendBackMessage('addActionData', action);
      return action
    }
  }
}
