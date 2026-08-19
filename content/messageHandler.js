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

let screenshotScrollState = null

const SCREENSHOT_DIALOG_SELECTORS = [
  '.el-dialog__wrapper', '.el-dialog',
  '.el-drawer__wrapper', '.el-drawer',
  '.ant-modal-wrap', '.ant-modal',
  '.ivu-modal-wrap', '.ivu-modal',
  '.modal[role="dialog"]', '.modal[aria-modal="true"]', '.modal-dialog',
  '.drawer', '.dialog', '[role="dialog"]', '[aria-modal="true"]'
].join(',')

const SCREENSHOT_DIALOG_WRAPPER_SELECTORS = [
  '.el-dialog__wrapper', '.el-drawer__wrapper',
  '.ant-modal-wrap', '.ivu-modal-wrap',
  '.modal[role="dialog"]', '.modal[aria-modal="true"]'
].join(',')

function getScreenshotDocumentSize() {
  const root = document.documentElement
  const body = document.body
  return {
    width: Math.max(root.scrollWidth, body ? body.scrollWidth : 0, root.clientWidth),
    height: Math.max(root.scrollHeight, body ? body.scrollHeight : 0, root.clientHeight)
  }
}

function isScreenshotElementVisible(element) {
  if (!element || !element.isConnected) return false
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 ||
      rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false

  let node = element
  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    node = node.parentElement
  }
  return true
}

function getScreenshotElementZIndex(element) {
  let zIndex = 0
  let node = element
  while (node && node !== document.documentElement) {
    const value = Number.parseInt(getComputedStyle(node).zIndex, 10)
    if (Number.isFinite(value)) zIndex = Math.max(zIndex, value)
    node = node.parentElement
  }
  return zIndex
}

function getTopVisibleScreenshotDialog() {
  let best = null
  const seen = new Set()
  for (const element of document.querySelectorAll(SCREENSHOT_DIALOG_SELECTORS)) {
    // Frameworks usually expose both a full-screen wrapper and an inner dialog node. Use the
    // wrapper as the search boundary because it may own the scrollbar itself.
    const wrapper = element.closest(SCREENSHOT_DIALOG_WRAPPER_SELECTORS)
    const dialog = wrapper && wrapper.contains(element) ? wrapper : element
    if (seen.has(dialog) || !isScreenshotElementVisible(dialog)) continue
    seen.add(dialog)
    const zIndex = getScreenshotElementZIndex(dialog)
    // querySelectorAll follows document order, so equal z-index keeps the later (topmost) dialog.
    if (!best || zIndex >= best.zIndex) best = { element: dialog, zIndex }
  }
  return best ? best.element : null
}

function getScreenshotScrollTarget() {
  const documentScroller = document.scrollingElement || document.documentElement
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
  const documentRange = Math.max(0, documentScroller.scrollHeight - documentScroller.clientHeight)
  const documentTarget = { element: documentScroller, isDocument: true, score: viewportArea }
  const dialog = getTopVisibleScreenshotDialog()
  let best = null

  // A visible modal owns the screenshot interaction context. Never consider ancestors or the
  // document behind it, otherwise a non-scrollable dialog would cause the covered page to scroll.
  const searchRoot = dialog || document.body
  const candidates = searchRoot
    ? [searchRoot, ...searchRoot.querySelectorAll('*')]
    : []
  for (const element of candidates) {
    if (element === documentScroller) continue
    const style = getComputedStyle(element)
    if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue

    const scrollRange = element.scrollHeight - element.clientHeight
    if (scrollRange <= 2 || element.clientWidth <= 0 || element.clientHeight <= 0) continue

    const rect = element.getBoundingClientRect()
    const contentLeft = rect.left + element.clientLeft
    const contentTop = rect.top + element.clientTop
    const contentRight = contentLeft + element.clientWidth
    const contentBottom = contentTop + element.clientHeight
    if (contentLeft < -1 || contentTop < -1 || contentRight > window.innerWidth + 1 || contentBottom > window.innerHeight + 1) continue

    const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
    const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
    if (visibleWidth <= 0 || visibleHeight <= 0) continue

    const visibleArea = visibleWidth * visibleHeight
    if (!dialog && (visibleWidth < window.innerWidth * 0.25 || visibleHeight < window.innerHeight * 0.25 || visibleArea < viewportArea * 0.15)) continue

    const score = visibleArea * Math.min(4, element.scrollHeight / Math.max(1, element.clientHeight))
    if (!best || score > best.score) {
      best = { element, isDocument: false, score, visibleArea, scrollRange }
    }
  }
  if (dialog) {
    // No scrollbar inside the active dialog: capture the current viewport once without moving
    // either the dialog or its covered background document.
    return best || { element: null, isDocument: false, isViewport: true }
  }
  if (!best) return documentTarget
  if (documentRange <= 2) return best

  const documentHasMinorOverflow = documentRange < window.innerHeight * 0.5
  const internalIsPrimary = best.visibleArea >= viewportArea * 0.35 && best.scrollRange > documentRange * 2
  return documentHasMinorOverflow && internalIsPrimary ? best : documentTarget
}

function getScreenshotTargetMetrics() {
  const state = screenshotScrollState
  if (state && state.isViewport) {
    return {
      scrollX: 0,
      scrollY: 0,
      documentWidth: window.innerWidth,
      documentHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      maxScrollY: 0,
      captureRect: null
    }
  }
  if (!state || state.isDocument) {
    const size = getScreenshotDocumentSize()
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentWidth: size.width,
      documentHeight: size.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      maxScrollY: Math.max(0, size.height - window.innerHeight),
      captureRect: null
    }
  }

  const element = state.element
  const rect = element.getBoundingClientRect()
  const contentLeft = rect.left + element.clientLeft
  const contentTop = rect.top + element.clientTop
  const left = Math.max(0, contentLeft)
  const top = Math.max(0, contentTop)
  const right = Math.min(window.innerWidth, contentLeft + element.clientWidth)
  const bottom = Math.min(window.innerHeight, contentTop + element.clientHeight)
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  return {
    scrollX: element.scrollLeft,
    scrollY: element.scrollTop,
    documentWidth: element.scrollWidth,
    documentHeight: element.scrollHeight,
    viewportWidth: width,
    viewportHeight: height,
    maxScrollY: Math.max(0, element.scrollHeight - element.clientHeight),
    captureRect: { left, top, width, height }
  }
}

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
    const target = getScreenshotScrollTarget()
    screenshotScrollState = {
      element: target.element,
      isDocument: target.isDocument,
      isViewport: !!target.isViewport,
      scrollX: target.isDocument ? window.scrollX : target.isViewport ? 0 : target.element.scrollLeft,
      scrollY: target.isDocument ? window.scrollY : target.isViewport ? 0 : target.element.scrollTop,
      windowScrollX: window.scrollX,
      windowScrollY: window.scrollY,
      rootScrollBehavior: root.style.scrollBehavior,
      targetScrollBehavior: target.isDocument || target.isViewport ? null : target.element.style.scrollBehavior
    }
    root.style.scrollBehavior = 'auto'
    if (!target.isDocument && !target.isViewport) target.element.style.scrollBehavior = 'auto'
    const metrics = getScreenshotTargetMetrics()
    sendResponse(Object.assign(metrics, {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    }))
    return true
  }
  if (request.type === 'scrollForScreenshot') {
    const state = screenshotScrollState
    if (state && state.isViewport) {
      // The active dialog has no internal scrollbar; keep the current viewport fixed.
    } else if (state && !state.isDocument) {
      state.element.scrollTo(request.x || 0, request.y || 0)
    } else {
      window.scrollTo(request.x || 0, request.y || 0)
    }
    // 两帧后响应，给布局、懒加载和浏览器绘制一次稳定机会。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(() => {
        sendResponse(getScreenshotTargetMetrics())
      }, 180)
    }))
    return true
  }
  if (request.type === 'restoreScrollAfterScreenshot') {
    const state = screenshotScrollState
    if (state && !state.isDocument && !state.isViewport) {
      if (state.element.isConnected) state.element.scrollTo(state.scrollX, state.scrollY)
      state.element.style.scrollBehavior = state.targetScrollBehavior || ''
    }
    window.scrollTo(state ? state.windowScrollX : request.x || 0, state ? state.windowScrollY : request.y || 0)
    document.documentElement.style.scrollBehavior = state ? state.rootScrollBehavior || '' : ''
    screenshotScrollState = null
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
          let pageContext = null
          try {
            if (typeof PageElementScannerController !== 'undefined' &&
                typeof PageElementScannerController.getCurrentPageContext === 'function') {
              pageContext = PageElementScannerController.getCurrentPageContext()
            }
          } catch (e) {}
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
              pageKey: pageContext ? pageContext.key : '',
              pageUrl: pageContext ? pageContext.url : window.location.href,
              routeIdentity: pageContext ? pageContext.routeIdentity : '',
              pageOrder: pageContext ? pageContext.pageOrder : 0,
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
