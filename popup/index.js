/**
 * popup/index.js — Popup 弹窗入口文件
 * 负责初始化各模块、录制控制按钮逻辑、提供全局通信工具函数、
 * 接收来自 content 的录制消息并分发到 RecordManager。
 *
 * 依赖模块（由 index.html 保证加载顺序）：
 *   - RecordManager (popup/recordManager.js)  — 录制数据管理
 *   - AutoFillUI (popup/autoFill.js)          — 自动填表 UI
 *   - UploadService (popup/uploadService.js)  — 上传/下载服务
 */

window.onload = function () {
  main();
  // 调用 popup/autoFill.js → AutoFillUI.init
  AutoFillUI.init()
  // popup 打开时通知 content script 触发页面扫描
  notifyPopupOpened()
}

/**
 * 通知 content script popup 已打开，触发页面元素扫描。
 * 调用位置：popup/index.js → window.onload
 */
async function notifyPopupOpened() {
  const tab = await getCurrentTab()
  if (tab && tab.id) {
    sendToContent(tab.id, { type: 'popupOpened' })
  }
}

/**
 * 通知 content script popup 即将关闭，停止 DOM 监听并清理扫描结果。
 * 调用位置：popup/index.js → window.onbeforeunload
 */
async function notifyPopupClosed() {
  const tab = await getCurrentTab()
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'popupClosed' }).catch(() => {
      // 忽略页面不可用的情况
    })
  }
}

// popup 关闭时发送通知（作为 background onRemoved 的兜底）
window.addEventListener('beforeunload', notifyPopupClosed)

/**
 * HTML 转义工具函数，防止 XSS。
 * 调用位置：popup/recordManager.js → renderRecordList / popup/autoFill.js → addFillLog
 */
function escHtml(s) {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 获取当前活动标签页（排除扩展自身页面）。
 * 调用位置：popup/autoFill.js → executeFill / popup/uploadService.js → downloadAllElements
 *           popup/index.js → initRecordControls / downloadAllElementsBtn
 */
async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  for (const t of tabs) {
    if (t.url && !t.url.startsWith('chrome-extension://')) return t
  }
  const all = await chrome.tabs.query({ active: true })
  for (const t of all) {
    if (t.url && !t.url.startsWith('chrome-extension://')) return t
  }
  return tabs[0]
}

/**
 * 向 content script 发送消息，若 content 未注入则尝试自动注入。
 * 调用位置：popup/autoFill.js → executeFill / popup/uploadService.js → downloadAllElements
 */
async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch (e) {
    if (e.message.includes('Receiving end does not exist')) {
      try {
        const tab = await chrome.tabs.get(tabId)
        if (tab.url && tab.url.startsWith('chrome-extension://')) {
          // 调用 popup/autoFill.js → AutoFillUI.addFillLog
          AutoFillUI.addFillLog({ type: 'error', text: '请先点击用户页面激活标签页' })
          return null
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['/libs/utils.js', '/libs/autoFormFill.js', '/libs/smartSelector.js', '/libs/elementBusinessName.js', '/libs/myXPathHelper.js', '/config/scannerExclude.js', '/libs/pageElementScanner.js', '/content/recorder.js', '/content/treeSelectHandler.js', '/content/eventMonitor.js', '/content/messageHandler.js', '/content/pageElementScannerController.js', '/content/content.js']
        })
        await new Promise(r => setTimeout(r, 500))
        return await chrome.tabs.sendMessage(tabId, message)
      } catch (e2) {
        // 调用 popup/autoFill.js → AutoFillUI.addFillLog
        AutoFillUI.addFillLog({ type: 'error', text: '注入失败: ' + e2.message })
      }
    } else {
      // 调用 popup/autoFill.js → AutoFillUI.addFillLog
      AutoFillUI.addFillLog({ type: 'error', text: '通信错误: ' + e.message })
    }
    return null
  }
}

/**
 * 主入口：初始化录制控制按钮和编辑绑定。
 */
async function main() {
  initRecordControls() //初始化录制控制按钮（开始/停止/暂停/继续）
  // 调用 popup/recordManager.js → RecordManager.initEditBindings
  RecordManager.initEditBindings()
  initBottomActions()
}

/**
 * 初始化录制控制按钮（开始/停止/暂停/继续）。
 * 调用位置：popup/index.js → main
 */
function initRecordControls() {
  const startBtn = document.getElementById('recordStartBtn')
  const stopBtn = document.getElementById('recordStopBtn')
  const pauseBtn = document.getElementById('recordPauseBtn')
  const continueBtn = document.getElementById('recordContinueBtn')

  function setRecordingUI(state) {
    startBtn.style.display = 'none'
    stopBtn.style.display = 'none'
    pauseBtn.style.display = 'none'
    continueBtn.style.display = 'none'
    if (state === 'idle') { startBtn.style.display = 'inline-block' }
    else if (state === 'recording') { stopBtn.style.display = 'inline-block'; pauseBtn.style.display = 'inline-block' }
    else if (state === 'paused') { stopBtn.style.display = 'inline-block'; continueBtn.style.display = 'inline-block' }
  }

  async function sendToTab(type) {
    const tab = await getCurrentTab()
    if (!tab || !tab.id) return
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type })
      return resp
    } catch (e) {
      console.log('发送消息失败:', e.message)
    }
  }

  //点击开始按钮
  startBtn.addEventListener('click', async () => {
    const resp = await sendToTab('startRecording')
    if (resp) setRecordingUI('recording')
  })

  //点击停止按钮
  stopBtn.addEventListener('click', async () => {
    const resp = await sendToTab('stopRecording')
    if (resp) setRecordingUI('idle')
  })

  //点击暂停按钮
  pauseBtn.addEventListener('click', async () => {
    const resp = await sendToTab('pauseRecording')
    if (resp) setRecordingUI('paused')
  })

  //点击继续按钮
  continueBtn.addEventListener('click', async () => {
    const resp = await sendToTab('continueRecording')
    if (resp) setRecordingUI('recording')
  })
}

/**
 * 初始化底部操作按钮（重录/下载/提交）。
 * 调用位置：popup/index.js → main
 */
function initBottomActions() {
  // 调用 popup/recordManager.js → RecordManager.clearAll
  $('#clearBtn').click(async function () {
    RecordManager.clearAll()
    // 重录时通知 content script 清空扫描结果并重新全量扫描
    const tab = await getCurrentTab()
    if (tab && tab.id) {
      sendToContent(tab.id, { type: 'clearAndRescan' })
    }
  })

  // 调用 popup/uploadService.js → UploadService.downloadActions
  $('#downloadBtn').click(function () {
    UploadService.downloadActions()
  })

  // 调用 popup/uploadService.js → UploadService.downloadAllElements
  $('#downloadAllElementsBtn').click(async function () {
    await UploadService.downloadAllElements()
  })

  // 调用 popup/uploadService.js → UploadService.submitRecordUpload
  $('#submitBtn').click(function () {
    UploadService.submitRecordUpload()
  })
}

// ==================== 接收来自 content 的录制消息 ====================
// 调用 popup/recordManager.js → RecordManager.handleMessage
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  RecordManager.handleMessage(message)
})
