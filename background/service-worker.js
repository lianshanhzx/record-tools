/**
 * service-worker.js — Background 入口文件
 * 负责消息路由、全局录制状态标记管理、外部消息监听。
 *
 * 依赖模块（通过 importScripts 加载）：
 *   - PopupManager (background/popupManager.js) — 弹窗管理
 *   - LLMService (background/llmService.js)     — LLM 调用服务
 */

importScripts('popupManager.js', 'llmService.js')

// ==================== 全局状态 ====================
const data = {
  currTabId: ''
}

let monitorStates = {}

// ==================== 消息路由 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('---监听消息---', message, sender)

  let requestType = message.type;

  // 打开 popup 弹窗 → 调用 background/popupManager.js → PopupManager.openOpertePopup
  if (requestType === "openPopup") {
    chrome.windows.getCurrent((currentWindow) => {
      const popupWidth = 1000;
      const rightMargin = 100;
      const leftPosition = currentWindow.width + currentWindow.left - popupWidth - rightMargin;
      const safeLeft = Math.max(100, leftPosition);
      PopupManager.openOpertePopup(safeLeft)
    })
  }

  // 停止录制 → 清除该标签页的录制标记
  if (requestType == 'stopRecord') {
    const tabId = sender.tab.id
    delete monitorStates[tabId]
  }

  if (requestType == 'checkFlag') {
    window.open(message.url)
  } else if (requestType === 'execute') {
    data.currTabId = message.tabId
  } else if (requestType === 'refresh') {
    if (data.currTabId) {
      chrome.tabs.sendMessage(data.currTabId, { type: 'start' })
    }
  } else if (requestType === 'startRecord') {
    const tabId = sender.tab.id
    monitorStates[tabId] = true
  } else if (requestType === 'initMonitor') {
    const tabId = sender.tab.id
    const tabMonitorStates = monitorStates[tabId] || false
    console.log('---initMonitor---', tabMonitorStates)
    sendResponse({ 'monitorStates': tabMonitorStates })
  }

  return true
});

// ==================== LLM 调用消息监听 ====================
// 调用 background/llmService.js → LLMService.callLLM
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
      LLMService.callLLM(config, fields, instruction)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }))
    })
    return true
  }
})

// ==================== 扩展图标点击 ====================
// 调用 background/popupManager.js → PopupManager.openOpertePopup
chrome.action.onClicked.addListener(async (tab) => {
  PopupManager.openOpertePopup()
});

// ==================== 外部消息监听 ====================
chrome.runtime.onMessageExternal.addListener(function (request, sender, sendResponse) {
  console.log('---runtime--recordActionList--', request)
  const ty_atp_data = JSON.stringify(request);
  chrome.storage.sync.set({ tyAtpData: ty_atp_data })
  // 调用 background/popupManager.js → PopupManager.openOpertePopup
  PopupManager.openOpertePopup()
});
