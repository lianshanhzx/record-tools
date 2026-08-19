/**
 * content.js — 录制入口文件
 * 负责初始化录制状态查询、组装各模块、管理录制生命周期。
 *
 * 依赖模块（由 manifest.json 保证加载顺序）：
 *   - Recorder (content/recorder.js)             — 录制核心状态与动作解析
 *   - TreeSelectHandler (content/treeSelectHandler.js) — 树形选择器处理
 *   - EventMonitor (content/eventMonitor.js)      — 页面事件监听
 *   - MessageHandler (content/messageHandler.js)  — 消息通信
 */

// 初始化时向后台查询当前标签页是否已被标记为"正在录制"，
// 若是，则自动恢复录制事件监听（用于刷新页面后继续录制）。
chrome.runtime.sendMessage({ type: "initMonitor" }, (response) => {
  if (response && response.monitorStates) {
    if (response.popupOpen && typeof PageElementScannerController !== 'undefined') {
      PageElementScannerController.onPopupOpened()
    }
    startRecordEvent()
  }
})

// ==================== 录制生命周期函数 ====================

/**
 * 开始录制：通知 popup 当前 URL，并注册事件监听。
 * 页面元素扫描由 PageElementScannerController 在 popup 打开时统一处理。
 * 调用位置：content/messageHandler.js → onMessage (start/startRecording)
 *           content/content.js → initMonitor 回调
 */
function startRecordEvent() {
  const startUrl = window.location.href;
  // 调用 messageHandler.js → sendBackMessage
  MessageHandler.sendBackMessage('startRecord', startUrl);

  // 调用 eventMonitor.js → listener
  EventMonitor.listener(document)
  if (typeof PageElementScannerController !== 'undefined') PageElementScannerController.resume()
}

/**
 * 继续录制：重新注册事件监听（暂停后会清理监听）。
 * 调用位置：content/messageHandler.js → onMessage (continueRecording)
 */
function continueRecordEvent() {
  MessageHandler.sendBackMessage('startRecord', window.location.href)
  // 调用 eventMonitor.js → listener
  EventMonitor.listener(document)
  if (typeof PageElementScannerController !== 'undefined') PageElementScannerController.resume()
}

/**
 * 暂停录制：把当前动作列表（含业务名称）回传 popup，并清理状态。
 * 调用位置：content/messageHandler.js → onMessage (pauseRecording)
 */
function pauseRecordEvent() {
  EventMonitor.unlistener()
  // 调用 recorder.js → destroy
  Recorder.destroy()
  if (typeof PageElementScannerController !== 'undefined') PageElementScannerController.pause()
  // 调用 messageHandler.js → sendBackMessage
  MessageHandler.sendBackMessage('stopRecord', {});
}

/**
 * 停止录制：与暂停逻辑一致，最终把动作列表回传。
 * 调用位置：content/messageHandler.js → onMessage (stopRecording)
 */
function stopRecordEvent() {
  EventMonitor.unlistener()
  // 调用 recorder.js → destroy
  Recorder.destroy()
  if (typeof PageElementScannerController !== 'undefined') PageElementScannerController.pause()
  // 调用 messageHandler.js → sendBackMessage
  MessageHandler.sendBackMessage('stopRecord', {});
}
