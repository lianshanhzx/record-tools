/**
 * messageHandler.js — 消息通信模块
 * 负责 content 侧与 popup / background 的消息收发。
 * 包含 sendBackMessage 统一封装、chrome.runtime.onMessage 消息路由、
 * window.onload 通知等。
 *
 * 依赖：
 *   - Recorder (content/recorder.js)
 *   - EventMonitor (content/eventMonitor.js)
 *   - AutoFormFill (libs/autoFormFill.js)
 *   - SmartSelector (libs/smartSelector.js)
 *   - PageElementScanner (libs/pageElementScanner.js)
 */

const MessageHandler = {

  /**
   * 向扩展运行时发送消息的统一封装。
   * 调用位置：content/recorder.js → setAction / monitorDateInput
   *           content/treeSelectHandler.js → handleTreeNodeClick
   *           content/content.js → startRecordEvent / pauseRecordEvent / stopRecordEvent
   */
  sendBackMessage(_type, data) {
    chrome.runtime.sendMessage({ type: _type, data: data }, (response) => {
    });
  }
}

let screenshotOriginalScrollBehavior = null

// ==================== 与 popup / background 的消息监听 ====================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 开始/恢复录制 → 调用 content.js → startRecordEvent
  if (request.type === 'start' || request.type === 'startRecording') {
    startRecordEvent();
    sendResponse({ status: 'started' });
    return true;
  }
  // 获取开始录制时扫描到的页面元素 → 读取 Recorder.scannedPageElements
  if (request.type === 'getScannedElements') {
    sendResponse({ elements: Recorder.scannedPageElements || [] });
    return true;
  }
  // 全页截图：由 popup 控制滚动，content 只负责页面坐标与滚动位置恢复。
  if (request.type === 'prepareFullPageScreenshot') {
    const root = document.documentElement
    const body = document.body
    screenshotOriginalScrollBehavior = root.style.scrollBehavior
    root.style.scrollBehavior = 'auto'
    sendResponse({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: Math.max(root.scrollWidth, body ? body.scrollWidth : 0, root.clientWidth),
      documentHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0, root.clientHeight),
      devicePixelRatio: window.devicePixelRatio || 1
    })
    return true
  }
  if (request.type === 'scrollForScreenshot') {
    window.scrollTo(request.x || 0, request.y || 0)
    // 两帧后响应，给布局、懒加载和浏览器绘制一次稳定机会。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(() => {
        const root = document.documentElement
        const body = document.body
        sendResponse({
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          documentHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0, root.clientHeight),
          viewportHeight: window.innerHeight
        })
      }, 180)
    }))
    return true
  }
  if (request.type === 'restoreScrollAfterScreenshot') {
    window.scrollTo(request.x || 0, request.y || 0)
    document.documentElement.style.scrollBehavior = screenshotOriginalScrollBehavior || ''
    screenshotOriginalScrollBehavior = null
    sendResponse({ ok: true })
    return true
  }
  // popup 关闭 → 移除所有 DOM 监听并清理录制状态，通知 background 清除标记
  if (request.type === 'popupClosed') {
    EventMonitor.unlistener()
    Recorder.destroy()
    MessageHandler.sendBackMessage('stopRecord', {})
    sendResponse({ status: 'popupClosed' })
    return true
  }
  // 停止录制 → 调用 content.js → stopRecordEvent
  if (request.type === 'stopRecording') {
    stopRecordEvent();
    sendResponse({ status: 'stopped' });
    return true;
  }
  // 暂停录制 → 调用 content.js → pauseRecordEvent
  if (request.type === 'pauseRecording') {
    pauseRecordEvent();
    sendResponse({ status: 'paused' });
    return true;
  }
  // 继续录制 → 调用 content.js → continueRecordEvent
  if (request.type === 'continueRecording') {
    continueRecordEvent();
    sendResponse({ status: 'continued' });
    return true;
  }
  // 自动填表：扫描表单字段 → 调用 libs/autoFormFill.js → AutoFormFill.scanFields
  if (request.type === 'scanFields') {
    const fields = AutoFormFill.scanFields()
    sendResponse({ fields })
    return true
  }
  // 自动填表：执行 LLM 返回的填表动作，并把成功动作追加到录制列表
  if (request.type === 'executeActions') {
    // 调用 libs/autoFormFill.js → AutoFormFill.executeActions
    AutoFormFill.executeActions(request.actions).then(results => {
      for (const r of results) {
        if (r.result === 'ok' || r.result.startsWith('ok')) {
          let xpath = ''
          // 调用 libs/autoFormFill.js → AutoFormFill.findElementByLabel
          const el = AutoFormFill.findElementByLabel(r.label, r.action)
          if (el && typeof SmartSelector !== 'undefined') {
            try { xpath = new SmartSelector(el).getSelector() } catch (e) { }
          }
          // 计算元素分组路径（弹窗/页签/折叠面板），供 popup 树形展示使用
          let group = []
          try {
            if (el && typeof ElementGrouper !== 'undefined') {
              group = ElementGrouper.getGroupPath(el)
            }
          } catch (e) { }
          // 调用 messageHandler.js → sendBackMessage
          chrome.runtime.sendMessage({
            type: 'addActionData',
            data: {
              command: r.action === 'fill_input' ? 'input' : 'select',
              target: xpath || ('label="' + r.label + '"'),
              targetType: xpath ? 'xpath' : 'label',
              tagName: el ? el.tagName.toLowerCase() : 'input',
              value: r.value || '',
              propertiesName: r.label || '',
              group: group,
              id: AutoFormFill._uuid(),
              timestamp: Date.now(),
              attributes: { value: r.value || '', type: 'ATTRIBUTE' }
            }
          })
        }
      }
      // 调用 messageHandler.js → sendBackMessage (通知完成)
      chrome.runtime.sendMessage({ type: 'actionComplete', data: results })
    })
    sendResponse({ started: true })
    return true
  }
})

// 页面加载完成后通知 background，便于其恢复录制状态
window.onload = () => {
  // 调用 messageHandler.js → sendBackMessage
  MessageHandler.sendBackMessage('refresh', {})
}
