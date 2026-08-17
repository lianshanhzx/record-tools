/**
 * 全页滚动截图服务。content 负责滚动，background 负责捕获可视区，
 * 本模块在 popup 中裁切并拼接所有屏幕图像后下载。
 */
const ScreenshotService = {
  isCapturing: false,
  previewUrls: {},

  async captureFullPage(tab, groupNode, onProgress) {
    if (this.isCapturing) throw new Error('截图任务正在执行')
    this.isCapturing = true
    let pageInfo = null
    try {
      pageInfo = await sendToContent(tab.id, { type: 'prepareFullPageScreenshot' })
      if (!pageInfo || !pageInfo.viewportWidth || !pageInfo.viewportHeight) {
        throw new Error('无法读取页面尺寸：内容脚本未响应。请刷新目标网页后重试')
      }

      const estimatedWidth = Math.ceil(pageInfo.viewportWidth * pageInfo.devicePixelRatio)
      const estimatedHeight = Math.ceil(pageInfo.documentHeight * pageInfo.devicePixelRatio)
      if (estimatedWidth * estimatedHeight > screenshotMaxPixels) {
        throw new Error('页面过长，截图像素超过 ' + Math.floor(screenshotMaxPixels / 1000000) + ' 百万限制')
      }

      const captures = []
      let requestedY = 0
      let documentHeight = pageInfo.documentHeight
      let stableBottomChecks = 0
      const maxCaptures = 100
      let attempts = 0
      let reachedBottom = false
      while (attempts < maxCaptures) {
        attempts++
        const estimatedTotal = Math.max(1, Math.ceil(documentHeight / pageInfo.viewportHeight))
        onProgress(captures.length + 1, estimatedTotal)
        const scrollState = await sendToContent(tab.id, { type: 'scrollForScreenshot', x: 0, y: requestedY })
        if (!scrollState || typeof scrollState.scrollY !== 'number') {
          throw new Error('页面滚动失败：内容脚本未响应')
        }
        documentHeight = Math.max(documentHeight, scrollState.documentHeight || 0)
        // Chrome 对 captureVisibleTab 有每秒调用次数限制，逐屏捕获之间主动节流。
        if (captures.length > 0) await this.delay(550)
        const response = await chrome.runtime.sendMessage({
          type: 'captureVisibleTabForScreenshot',
          windowId: tab.windowId
        })
        if (!response || response.error || !response.dataUrl) {
          throw new Error((response && response.error) || '浏览器未返回页面截图')
        }
        const image = await this.loadImage(response.dataUrl)
        const actualY = scrollState.scrollY
        if (!captures.some(capture => capture.y === actualY)) captures.push({ y: actualY, image })

        const maxScrollY = Math.max(0, documentHeight - pageInfo.viewportHeight)
        if (actualY >= maxScrollY) {
          stableBottomChecks++
          if (stableBottomChecks >= 2) {
            reachedBottom = true
            break
          }
          requestedY = maxScrollY
        } else {
          stableBottomChecks = 0
          requestedY = Math.min(actualY + pageInfo.viewportHeight, maxScrollY)
        }
      }
      if (!reachedBottom) throw new Error('页面过长或持续加载，已达到最大截图屏数')

      pageInfo.documentHeight = documentHeight
      const blob = await this.stitch(captures, pageInfo)
      const filename = this.buildFilename(groupNode.name)
      const blobUrl = URL.createObjectURL(blob)
      const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      })
      await chrome.runtime.sendMessage({ type: 'trackScreenshotDownload', downloadId })
      this.previewUrls[filename] = blobUrl
      return filename
    } finally {
      if (pageInfo) {
        try {
          await sendToContent(tab.id, {
            type: 'restoreScrollAfterScreenshot', x: pageInfo.scrollX, y: pageInfo.scrollY
          })
        } catch (e) {
          // 标签页关闭或导航后无法恢复滚动位置。
        }
      }
      this.isCapturing = false
    }
  },

  loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('截图图像解码失败'))
      image.src = dataUrl
    })
  },

  async stitch(captures, pageInfo) {
    const scale = captures[0].image.naturalWidth / pageInfo.viewportWidth
    // captureVisibleTab 只能取得当前视口，横向溢出内容不在本次纵向滚动截图范围内。
    const width = captures[0].image.naturalWidth
    const height = Math.ceil(pageInfo.documentHeight * scale)
    if (width * height > screenshotMaxPixels) throw new Error('页面实际截图尺寸超过浏览器处理上限')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    for (const capture of captures) {
      const sourceY = Math.max(0, capture.y * scale)
      const remainingHeight = height - sourceY
      const sourceHeight = Math.min(capture.image.naturalHeight, remainingHeight)
      if (sourceHeight > 0) {
        context.drawImage(capture.image, 0, 0, width, sourceHeight, 0, sourceY, width, sourceHeight)
      }
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob)
        else reject(new Error('截图图片编码失败'))
      }, 'image/png')
    })
  },

  buildFilename(groupName) {
    const safeName = String(groupName || '主页面').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)
    const now = new Date()
    const timestamp = now.getFullYear() + this.pad(now.getMonth() + 1) + this.pad(now.getDate()) + '-' +
      this.pad(now.getHours()) + this.pad(now.getMinutes()) + this.pad(now.getSeconds()) + '-' + now.getMilliseconds()
    return screenshotDownloadDirectory + '/' + (safeName || '主页面') + '-full-page-' + timestamp + '.png'
  },

  getPreviewUrl(screenshotPath) {
    return this.previewUrls[screenshotPath] || ''
  },

  async deleteScreenshot(screenshotPath) {
    const fileName = screenshotPath.split('/').pop()
    const normalizedPath = screenshotPath.replace(/\\/g, '/').toLowerCase()
    const downloads = await chrome.downloads.search({ query: [fileName] })
    for (const item of downloads) {
      if (!String(item.filename || '').replace(/\\/g, '/').toLowerCase().endsWith(normalizedPath)) continue
      try { await chrome.downloads.removeFile(item.id) } catch (e) { }
      try { await chrome.downloads.erase({ id: item.id }) } catch (e) { }
      await chrome.runtime.sendMessage({ type: 'untrackScreenshotDownload', downloadId: item.id })
    }
    const previewUrl = this.previewUrls[screenshotPath]
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    delete this.previewUrls[screenshotPath]
  },

  pad(value) {
    return String(value).padStart(2, '0')
  },

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
