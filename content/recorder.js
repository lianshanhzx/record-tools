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
  scannedPageElements: [],
  idMap: new Map(),
  actions: [],
  _docu: null,
  _dateTimers: [],

  /**
   * 清理录制状态：清空动作列表、定时器和树选择候选状态。
   * 调用位置：content.js → pauseRecordEvent / stopRecordEvent
   */
  destroy() {
    try {
      if (TreeSelectHandler) {
        TreeSelectHandler.pendingTreeSelect = null
        TreeSelectHandler.lastTreeSelect = null
      }
      this._dateTimers.forEach(clearTimeout)
      this._dateTimers = []
      this.actions = []
      this.idMap.clear()
    } catch (error) {
      console.error(error)
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
    let eventTypeValue = Utils.normalizeEventType(element['command']);
    const realLabel = typeof getRealLabelByElement !== 'undefined'
      ? (getRealLabelByElement(element) || '')
      : ''
    const rect = typeof PageElementScanner !== 'undefined' && typeof PageElementScanner.getPagePosition === 'function'
      ? PageElementScanner.getPagePosition(element)
      : {}

    if (element['command'] === 'fill_date_field' || element['command'] === 'date') {
      eventTypeValue = 'date';
      element['command'] = 'input'
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

    let pageContext = null
    try {
      if (typeof PageElementScannerController !== 'undefined' &&
          typeof PageElementScannerController.getCurrentPageContext === 'function') {
        pageContext = PageElementScannerController.getCurrentPageContext()
      }
    } catch (e) {}

    return {
      propertiesID: id,
      eventTypeValue: eventTypeValue,
      eventTypeName: Utils.getEventTypeName(eventTypeValue),
      target: xp,
      mothed: 'By.XPATH',
      elementType: xp,
      transcationType: 'playwright',
      tagName: element.tagName.toLowerCase(),
      propertiesName: labelChName || '',
      realLabel: realLabel,
      rect: rect,
      group: group,
      pageKey: pageContext ? pageContext.key : '',
      pageUrl: pageContext ? pageContext.url : window.location.href,
      routeIdentity: pageContext ? pageContext.routeIdentity : '',
      pageOrder: pageContext ? pageContext.pageOrder : 0,
      attributes: attributes
    };
  },

  /**
   * 为元素分配唯一 propertiesID，使用 Utils.uuid() 生成。
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
    if (tagName === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) {
      return !!element.checked
    }
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
        const idx = self.actions.findIndex(a => a.propertiesID === action.propertiesID)
        if (idx >= 0) {
          self.actions[idx].objectValue = value
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
    const action = Utils.normalizeEventType(element && element.command)
    return this.setAction(element, {
      type: ACTION_TYPE_ATTRIBUTE,
      objectValue: this.getInputValue(element),
      // A user change to an input/selection is meaningful even when its value is empty.
      hasRecordedValue: ['input', 'date', 'radio'].includes(action) ||
        (element && element.tagName === 'INPUT' && element.type === 'checkbox')
    });
  },

  /**
   * 把一个元素包装为动作并推入 actions 列表，同时通知 popup 更新。
   * 针对下拉框选择做了特殊处理：合并 select + selectOption 为一次动作。
   * 调用位置：recorder.js → setAttributeAction / content/eventMonitor.js
   */
  setAction(element, otherParam = {}) {
    const id = this.idMap.get(element);
    const action = Object.assign(
      this.parseElement(element, id),
      { timestamp: Date.now() },
      otherParam
    );
    // 关联扫描信息：命中扫描记录时，使用扫描记录的定位和分组信息。
    if (typeof PageElementScannerController !== 'undefined' && typeof PageElementScannerController.findScannedInfoByElement === 'function') {
      const scannedInfo = PageElementScannerController.findScannedInfoByElement(element)
      if (scannedInfo) {
        action.target = scannedInfo.target
        action.elementType = scannedInfo.target
        action.propertiesName = scannedInfo.propertiesName
        action.realLabel = scannedInfo.realLabel || action.realLabel
        action.rect = scannedInfo.rect || scannedInfo.position || action.rect
        action.group = scannedInfo.group || action.group
        action.kind = scannedInfo.kind
        action.scanIndex = scannedInfo.scanIndex
        action.anchorTarget = scannedInfo.anchorTarget || ''
        action.anchorPropertiesName = scannedInfo.anchorPropertiesName || ''
        action.anchorRecordKey = scannedInfo.anchorRecordKey || ''
        if (scannedInfo.options && scannedInfo.options.length > 0 && (!action.options || action.options.length === 0)) {
          action.options = scannedInfo.options
        }
      } else if (typeof PageElementScannerController.getPendingScanAnchorByElement === 'function') {
        // 弹窗/页签等新区域已出现但仍在扫描 debounce 期时，扫描快照尚不可用。
        // 先补齐即将使用的锚点，后续扫描结果便能按 target + anchorTarget 与该人工动作合并。
        const pendingAnchor = PageElementScannerController.getPendingScanAnchorByElement(element)
        if (pendingAnchor) {
          action.anchorTarget = pendingAnchor.target
          action.anchorPropertiesName = pendingAnchor.propertiesName
          action.anchorRecordKey = pendingAnchor.recordKey || ''
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
    // 同一个 DOM 按钮的多次点击是不同的动作实例，不能复用 idMap 中的扫描 ID。
    // 下拉框 select + selectOption 的后续合并仍由下面的专用逻辑处理。
    action.propertiesID = this.getID()
    if (typeof PageElementScannerController !== 'undefined' &&
        typeof PageElementScannerController.setTriggerRecordKey === 'function') {
      PageElementScannerController.setTriggerRecordKey(element, action.propertiesID)
      if (typeof PageElementScannerController.getTriggerContextByElement === 'function') {
        const triggerContext = PageElementScannerController.getTriggerContextByElement(element)
        if (triggerContext) action.triggerRecordKey = triggerContext.recordKey || ''
      }
    }

    const lastAction = this.actions[this.actions.length - 1];
    if (this.actions.length > 0 && lastAction.eventTypeValue === 'select:click' && element.command === 'selectOption') {
      let lastEle = null
      if (lastAction.mothed === 'By.XPATH') {
        lastEle = XPathHelper.$(lastAction.target)
      }
      setTimeout(() => {
        if (lastEle && lastEle.value) {
          lastAction.objectValue = lastEle.value
        } else if (lastEle) {
          const selectEle = lastEle.closest(".el-select")
          const multiEles = selectEle ? selectEle.querySelectorAll(".el-select__tags-text") : []

          let selectValueArr = []
          if (multiEles && multiEles.length > 0) {
            multiEles.forEach(item => {
              if (item.innerText) {
                selectValueArr.push(item.innerText)
              }
            })
            lastAction.objectValue = selectValueArr.join(',')
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
