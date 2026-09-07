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

window.onload = async function () {
  await SettingsUI.init()
  main();
  // 调用 popup/autoFill.js → AutoFillUI.init
  AutoFillUI.init()
  // popup 打开时通知 content script 触发页面扫描
  await notifyPopupOpened()
  // popup 打开时自动开始录制（相当于自动点击"开始录制"按钮）
  document.getElementById('recordStartBtn').click()
}

/**
 * 通知 content script popup 已打开，触发页面元素扫描。
 * 调用位置：popup/index.js → window.onload
 */
async function notifyPopupOpened() {
  const tab = await getCurrentTab()
  if (tab && tab.id) {
    return await sendToContent(tab.id, { type: 'popupOpened' })
  }
  return null
}

const contentInjectionPromises = new Map()

async function ensureContentInjected(tabId) {
  if (contentInjectionPromises.has(tabId)) return contentInjectionPromises.get(tabId)
  const promise = (async () => {
    const tab = await chrome.tabs.get(tabId)
    if (tab.url && tab.url.startsWith('chrome-extension://')) {
      throw new Error('请先点击用户页面激活标签页')
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['/libs/utils.js', '/libs/autoFormFill.js', '/libs/smartSelector.js', '/libs/elementBusinessName.js', '/libs/myXPathHelper.js', '/config/scannerExclude.js', '/libs/elementGrouper.js', '/libs/pageElementScanner.js', '/content/recorder.js', '/content/treeSelectHandler.js', '/content/eventMonitor.js', '/content/messageHandler.js', '/content/replayer.js', '/content/pageElementScannerController.js', '/content/content.js']
    })
    await new Promise(resolve => setTimeout(resolve, 500))
  })()
  contentInjectionPromises.set(tabId, promise)
  try {
    await promise
  } finally {
    contentInjectionPromises.delete(tabId)
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
 * 获取录制来源标签页。popup 为独立窗口，优先使用后台在唤起时保存的来源标签页。
 * 调用位置：popup/autoFill.js → executeFill / popup/uploadService.js → downloadAllElements
 *           popup/index.js → initRecordControls / downloadAllElementsBtn
 */
async function getCurrentTab() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getPopupTargetTab' })
    if (response && response.tab && response.tab.id && response.tab.url && !response.tab.url.startsWith('chrome-extension://')) {
      return response.tab
    }
  } catch (e) {
    // 后台重启时使用原有活动标签页兜底逻辑。
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  for (const t of tabs) {
    if (t.url && !t.url.startsWith('chrome-extension://')) return t
  }
  const all = await chrome.tabs.query({ active: true })
  for (const t of all) {
    if (t.url && !t.url.startsWith('chrome-extension://')) return t
  }
  return null
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
        await ensureContentInjected(tabId)
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
  initReplayControls()
}

function initReplayControls() {
  $('#selectAllRecords').on('change', function () {
    RecordManager.selectAllVisibleRecords(this.checked)
  })
  $('#replayBtn').on('click', function () { ReplayService.start() })
  $('#cancelReplayBtn').on('click', function () {
    if (confirm('取消后将停止后续操作，已经执行的页面操作不会自动回滚，是否继续？')) ReplayService.stop()
  })
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
      console.warn('发送消息失败:', e.message)
    }
  }

  // 开始录制：发送 startRecording 消息并切换 UI 为录制中
  async function startRecording() {
    const tab = await getCurrentTab()
    if (!tab || !tab.id) return
    await initializePageId(tab.id)
    const resp = await sendToContent(tab.id, { type: 'startRecording' })
    if (resp) setRecordingUI('recording')
  }

  //点击开始按钮
  startBtn.addEventListener('click', startRecording)

  //点击停止按钮
  stopBtn.addEventListener('click', async () => {
    const resp = await sendToTab('stopRecording')
    if (resp) setRecordingUI('idle')
  })

  // 暂停录制：暂停按钮和回放验证开始前共用此处理逻辑。
  async function pauseRecording() {
    const resp = await sendToTab('pauseRecording')
    if (resp) setRecordingUI('paused')
    return resp
  }

  window.pauseRecording = pauseRecording
  pauseBtn.addEventListener('click', pauseRecording)

  //点击继续按钮
  continueBtn.addEventListener('click', async () => {
    const resp = await sendToTab('continueRecording')
    if (resp) setRecordingUI('recording')
  })
}

/** 在一次录制开始时读取组件编号；无有效值时生成回退 pageId。 */
async function initializePageId(tabId) {
  if (RecordManager.pageId) return RecordManager.pageId
  const response = await sendToContent(tabId, { type: 'getTianyuanComponentId' })
  const componentId = response && response.componentId ? String(response.componentId).trim() : ''
  RecordManager.pageId = componentId || Utils.generatePageId()
  return RecordManager.pageId
}

/**
 * 初始化底部操作按钮（重录/下载/提交）。
 * 调用位置：popup/index.js → main
 */
function initBottomActions() {
  //重录, 调用 popup/recordManager.js → RecordManager.clearAll
  $('#clearBtn').click(async function () {
    if (!confirm('确定重录所有操作吗？此操作无法撤销。')) return

    RecordManager.clearAll()
    // 重录时通知 content script 清空扫描结果并重新全量扫描
    const tab = await getCurrentTab()
    if (tab && tab.id) {
      await initializePageId(tab.id)
      sendToContent(tab.id, { type: 'clearAndRescan' })
    } else {
      RecordManager.pageId = Utils.generatePageId()
    }
  })

  // 调用 popup/uploadService.js → UploadService.downloadActionsJson
  $('#downloadJsonBtn').click(function () {
    openDownloadDialog('json')
  })

  // 调用 popup/uploadService.js → UploadService.downloadActionsTxt
  $('#downloadTxtBtn').click(function () {
    openDownloadDialog('txt')
  })

  $('#closeDownloadNameBtn, #cancelDownloadNameBtn').click(closeDownloadDialog)
  $('#confirmDownloadNameBtn').click(confirmDownload)
  $('#downloadNameInput').on('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault()
      confirmDownload()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeDownloadDialog()
    }
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

let pendingDownloadFormat = ''

function openDownloadDialog(format) {
  pendingDownloadFormat = format
  const dialog = document.getElementById('downloadNameDialog')
  const input = document.getElementById('downloadNameInput')
  const error = document.getElementById('downloadNameError')
  if (!dialog || !input) return
  input.value = ''
  if (error) error.textContent = ''
  dialog.classList.add('open')
  dialog.setAttribute('aria-hidden', 'false')
  input.focus()
}

function closeDownloadDialog() {
  const dialog = document.getElementById('downloadNameDialog')
  if (!dialog) return
  dialog.classList.remove('open')
  dialog.setAttribute('aria-hidden', 'true')
  pendingDownloadFormat = ''
}

function confirmDownload() {
  const input = document.getElementById('downloadNameInput')
  const error = document.getElementById('downloadNameError')
  const name = input ? input.value.trim() : ''
  if (!name) {
    if (error) error.textContent = '请输入下载文件名称'
    if (input) input.focus()
    return
  }
  if (/[\\/:*?"<>|]/.test(name)) {
    if (error) error.textContent = '名称不能包含 \\ / : * ? " < > |'
    if (input) input.focus()
    return
  }
  const format = pendingDownloadFormat
  closeDownloadDialog()
  if (format === 'json') UploadService.downloadActionsJson(name)
  if (format === 'txt') UploadService.downloadActionsTxt(name)
}

// ==================== 接收来自 content 的录制消息 ====================
// 调用 popup/recordManager.js → RecordManager.handleMessage
let scanStatusTimer = null

function updateScanStatus(data) {
  const el = document.getElementById('scanStatus')
  if (!el || !data) return

  clearTimeout(scanStatusTimer)
  el.classList.add('visible')

  if (data.status === 'scanning') {
    el.textContent = '正在扫描页面元素...'
    el.classList.add('scanning')
    return
  }

  el.textContent = '已扫描 ' + (data.count || 0) + ' 个元素'
  el.classList.remove('scanning')
  scanStatusTimer = setTimeout(() => {
    el.classList.remove('visible')
  }, 2000)
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scanStatus') {
    updateScanStatus(message.data)
    return
  }
  if (message.type === 'replayProgress' || message.type === 'replayComplete' || message.type === 'replayStarted') {
    ReplayService.handleMessage(message)
    return
  }
  RecordManager.handleMessage(message)
})
