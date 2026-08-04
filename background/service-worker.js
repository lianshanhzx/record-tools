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
let monitorStates = {}

// 这些消息的目标是 Popup，Background 无需处理，短路返回避免穿透所有分支
const SKIP_IN_BG = ['addActionData', 'actionProgress', 'actionComplete']

// ==================== 消息路由 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('---监听消息---', message, sender)

  let requestType = message.type;

  // 高频广播消息短路返回（目标为 Popup，Background 无需处理）
  if (SKIP_IN_BG.includes(requestType)) return true

  // 停止录制 → 清除该标签页的录制标记
  if (requestType == 'stopRecord') {
    const tabId = sender.tab.id
    delete monitorStates[tabId]
  } else if (requestType === 'startRecord') {
    // 开始录制 → 标记该标签页正在录制
    const tabId = sender.tab.id
    monitorStates[tabId] = true
  } else if (requestType === 'initMonitor') {
    // 查询录制状态 → 返回标签页是否正在录制
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
