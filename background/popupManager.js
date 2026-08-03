/**
 * popupManager.js — 弹窗窗口管理模块
 * 负责 popup 窗口的创建与聚焦。
 */

const PopupManager = {

  /**
   * 打开或聚焦 popup 操作窗口。
   * 调用位置：background/service-worker.js → onMessage (openPopup) / onClicked / onMessageExternal
   */
  async openOpertePopup(safeLeft) {
    const windows = await chrome.windows.getAll();
    const popupExists = windows.some(win => win.type === 'popup');

    let offsetLeft = 100

    let opts = {
      height: 500,
      width: 1000,
      left: offsetLeft,
      top: safeLeft || 100,
    };

    if (!popupExists) {
      chrome.windows.create(
        Object.assign(
          {
            url: chrome.runtime.getURL('popup/index.html'),
            type: 'popup',
            focused: true,
          },
          opts
        )
      );
    } else {
      console.log('已经有弹窗了')
      const popup = windows.find(win => win.type === 'popup');
      chrome.windows.update(popup.id, { focused: true });
    }
  }
}
