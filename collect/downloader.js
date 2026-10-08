/**
 * collect/downloader.js — Offscreen Document 下载器
 *
 * MV3 的 offscreen document 中无法使用 chrome.downloads API，
 * 因此这里只负责把 JSON payload 转成 Blob 再读取为 ArrayBuffer，
 * 通过消息返回给 service worker，由 service worker 调用 chrome.downloads.download。
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type !== 'collectDownloadJson') return false

  console.log('[Downloader] receive collectDownloadJson', request.filename)
  const { payload, filename } = request

  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    blob.arrayBuffer()
      .then(arrayBuffer => {
        console.log('[Downloader] blob converted to arrayBuffer, size=', arrayBuffer.byteLength)
        sendResponse({ ok: true, arrayBuffer, filename })
      })
      .catch(error => {
        console.error('[Downloader] blob conversion failed', error)
        sendResponse({ ok: false, error: error.message })
      })
  } catch (error) {
    console.error('[Downloader] create blob failed', error)
    sendResponse({ ok: false, error: error.message })
  }

  return true
})
