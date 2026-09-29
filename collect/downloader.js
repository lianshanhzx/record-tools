/**
 * collect/downloader.js — Offscreen Document 下载器
 *
 * MV3 service worker 无法直接生成 blob URL，因此通过 offscreen document
 * 接收 JSON payload 后生成 blob 并调用 chrome.downloads.download。
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type !== 'collectDownloadJson') return false

  console.log('[Downloader] receive collectDownloadJson', request.filename)
  const { payload, filename } = request
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  chrome.downloads.download({ url, filename, saveAs: false })
    .then(downloadId => {
      console.log('[Downloader] download started', downloadId)
      sendResponse({ ok: true, downloadId })
      // 释放 blob URL（下载已开始，保留短暂时间）。
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    })
    .catch(error => {
      console.error('[Downloader] download failed', error)
      URL.revokeObjectURL(url)
      sendResponse({ ok: false, error: error.message })
    })

  return true
})
