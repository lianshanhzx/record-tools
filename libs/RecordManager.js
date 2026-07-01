/**
 * 录制管理器
 * 负责管理录制状态、监听DOM事件、收集录制动作
 */

class RecordManager {
  constructor() {
    this.actions = [];           // 录制动作列表
    this.isRecording = false;    // 是否正在录制
    this.isPaused = false;       // 是否暂停
    this.idMap = new Map();      // 元素到ID的映射
    this.listenDomList = [];     // 监听的DOM列表
    this.nameMap = {};           // 业务名称映射
    this.currentId = '';         // 当前元素ID
    this.document = null;        // 当前文档对象
    this.onActionAdded = null;   // 动作添加回调函数
    this.listenerHandle = this.listenerHandle.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.handleClick = this.handleClick.bind(this);
  }

  /**
   * 设置动作添加回调
   * @param {Function} callback - 回调函数
   */
  setOnActionAdded(callback) {
    this.onActionAdded = callback;
  }

  /**
   * 开始录制
   * @param {Document} doc - 文档对象
   */
  start(doc) {
    if (this.isRecording && !this.isPaused) {
      console.warn('录制已在进行中');
      return;
    }

    this.document = doc;
    this.isRecording = true;
    this.isPaused = false;
    this.actions = [];
    this.idMap.clear();
    this.nameMap = {};
    this.currentId = '';

    this.attachListeners();
    console.log('录制已开始');
  }

  /**
   * 暂停录制
   */
  pause() {
    if (!this.isRecording || this.isPaused) {
      console.warn('录制未开始或已暂停');
      return;
    }

    this.isPaused = true;
    this.detachListeners();
    console.log('录制已暂停');
  }

  /**
   * 继续录制
   */
  resume() {
    if (!this.isRecording || !this.isPaused) {
      console.warn('录制未暂停或未开始');
      return;
    }

    this.isPaused = false;
    this.attachListeners();
    console.log('录制已继续');
  }

  /**
   * 停止录制
   * @returns {Array} 录制动作列表（包含业务名称）
   */
  stop() {
    if (!this.isRecording) {
      console.warn('录制未开始');
      return [];
    }

    this.isRecording = false;
    this.isPaused = false;
    this.detachListeners();

    // 添加业务名称到每个动作
    const result = this.actions.map(item => ({
      ...item,
      name: this.nameMap[item.id] || ''
    }));

    console.log('录制已停止，共录制', result.length, '个动作');
    return result;
  }

  /**
   * 获取录制动作列表
   * @returns {Array} 动作列表
   */
  getActions() {
    return this.actions;
  }

  /**
   * 获取录制状态
   * @returns {Object} 状态对象
   */
  getState() {
    return {
      isRecording: this.isRecording,
      isPaused: this.isPaused,
      actionCount: this.actions.length
    };
  }

  /**
   * 清空录制数据
   */
  clear() {
    this.actions = [];
    this.idMap.clear();
    this.nameMap = {};
    this.currentId = '';
    this.destroy();
  }

  /**
   * 销毁管理器
   */
  destroy() {
    this.detachListeners();
    this.nameMap = {};
    this.currentId = '';
    this.listenDomList.forEach(item => {
      item.removeAttribute('isonclick');
      item.removeAttribute('isonclicked');
      item.removeEventListener('click', this.listenerHandle);
    });
    this.listenDomList = [];
  }

  /**
   * 绑定事件监听器
   */
  attachListeners() {
    if (!this.document) return;

    this.document.addEventListener('change', this.handleChange, { capture: true });
    this.document.addEventListener('click', this.handleClick, { capture: true });
  }

  /**
   * 解绑事件监听器
   */
  detachListeners() {
    if (!this.document) return;

    this.document.removeEventListener('change', this.handleChange, { capture: true });
    this.document.removeEventListener('click', this.handleClick, { capture: true });
  }

  /**
   * 处理change事件
   */
  handleChange(event) {
    const { target } = event;
    target.command = 'input';
    target.commandCnStr = '输入';
    this.setAttributeAction(target);
  }

  /**
   * 处理click事件
   */
  handleClick(event) {
    const { target } = event;

    const selectEle = target.closest('.el-select');
    const selectOptionEle = target.closest('.el-select-dropdown__item');

    if (selectEle) {
      const selectInputEle = selectEle.querySelector('input');
      if (selectInputEle) {
        selectInputEle.command = 'select';
        selectInputEle.commandCnStr = '下拉框xpath选择';
        this.setAttributeAction(selectInputEle);
      }
    } else if (selectOptionEle) {
      selectOptionEle.command = 'selectOption';
      selectOptionEle.commandCnStr = '下拉框xpath选择';
      this.setAttributeAction(selectOptionEle);
    } else {
      target.command = 'click';
      target.commandCnStr = '点击';
      this.setAttributeAction(target);
    }
  }

  /**
   * 设置属性动作
   */
  setAttributeAction(element) {
    const attributes = {
      type: 'ATTRIBUTE'
    };
    attributes.value = element.value || '';
    this.setAction(element, attributes);
  }

  /**
   * 设置动作
   */
  setAction(element, otherParam = {}) {
    const id = this.idMap.get(element);
    const action = Object.assign(
      this.parseElement(element, id),
      { timestamp: Date.now() },
      otherParam
    );

    // 处理command的补丁
    action.command = action.command || action.attributes.command;

    this.currentId = action.id;
    this.getLabelValue(element);

    const lastAction = this.actions[this.actions.length - 1];

    // 处理select和selectOption的特殊情况
    if (
      this.actions.length > 0 &&
      lastAction.command === 'select' &&
      element.command === 'selectOption'
    ) {
      this.handleSelectOption(lastAction, element);
    } else {
      this.actions.push(action);
      this.notifyActionAdded(action);
    }
  }

  /**
   * 处理selectOption
   */
  handleSelectOption(lastAction, element) {
    setTimeout(() => {
      let lastEle = null;
      if (lastAction.targetType === 'xpath') {
        lastEle = XPathHelper ? XPathHelper.$(lastAction.target) : null;
      } else if (lastAction.targetType === 'css') {
        lastEle = document.querySelector(lastAction.target);
      }

      if (lastEle && lastEle.value) {
        lastAction.value = lastEle.value;
      } else {
        const selectEle = lastEle?.closest('.el-select');
        const multiEles = selectEle?.querySelectorAll('.el-select__tags-text');
        if (multiEles && multiEles.length > 0) {
          const selectValueArr = Array.from(multiEles)
            .map(item => item.innerText)
            .filter(Boolean);
          lastAction.value = selectValueArr.join(',');
        }
      }

      this.actions[this.actions.length - 1] = lastAction;
      this.notifyActionAdded(lastAction);
    }, 100);
  }

  /**
   * 解析元素为可序列化对象
   */
  parseElement(element, id) {
    const attributes = {};
    for (const { name, value } of Array.from(element.attributes)) {
      attributes[name] = value;
    }

    if (!id) {
      id = this.generateId();
      this.idMap.set(element, id);
    }

    let labelChName = '';
    if (typeof getChineseLabelByElement === 'function') {
      labelChName = getChineseLabelByElement(element);
    }
    labelChName = labelChName?.replace(/[^\w\d\u4e00-\u9fa5]/g, '') || '';

    let xp = '';
    if (typeof SmartSelector !== 'undefined') {
      xp = new SmartSelector(element).getSelector();
    }

    return {
      id,
      command: element['command'],
      target: xp,
      targetType: 'xpath',
      tagName: element.tagName.toLowerCase(),
      propertiesName: labelChName,
      attributes
    };
  }

  /**
   * 生成唯一ID
   */
  generateId() {
    const hexDigits = '0123456789abcdef';
    const s = [];
    for (let i = 0; i < 36; i++) {
      s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
    }
    s[14] = '4';
    s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);
    s[8] = s[13] = s[18] = s[23] = '-';
    return s.join('');
  }

  /**
   * 获取元素标签值
   */
  getLabelValue(element) {
    if (this.nameMap[this.currentId]) {
      return;
    }

    if (element.id !== '') {
      const labelDom = document.querySelector(`label[for="${element.id}"]`);
      if (labelDom && labelDom.innerText) {
        this.nameMap[this.currentId] = labelDom.innerText;
      }
    } else if (element.form) {
      this.setOnClickFlag(element.form);
    } else {
      const formDom = this.getFormDom(element.parentNode);
      if (formDom) {
        this.setOnClickFlag(formDom);
      }
    }

    const needList = document.querySelectorAll('div[isonclick="true"]');
    for (const needNode of needList) {
      if (needNode.onclick) {
        return;
      }
      if (!needNode.getAttribute('isonclicked')) {
        needNode.setAttribute('isonclicked', true);
        this.listenDomList.push(needNode);
        needNode.addEventListener('click', this.listenerHandle, { capture: true });
      }
    }
  }

  /**
   * 标签点击处理
   */
  listenerHandle(event) {
    const labelDom = event.currentTarget?.querySelector('label');
    const labelName = labelDom?.innerText || '';
    if (this.currentId) {
      this.nameMap[this.currentId] = labelName;
    }
  }

  /**
   * 设置点击标志
   */
  setOnClickFlag(form) {
    const allLabels = form.getElementsByTagName?.('label');
    if (allLabels && allLabels.length > 0) {
      for (const element of allLabels) {
        if (element.parentElement && !element.parentElement.getAttribute?.('isonclick')) {
          element.parentElement.setAttribute('isonclick', true);
        }
      }
    }
  }

  /**
   * 获取表单元素
   */
  getFormDom(element) {
    if (!element) return null;
    if (element.nodeName === 'FORM') {
      return element;
    }
    return this.getFormDom(element.parentNode);
  }

  /**
   * 通知动作添加
   * @param {Object} action - 动作对象
   */
  notifyActionAdded(action) {
    // 使用回调函数发送消息
    if (typeof this.onActionAdded === 'function') {
      this.onActionAdded(action);
    }
  }
}

// 创建单例实例
const recordManager = new RecordManager();

// 支持CommonJS和全局变量两种导出方式
if (typeof module !== 'undefined' && module.exports) {
  module.exports = recordManager;
} else {
  window.recordManager = recordManager;
}