/**
 * popupManager.js — 弹窗窗口管理模块
 * 负责 popup 操作窗口的创建、聚焦与关闭通知。
 */

const PopupManager = {
  // 当前打开的 popup 窗口 id，用于 onRemoved 判断
  popupWindowId: null,
  // 唤起录制窗口的网页标签页，popup 后续所有操作均以它为目标。
  targetTabId: null,

  async findPopupWindow() {
    const popupUrl = chrome.runtime.getURL('popup/index.html')
    const windows = await chrome.windows.getAll({ populate: true })
    return windows.find(win => {
      return win.type === 'popup' && win.tabs?.some(tab => tab.url === popupUrl)
    }) || null
  },

  /**
   * 打开或聚焦 popup 操作窗口。
   * 调用位置：background/service-worker.js → onMessage (openPopup) / onClicked / onMessageExternal
   */
  async openOpertePopup(safeLeft, targetTabId) {
    const popup = await this.findPopupWindow()
    if (popup) {
      this.popupWindowId = popup.id
      await chrome.storage.session.set({ popupWindowId: popup.id })
      await chrome.windows.update(popup.id, { focused: true })
      return { created: false, windowId: popup.id }
    }

    if (targetTabId) {
      this.targetTabId = targetTabId
      // MV3 Service Worker 可随时休眠，session storage 保留当前 popup 生命周期内的来源标签。
      await chrome.storage.session.set({ popupTargetTabId: targetTabId })
    }

    let offsetLeft = 100

    let opts = {
      height: 500,
      width: 1000,
      left: offsetLeft,
      top: safeLeft || 100,
    };

    const created = await chrome.windows.create(
      Object.assign(
        {
          url: chrome.runtime.getURL('popup/index.html'),
          type: 'popup',
          focused: true,
        },
        opts
      )
    );
    this.popupWindowId = created.id;
    await chrome.storage.session.set({ popupWindowId: created.id })
    return { created: true, windowId: created.id }
  },

  /**
   * 通知当前 popup 对应的 content script 停止 DOM 监听。
   * 调用位置：background/popupManager.js → chrome.windows.onRemoved
   */
  async notifyPopupClosed(targetTabId) {
    if (!targetTabId) return
    try {
      await chrome.tabs.sendMessage(targetTabId, { type: 'popupClosed' })
    } catch (e) {
      // 页面未注入 content script 或已关闭，忽略
    }
  }
}

// 监听 popup 窗口关闭事件，在 background 侧可靠通知 content script
chrome.windows.onRemoved.addListener(async (windowId) => {
  const stored = await chrome.storage.session.get(['popupWindowId', 'popupTargetTabId'])
  const popupWindowId = PopupManager.popupWindowId || stored.popupWindowId
  if (windowId === popupWindowId) {
    const targetTabId = PopupManager.targetTabId || stored.popupTargetTabId
    PopupManager.popupWindowId = null
    PopupManager.targetTabId = null
    await chrome.storage.session.remove(['popupWindowId', 'popupTargetTabId'])
    await PopupManager.notifyPopupClosed(targetTabId)
  }
})
