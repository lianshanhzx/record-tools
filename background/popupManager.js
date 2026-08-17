/**
 * popupManager.js — 弹窗窗口管理模块
 * 负责 popup 操作窗口的创建、聚焦与关闭通知。
 */

const PopupManager = {
  // 当前打开的 popup 窗口 id，用于 onRemoved 判断
  popupWindowId: null,
  // 唤起录制窗口的网页标签页，popup 后续所有操作均以它为目标。
  targetTabId: null,

  /**
   * 打开或聚焦 popup 操作窗口。
   * 调用位置：background/service-worker.js → onMessage (openPopup) / onClicked / onMessageExternal
   */
  async openOpertePopup(safeLeft, targetTabId) {
    if (targetTabId) {
      this.targetTabId = targetTabId
      // MV3 Service Worker 可随时休眠，session storage 保留当前 popup 生命周期内的来源标签。
      await chrome.storage.session.set({ popupTargetTabId: targetTabId })
    }
    const windows = await chrome.windows.getAll();
    const popup = windows.find(win => win.type === 'popup');

    let offsetLeft = 100

    let opts = {
      height: 500,
      width: 1000,
      left: offsetLeft,
      top: safeLeft || 100,
    };

    if (!popup) {
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
      console.log('popup 已创建', this.popupWindowId)
    } else {
      console.log('已经有弹窗了')
      this.popupWindowId = popup.id;
      await chrome.windows.update(popup.id, { focused: true });
    }
  },

  /**
   * 向所有 content script 广播 popup 已关闭，通知其停止 DOM 监听。
   * 调用位置：background/popupManager.js → chrome.windows.onRemoved
   */
  async notifyPopupClosed() {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!tab.id || !tab.url || tab.url.startsWith('chrome://')) continue
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'popupClosed' })
      } catch (e) {
        // 页面未注入 content script 或已关闭，忽略
      }
    }
  }
}

// 监听 popup 窗口关闭事件，在 background 侧可靠通知 content script
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === PopupManager.popupWindowId) {
    console.log('popup 已关闭', windowId)
    PopupManager.popupWindowId = null
    PopupManager.targetTabId = null
    chrome.storage.session.remove('popupTargetTabId')
    PopupManager.notifyPopupClosed()
  }
})
