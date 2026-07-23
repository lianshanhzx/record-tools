
const data = {
  currTabId: '',
  url: ''
}

let monitorStates = {}

let ty_atp_data = null 

let recordActionList = [] //录制的操作

chrome.runtime.onInstalled.addListener(() => {
    console.log("我被安装啦！")
});


//打开弹窗
async function openOpertePopup(safeLeft) {
   const windows = await chrome.windows.getAll();
   const popupExists = windows.some(win => win.type === 'popup');

  // let offsetLeft = tab.width - 520 - 60
  let offsetLeft = 100

  let opts = {
    // height: 750,
    // width: 520,
    height: 500,
    width: 1000,
    left: offsetLeft, // 设置窗口的初始位置在屏幕的左边100像素处
    top: safeLeft || 100 ,
  };

  if (!popupExists) {
    //如果不存在弹窗,则创建一个弹窗
    chrome.windows.create(
      Object.assign(
        {
          url: chrome.runtime.getURL('web/index.html'),
          type: 'popup',
          focused: true,
        },
        opts
      )
    );
  } else {
    console.log('已经有弹窗了')
    // 可选：将现有弹窗带到前面
    const popup = windows.find(win => win.type === 'popup');
    chrome.windows.update(popup.id, { focused: true });
  }
}

//停止录制,并将录制的信息发送到弹窗页面
async function handleStopRecord() { 
  // let views = chrome.extension.getViews()
  const views = await chrome.windows.getAll();
  if (views && views.length >= 2) {
    // var popup = views[1]
    const popup = views.find(win => win.type === 'popup');

    console.log('popup: ', popup)
    
    // let zdhDataStr = localStorage.getItem('ty_zdh_data');
    // let zdhData = JSON.parse(zdhDataStr)
    // popup.setZDHdata(zdhData)//设置自动化系统信息

    // popup.getRecorderInfo(message.data,data.url);
    // popup.getRecorderInfo(recordActionList,data.url);
    // chrome.tabs.remove(sender.tab.id);
    // popup.saveAsBlobFile(popup.txt2Blob(action2Json(message.data, data.url)), "result.txt")
    let message = {
      type: 'getRecorderInfo' , 
      url:data.url,
      recordActionList:recordActionList
    }
    chrome.runtime.sendMessage(popup.id, message, function (response) { 
      console.log('---runtime--recordActionList--', response)

    })

    // chrome.tabs.sendMessage(popup.id, recordActionList, function (response) {
    //   if (chrome.runtime.lastError) {
    //     setTimeout(_send, 500);
    //     return;
    //   }
    //   if (callback)
    //     callback(response);
    // });

    //  chrome.tabs.remove(sender.tab.id);
  }
}


//监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('---监听消息---',message , sender)


  let requestType = message.type;
  if (requestType === "openPopup") {

     chrome.windows.getCurrent((currentWindow) => {
      const popupWidth = 1000;
      const rightMargin = 100;
        
      // 计算左侧位置使窗口靠右100px
      const leftPosition = currentWindow.width + currentWindow.left- popupWidth - rightMargin;
      
      // 边界检查，确保不会超出屏幕
      const safeLeft = Math.max(100, leftPosition);

      // console.log('safeLeft: ', safeLeft)
      // 打开弹出窗口
      openOpertePopup(safeLeft)
    })
  }
 
  if (requestType == 'stopRecord') {
     console.log('stop Record.....',recordActionList)
    //  chrome.tabs.remove(sender.tab.id)
    // handleStopRecord() ; //直接放在index.html 页面中监听 , 后台页面不需要处理了

    const tabId = sender.tab.id
    delete monitorStates[tabId]
  }

  // if(requestType == 'addActionData'){
  //   console.log('---addActionData---',message.data)
  //   recordActionList.push(message.data)
  // }

  if (requestType == 'runRecord') {

    // console.log('run Record.....')
  }
  if (requestType == 'pauseRecord') {

    // console.log('pause Record.....')
  }
  if (requestType == 'checkFlag') {

    // console.log('---checkFlag---',message.url)
    
    window.open(message.url)
    sendMessageToContentScript({ type: 'start', url: message.url })
  } else if (requestType === 'execute') {

    // console.log('---execute---',requestType)
    //开始
    data.currTabId = message.tabId
    data.url = message.url
    recordActionList = [] //开始清掉原来录制的数据

    // if (data.currTabId) {
    //   chrome.tabs.sendMessage(data.currTabId, { type: 'start' })
    // }

  } else if (requestType === 'refresh') {
    // console.log('---refresh---',requestType)
    if (data.currTabId) {
      chrome.tabs.sendMessage(data.currTabId, { type: 'start' })
    }
  } else if(requestType === 'startRecord'){
    //开始录制
    const tabId = sender.tab.id
    monitorStates[tabId] = true

  }else if(requestType === 'initMonitor'){
    const tabId = sender.tab.id
    const tabMonitorStates = monitorStates[tabId] || false 

    console.log('---initMonitor---',tabMonitorStates)
    sendResponse({'monitorStates':tabMonitorStates})
    
  }


  return true
});



// 如果manifest.json未配置 action.default_popup，点击扩展按钮会触发此事件
chrome.action.onClicked.addListener(async (tab) => {
  openOpertePopup()
});



// chrome.action.onClicked.addListener(async (tab) => {
//   const windows = await chrome.windows.getAll();
//   const popupExists = windows.some(win => win.type === 'popup' && win.tabs[0].url.includes('popup.html'));
  
//   if (!popupExists) {
//     chrome.windows.create({
//       url: "popup.html",
//       type: "popup",
//       width: 400,
//       height: 600
//     });
//   } else {
//     // 可选：将现有弹窗带到前面
//     const popup = windows.find(win => win.type === 'popup');
//     chrome.windows.update(popup.id, { focused: true });
//   }
// });




/**
 * 获取本地文件地址
 * @param {*} path 
 * @returns 
 */
function getDataUrl(path) {
  let data = chrome.runtime.getURL(path)
  return data;
}

// 获取当前选项卡ID
function getCurrentTabId(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (callback)
      callback(tabs.length ? tabs[0].id : null);
  });
};


/**
 * 将action转换为json
 * @param {*} actions
 * @param url
 */
function action2Json(actions, url) {
  let json = {
    id: uuid(),
    name: 'test',
    url: url,
    tests: [
      {
        id: uuid(),
        name: 'test',
        commands: [],
      }
    ]
  }
  if (actions) {
    for (var i = 0; i < actions.length; i++) {
      if (!actions[i].propertiesName) continue
      json.tests[0].commands.push(actions[i])
    }
  }
  return JSON.stringify(json);
}
/**
 * 生成唯一id
 * @returns
 */
function uuid() {
  let s = [];
  let hexDigits = "0123456789abcdef";
  for (let i = 0; i < 36; i++) {
    s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
  }
  s[14] = "4";  // bits 12-15 of the time_hi_and_version field to 0010
  s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);  // bits 6-7 of the clock_seq_hi_and_reserved to 01
  s[8] = s[13] = s[18] = s[23] = "-";
  return s.join("");
}

// 向标签中的content_script发送消息
function sendMessageToContentScript(message, callback) {
  getCurrentTabId((tabId) => {
    alert('----向标签中的content_script发送消息-----')
    let _send = function () {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        if (chrome.runtime.lastError) {
          setTimeout(_send, 500);
          return;
        }
        if (callback)
          callback(response);
      });
    }
    _send();
  });
};


chrome.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
  console.log('---runtime--recordActionList--', request)
  ty_atp_data = JSON.stringify(request); //保存数据
  chrome.storage.sync.set({ tyAtpData: ty_atp_data}) 

  openOpertePopup() //打开弹窗页面

});

// ========== 自动填表 LLM 集成 ==========

const AUTO_FILL_SYSTEM_PROMPT = `你是一个表单填写助手。根据用户指令和当前页面的表单字段列表，返回 JSON 动作数组。

可用动作（只使用这几种，不要使用其他名称）：
1. fill_form_field — 填写输入框，参数 { "action": "fill_form_field", "label": "字段标签", "value": "要填的值" }
2. fill_date_field — 填写日期类型，参数 { "action": "fill_date_field", "label": "字段标签", "value": "要填的值" }
3. click_element_by_index — 点击元素旁边的按钮（仅用于用户未提供值、需要通过弹窗/选择器选择的情况），参数 { "action": "click_element_by_index", "label": "字段标签" }
4. select_option — 选中下拉框，参数 { "action": "select_option", "label": "字段标签", "option": "要选的选项" }
5. select_tree_option — 选中树选择类型，参数 { "action": "select_tree_option", "label": "字段标签", "option": "要选的选项" }

【核心规则 — 必须严格遵守】
1. 对每个字段都必须返回一个动作，动作数量必须等于字段数量（除非 options 为空或已有值或 disabled，见下方规则）
2. 如果字段已经有值（currentValue 非空），则跳过该字段（不生成动作）
3. 如果字段 disabled 为 true，则跳过该字段（不生成动作）
4. ★★★ 如果用户指令中明确提供了某个字段的值，无论该字段是否有按钮(hasButton)，都必须使用 fill_form_field 直接填写输入框，绝对不要使用 click_element_by_index ★★★
5. 只有当用户没有提供某个字段的值，且该字段 hasButton 为 true 时，才使用 click_element_by_index 去点击按钮打开选择器
6. 用户指定了值的字段，必须使用用户指定的值
7. 用户未指定的字段，你自主决定
8. selected 为 true 的字段表示下拉框已有选中值，跳过
9. kind 为 'radio' 或 'checkbox' 的字段，从 options 中选一个合理的选项

【下拉框规则 (Element UI el-select)】
- select_option 的 option 必须从该字段的 options 列表中选取
- options 列表是通过 Vue 组件实例读取到的真实选项，不是通过打开下拉框获取的
- 若 options 列表为空（[]），但用户指令中明确提供了该字段的值，仍然生成 select_option 动作，option 使用用户提供的值（系统会尝试打开下拉框并匹配）
- 若 options 列表为空且用户也未提供值，则跳过该字段（不生成动作）

【输入框规则】
- 标签包含"姓名"→生成常见中文姓名（如"测试科技张三"）
- 标签包含"手机""电话"→生成11位手机号（如"13800138000"）
- 标签包含"身份证"→生成18位身份证号
- 标签包含"邮箱""Email"→生成合法邮箱
- 标签包含"金额""收入"→生成合理数值（如"5000"）
- 标签包含"地址"→生成完整中文地址
- 标签包含"邮编"→生成6位数字
- 标签包含"证件号码"→若当前值不为空，跳过；否则生成18位身份证号
- 标签包含"编号"→生成合理编号（如"KH20240001"）
- 其他输入框用合理的中文测试数据填充

【容器规则】
- 返回的字段列表只包含当前对话框/抽屉内的字段，无需考虑其他位置的字段

示例：
输入字段：label:"客户名称",kind:input | label:"客户状态",kind:select,options:["正式","潜在"] | label:"证件类型",kind:select,options:["身份证","护照","营业执照"]
指令：随机填写
返回：[{"action":"fill_form_field","label":"客户名称","value":"北京测试科技有限公司"},{"action":"select_option","label":"客户状态","option":"潜在"},{"action":"select_option","label":"证件类型","option":"身份证"}]`

function buildUserPrompt(fields, instruction) {
  let fieldLines = fields.map((f, i) => {
    let line = `${i + 1}. label: "${f.label}", kind: ${f.kind}`
    if (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkbox') {
      line += `, options: [${(f.options || []).map(o => `"${o}"`).join(', ')}]`
    }
    if (f.placeholder && f.placeholder !== '请选择' && f.placeholder !== '请输入') line += `, placeholder: "${f.placeholder}"`
    if (f.required) line += `, required: true`
    if (f.disabled) line += `, disabled: true`
    if (f.currentValue) line += `, currentValue: "${f.currentValue}"`
    if (f.selected) line += `, selected: true`
    if (f.hasButton) line += `, hasButton: true (该字段旁边有按钮，如"获取地址"，但用户提供了值时应直接填写输入框)`
    return line
  }).join('\n')
  return `当前页面的表单字段：\n${fieldLines}\n\n用户指令：${instruction}`
}

async function callLLM(config, fields, instruction) {
  const prompt = buildUserPrompt(fields, instruction)
  console.log('[自动填表] 发送给LLM的字段:', JSON.stringify(fields, null, 2))
  console.log('[自动填表] 用户指令:', instruction)
  console.log('[自动填表] LLM Prompt:\n' + prompt)
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: AUTO_FILL_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      response_format: { type: 'json_object' },
      thinking: { type: config.thinking || 'disabled' }
    })
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM API error ${response.status}: ${err}`)
  }
  const data = await response.json()
  const content = data.choices[0].message.content
  console.log('[自动填表] LLM 原始响应:', content)
  let parsed = JSON.parse(content)
  if (parsed.actions) parsed = parsed.actions
  console.log('[自动填表] 解析后的动作:', JSON.stringify(parsed, null, 2))
  return { actions: parsed, rawPrompt: prompt, rawResponse: content }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'callLLM') {
    const { fields, instruction } = message
    const defaults = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: '', temperature: 0.1, maxTokens: 4096, thinking: 'disabled' }
    chrome.storage.sync.get('atpFormConfig', (res) => {
      const config = Object.assign({}, defaults, res.atpFormConfig || {})
      if (!config.apiKey) {
        sendResponse({ error: '请先配置 API Key（点击设置按钮配置）' })
        return
      }
      callLLM(config, fields, instruction)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }))
    })
    return true
  }
})


