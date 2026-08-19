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
const RECORDING_TAB_IDS_KEY = 'recordingTabIds'

// 这些消息的目标是 Popup，Background 无需处理，短路返回避免穿透所有分支
const SKIP_IN_BG = ['addActionData', 'actionProgress', 'actionComplete', 'addScannedElements', 'scanStatus']
const SCREENSHOT_DOWNLOAD_IDS_KEY = 'screenshotDownloadIds'

async function clearPreviousScreenshots() {
  const stored = await chrome.storage.local.get(SCREENSHOT_DOWNLOAD_IDS_KEY)
  const downloadIds = stored[SCREENSHOT_DOWNLOAD_IDS_KEY] || []
  for (const downloadId of downloadIds) {
    try {
      await chrome.downloads.removeFile(downloadId)
    } catch (e) {
      // 文件可能已被用户移动或浏览器不允许删除，继续清理其下载记录。
    }
    try {
      await chrome.downloads.erase({ id: downloadId })
    } catch (e) {
      // 忽略已不存在的下载记录。
    }
  }
  await chrome.storage.local.remove(SCREENSHOT_DOWNLOAD_IDS_KEY)
}

// ==================== 消息路由 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let requestType = message.type;

  // 高频广播消息短路返回（目标为 Popup，Background 无需处理）
  if (SKIP_IN_BG.includes(requestType)) return false

  // 停止录制 → 清除该标签页的录制标记
  if (requestType == 'stopRecord') {
    const tabId = sender.tab.id
    delete monitorStates[tabId]
    chrome.storage.session.get(RECORDING_TAB_IDS_KEY).then(stored => {
      const ids = (stored[RECORDING_TAB_IDS_KEY] || []).filter(id => id !== tabId)
      return chrome.storage.session.set({ [RECORDING_TAB_IDS_KEY]: ids })
    })
  } else if (requestType === 'startRecord') {
    // 开始录制 → 标记该标签页正在录制
    const tabId = sender.tab.id
    monitorStates[tabId] = true
    chrome.storage.session.get(RECORDING_TAB_IDS_KEY).then(stored => {
      const ids = stored[RECORDING_TAB_IDS_KEY] || []
      if (!ids.includes(tabId)) ids.push(tabId)
      return chrome.storage.session.set({ [RECORDING_TAB_IDS_KEY]: ids })
    })
  } else if (requestType === 'initMonitor') {
    // 查询录制状态 → 返回标签页是否正在录制
    const tabId = sender.tab.id
    chrome.storage.session.get([RECORDING_TAB_IDS_KEY, 'popupTargetTabId']).then(stored => {
      const tabMonitorStates = monitorStates[tabId] || (stored[RECORDING_TAB_IDS_KEY] || []).includes(tabId)
      if (tabMonitorStates) monitorStates[tabId] = true
      
      sendResponse({
        monitorStates: tabMonitorStates,
        popupOpen: stored.popupTargetTabId === tabId
      })
    })
  }

  return requestType === 'initMonitor'
});

// popup 是独立窗口，无法可靠从最近焦点窗口推断录制网页，必须读取后台保存的来源标签。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getPopupTargetTab') {
    chrome.storage.session.get('popupTargetTabId').then(stored => {
      return stored.popupTargetTabId || PopupManager.targetTabId
    }).then(tabId => {
      if (!tabId) return null
      return chrome.tabs.get(tabId)
    })
      .then(tab => sendResponse({ tab }))
      .catch(() => sendResponse({ tab: null }))
    return true
  }
})

// ==================== 页面截图消息监听 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'captureVisibleTabForScreenshot') {
    chrome.tabs.captureVisibleTab(message.windowId, { format: 'png' })
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'trackScreenshotDownload') {
    chrome.storage.local.get(SCREENSHOT_DOWNLOAD_IDS_KEY).then(stored => {
      const ids = stored[SCREENSHOT_DOWNLOAD_IDS_KEY] || []
      ids.push(message.downloadId)
      return chrome.storage.local.set({ [SCREENSHOT_DOWNLOAD_IDS_KEY]: ids })
    }).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'untrackScreenshotDownload') {
    chrome.storage.local.get(SCREENSHOT_DOWNLOAD_IDS_KEY).then(stored => {
      const ids = (stored[SCREENSHOT_DOWNLOAD_IDS_KEY] || []).filter(id => id !== message.downloadId)
      return chrome.storage.local.set({ [SCREENSHOT_DOWNLOAD_IDS_KEY]: ids })
    }).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }
})

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
  const existingPopup = await PopupManager.findPopupWindow()
  if (!existingPopup) {
    try {
      await clearPreviousScreenshots()
    } catch (e) {
      console.warn('清理旧截图失败:', e)
    }
  }
  await PopupManager.openOpertePopup(undefined, tab && tab.id)
});

// ==================== 外部消息监听 ====================
chrome.runtime.onMessageExternal.addListener(function (request, sender, sendResponse) {
  const ty_atp_data = JSON.stringify(request);
  chrome.storage.sync.set({ tyAtpData: ty_atp_data })
  PopupManager.findPopupWindow()
    .then(async existingPopup => {
      if (!existingPopup) await clearPreviousScreenshots()
      let targetTabId = sender.tab && sender.tab.id
      if (!targetTabId) {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        targetTabId = tabs[0] && tabs[0].id
      }
      return PopupManager.openOpertePopup(undefined, targetTabId)
    })
    .catch(error => console.warn('外部消息唤起弹窗失败:', error))
});

// 标签页关闭时清理会话录制标记，避免残留状态影响后续标签页。
chrome.tabs.onRemoved.addListener((tabId) => {
  delete monitorStates[tabId]
  chrome.storage.session.get(RECORDING_TAB_IDS_KEY).then(stored => {
    const ids = (stored[RECORDING_TAB_IDS_KEY] || []).filter(id => id !== tabId)
    return chrome.storage.session.set({ [RECORDING_TAB_IDS_KEY]: ids })
  })
})
