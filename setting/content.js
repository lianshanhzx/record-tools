// document.addEventListener('click', function(event) {
//   // 阻止事件冒泡到document，这样可以防止点击其他地方关闭窗口
//   console.log('event--1111--: ', event)
//   event.stopPropagation();
// });





chrome.runtime.sendMessage({type: "initMonitor"}, (response) => {
  if (response && response.monitorStates) {
    startRecordEvent()
  }
})



/**
 * 监控页面变化
 */
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

  _docu: null,

  getActions() {

    console.log('----getActions-----',this.actions)
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
      if (listenDomList.length > 0) {
        listenDomList.forEach(item => {
          item.removeAttribute('isonclick')
          item.removeAttribute('isonclicked')
          item.removeEventListener('click',this.listenerHandle)
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
    // console.log('----element-----',element)
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
  /**
   * 序列化
   * @param {*} parent 
   * @returns 
   */
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
  /**
   * 将元素解析成可序列化的对象
   */
  parseElement(element, id) {
    let attributes = {};
    for (const { name, value } of Array.from(element.attributes)) {
      attributes[name] = value;
    }
    if (!id) {                         //解析新元素才做映射
      id = this.getID();
      this.idMap.set(element, id);     //元素为键，ID为值
    }

    let labelChName = getChineseLabelByElement(element)

    labelChName =  labelChName?.replace(/[^\w\d\u4e00-\u9fa5]/g, '');
    // let labelChName = getElementLabelName(element)

    //相对路劲xpath
    let xp = new SmartSelector(element).getSelector();

    return {
      // children: [],
      id: id,
      command: element['command'],
      // xpath: xp,
      target: xp,
      targetType: 'xpath',
      tagName: element.tagName.toLowerCase(),
      propertiesName: labelChName || '',
    
      attributes: attributes
    };
  },
  /**
   * 生成唯一id
   * @returns 
   */
  uuid() {
    var s = [];
    var hexDigits = "0123456789abcdef";
    for (var i = 0; i < 36; i++) {
      s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
    }

    s[14] = "4";  // bits 12-15 of the time_hi_and_version field to 0010
    s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);  // bits 6-7 of the clock_seq_hi_and_reserved to 01
    s[8] = s[13] = s[18] = s[23] = "-";

    var uuid = s.join("");
    return uuid;

  },

  /**
   * 唯一标识
   */
  getID() {
    return this.uuid();
  },
  /**
   * 配置修改属性的动作
   */
  setAttributeAction(element) {
    let attributes = {
      type: ACTION_TYPE_ATTRIBUTE
    };
    // element.value && (attributes.value = element.value);
    attributes.value = element.value || ''
    this.setAction(element, attributes);
  },



  /**
   * 配置修改动作
   */
  setAction(element, otherParam = {}) {
    // console.log('---setAction---',element, otherParam);
    
    //由于element是对象，因此Map中的key会自动更新
    const id = this.idMap.get(element);
    const action = Object.assign(
      this.parseElement(element, id),
      { timestamp: Date.now() },
      otherParam
    );
    //补丁, 偶尔有些情况下command 会存在于attributes 中 , 暂时找出好的方法, 后面优化
    action.command = action.command || action.attributes.command
    
    currId = action.id
    this.getLableValue(element)


    const lastAction = this.actions[this.actions.length - 1] ;
    if(this.actions.length > 0 && lastAction.command == 'select' && element.command == 'selectOption'){
      // lastAction.value = element.value
      let lastEle = null
      if(lastAction.targetType == 'xpath'){
        lastEle = XPathHelper.$(lastAction.target)
      }else if(lastAction.targetType == 'css'){
        lastEle = document.querySelector(lastAction.target)
      }
      setTimeout(() => {
        // console.log('--lastEle-00--',lastEle ,lastEle.value)
        if(lastEle && lastEle.value){
          lastAction.value = lastEle.value
            // console.log('--lastEle--111-',lastAction) 
        }else{
          const selectEle = lastEle.closest(".el-select")
          const multiEles = selectEle.querySelectorAll(".el-select__tags-text")

          // console.log('--multiEles---',multiEles)
          let selectValueArr = []
          if(multiEles && multiEles.length > 0 ){
            multiEles.forEach(item => {
              if(item.innerText){
                selectValueArr.push(item.innerText)
              }
            })
            lastAction.value = selectValueArr.join(',')
          }
        }

        this.actions[this.actions.length - 1] = lastAction

        // console.log('--lastAction--',lastAction)

        //防止跳页和iframe切换问题,将每一步的操作都保存到弹窗页面中
       sendBackMessage('addActionData', lastAction);

      }, 100);
     
    } else{

      // console.log('--22-actions--',action)

      this.actions.push(action);//
      //防止跳页和iframe切换问题,将每一步的操作都保存到弹窗页面中
      sendBackMessage('addActionData', action);
    }
  },


  //获取input的label
  getInputLabel(input) {
    // console.log('---getInputLabel------',input);
  },



  //监听dom变化
  listener(document) {

    console.log('---listener---',document);

    this._docu = document;
    //捕获input事件
    this._docu.addEventListener("change", event => {
      const { target } = event;
      // console.log('---input-----',target)
      target.command = 'input'
      target.label = this.getInputLabel(target)
      target.commandCnStr = '输入'
      // target.commandCnStrJson = target
      this.setAttributeAction(target);
    }, {
      capture: true
    });


    this._docu.addEventListener("click", event => {
      const { target } = event;
      // console.log('---click-----',target)

      const selectEle = target.closest(".el-select"); //下拉选择框
      const selectOptionEle = target.closest(".el-select-dropdown__item"); //下拉选项
      if(selectEle){
        selectInputEle = selectEle.querySelector('input')
        selectInputEle.command = 'select' 
        selectInputEle.commandCnStr = '下拉框xpath选择'

        // console.log('---selectInputEle-----',selectEle)
        this.setAttributeAction(selectInputEle);

      }else if(selectOptionEle){
        selectOptionEle.command = 'selectOption'
        selectOptionEle.commandCnStr = '下拉框xpath选择'

        // console.log('---selectInputEle-----',selectOptionEle)
        this.setAttributeAction(selectOptionEle);
      
      }else{
        target.command = 'click'
        target.commandCnStr = '点击'

        // console.log('---setAttributeAction-----',target)
        this.setAttributeAction(target);
      }
      
    }, {
      capture: true
    });
  }
}






//开始录制
function startRecordEvent() {
  const startUrl = window.location.href;
  sendBackMessage('startRecord', startUrl);
  _snapshot.listener(document)
}

//继续录制
function continueRecordEvent() {
  _snapshot.listener(document)
}

//暂停录制
function pauseRecordEvent(){
  const actions = _snapshot.getActions().map(item => {
    return {
      ...item,
      name: nameMap[item.id] || ''
    }
  })
  _snapshot.destroy()
  sendBackMessage('stopRecord', actions);
}

//停止录制
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


/**
 * 发信息给后台
 * @param {*} _type 
 * @param {*} data 
 */
function sendBackMessage(_type, data) {
  chrome.runtime.sendMessage({ type: _type, data: data, url: url }, (response) => {
  });
}



/**
 * 监听后端发送的数据
 */
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
            try { xpath = new SmartSelector(el).getSelector() } catch (e) {}
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

// chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
//   // listenDomMessage();
//   if (request.type === 'start') {

//   }
//   sendResponse('received')
//   // listenBackMessage();
// })
document.addEventListener('DOMContentLoaded', function () {
  console.log('DOMContentLoaded')
})

window.onload = () => {
  sendBackMessage('refresh', {})
}



 

// function listenDomMessage(){
//     window.addEventListener("message", function(e){
//         if(e.data&&e.data.type){
//             sendBackMessage(e.data.type, _snapshot.getActions());
//         }
//     }, false);
// }

// function listenBackMessage(){
//     chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
//         sendResponse('received')
//     })
// }