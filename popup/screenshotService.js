/**
 * 全页滚动截图服务。
 *
 * 整体分工：
 *   - content 侧（content/messageHandler.js）负责识别实际滚动目标并执行滚动，同时把
 *     每次滚动后的容器可视区域坐标（captureRect）回传给 popup；
 *   - background 侧（background/service-worker.js）负责调用 chrome.tabs.captureVisibleTab
 *     抓取当前可视区截图；
 *   - 本模块（popup）负责驱动整个流程：控制滚动步进、节流捕获、把每一屏裁切并拼接成
 *     完整长图，最后通过 chrome.downloads 下载。
 *
 * 支持两种滚动场景：
 *   1. 文档自身滚动（普通页面）：页面整体由 window / document 滚动，maxScrollY 由
 *      文档高度与视口高度计算得出；
 *   2. 内部滚动容器（Vue + Element UI 常见）：如 el-scrollbar 内层、el-table 等，
 *      页面外壳固定，只有容器内部内容滚动。此时 popup 根据 content 返回的
 *      captureRect 只裁切容器可视区域，并把固定外壳（页头、侧边、页脚）保留一次。
 *
 * 拼接去重策略（防止 Element UI 吸顶表头/固定工具栏在长图中重复出现）：
 *   相邻两次截图之间保留一部分重叠（见 getCaptureOverlap），但拼接时每一屏只取
 *   “新进入视口”的内容，即跳过已被上一屏绘制过的顶部重叠区。
 */
const ScreenshotService = {
  isCapturing: false,
  stopRequested: false,
  previewUrls: {},

  requestStop() {
    if (this.isCapturing) this.stopRequested = true
  },

  /**
   * 执行一次完整的全页截图并下载。
   * @param tab        目标标签页对象（需包含 id、windowId）
   * @param groupNode  触发截图的分组节点，用于生成下载文件名
   * @param onProgress 进度回调 (current, total)
   * @returns {Promise<Object>} 返回截图路径、尺寸和各元素在图片中的归一化坐标
   */
  async captureFullPage(tab, groupNode, onProgress) {
    if (this.isCapturing) throw new Error('截图任务正在执行')
    this.isCapturing = true
    this.stopRequested = false
    let pageInfo = null
    try {
      // ---- 1. 让 content 侧准备截图：识别滚动目标、保存原始滚动位置、返回页面指标 ----
      pageInfo = await sendToContent(tab.id, {
        type: 'prepareFullPageScreenshot',
        groupContext: {
          key: groupNode.key,
          type: groupNode.type,
          path: groupNode.path || [],
          items: groupNode.captureItems || [],
          boundaryItems: groupNode.captureBoundaryItems || groupNode.captureItems || []
        }
      })
      // viewportWidth / viewportHeight 是实际滚动容器的可视区尺寸，两端数据必须齐全。
      if (!pageInfo || !pageInfo.viewportWidth || !pageInfo.viewportHeight) {
        throw new Error('无法读取页面尺寸：内容脚本未响应。请刷新目标网页后重试')
      }

      // ---- 2. 预估最终图片尺寸，提前拦截超长页面，避免浏览器内存耗尽 ----
      // 内部滚动容器场景下，最后成图的逻辑高度 = 窗口高度 + 容器可滚动距离
      // （外壳保持不变，仅滚动内容纵向延展）；文档滚动时直接用文档高度。
      const estimatedWidth = Math.ceil((pageInfo.windowWidth || pageInfo.viewportWidth) * pageInfo.devicePixelRatio)
      const logicalHeight = (pageInfo.captureRect ? (pageInfo.windowHeight || pageInfo.viewportHeight) : pageInfo.viewportHeight) + pageInfo.maxScrollY
      const estimatedHeight = Math.ceil(logicalHeight * pageInfo.devicePixelRatio)
      if (estimatedWidth * estimatedHeight > screenshotMaxPixels) {
        throw new Error('页面过长，截图像素超过 ' + Math.floor(screenshotMaxPixels / 1000000) + ' 百万限制')
      }

      const captures = []
      let requestedY = 0 // 下一次要滚动到的目标位置（逻辑像素，容器坐标）
      let documentHeight = pageInfo.captureRect
        ? pageInfo.documentHeight
        : pageInfo.viewportHeight + pageInfo.maxScrollY
      // maxScrollY 为滚动目标的最大可滚动距离，同时作为“是否已到达底部”的终止条件。
      // 注意：content 每次滚动后都会回报最新的 maxScrollY（允许缩小），
      // 避免内容懒加载/折叠后 scrollHeight 变小导致永远触碰不到旧最大值。
      let maxScrollY = typeof pageInfo.maxScrollY === 'number'
        ? pageInfo.maxScrollY
        : Math.max(0, documentHeight - pageInfo.viewportHeight)
      // 相邻截图间的重叠区高度，用于拼接时跳过吸顶等固定内容。
      const overlap = this.getCaptureOverlap(pageInfo.viewportHeight)
      // Chrome 滚动到底部后视口可能因懒加载继续变化，连续两次到达底部才算稳定结束。
      let stableBottomChecks = 0
      const maxCaptures = 100 // 兜底上限，防止页面持续加载导致死循环
      let attempts = 0
      let reachedBottom = false

      // ---- 3. 滚动捕获循环：逐屏滚动 -> content 回报位置 -> 通知 background 截图 ----
      while (attempts < maxCaptures) {
        attempts++
        // 进度估算：按“文档高度 / 可视高度”估算总屏数，仅用于展示。
        const estimatedTotal = Math.max(1, Math.ceil(documentHeight / pageInfo.viewportHeight))
        onProgress(captures.length + 1, estimatedTotal)

        // 滚动到目标位置，content 会在两帧 + 180ms 后回报实际滚动位置与容器几何信息。
        const scrollState = await sendToContent(tab.id, { type: 'scrollForScreenshot', x: 0, y: requestedY })
        if (!scrollState || typeof scrollState.scrollY !== 'number') {
          throw new Error('页面滚动失败：内容脚本未响应')
        }
        // 以每次回报的最新文档高度 / 最大滚动距离为准。
        documentHeight = pageInfo.captureRect
          ? Math.max(documentHeight, scrollState.documentHeight || 0)
          : pageInfo.viewportHeight + (typeof scrollState.maxScrollY === 'number' ? scrollState.maxScrollY : maxScrollY)
        if (typeof scrollState.maxScrollY === 'number') maxScrollY = scrollState.maxScrollY

        // Chrome 对 captureVisibleTab 有每秒调用次数限制，逐屏捕获之间主动节流，
        // 同时给页面留出滚动稳定和懒加载的时间。
        if (captures.length > 0) await this.delay(550)

        // 请求 background 抓取当前可视区截图。
        const response = await chrome.runtime.sendMessage({
          type: 'captureVisibleTabForScreenshot',
          windowId: tab.windowId
        })
        if (!response || response.error || !response.dataUrl) {
          throw new Error((response && response.error) || '浏览器未返回页面截图')
        }

        const image = await this.loadImage(response.dataUrl)
        const actualY = scrollState.scrollY
        // 记录实际滚动位置（而非请求位置），同一位置的截图去重，避免拼接重复屏。
        if (!captures.some(capture => capture.y === actualY)) {
          captures.push({
            y: actualY,
            image,
            captureRect: scrollState.captureRect,
            elementRects: scrollState.elementRects || []
          })
        }

        // ---- 4. 判断是否到达底部，并安排下一次滚动位置 ----
        if (this.stopRequested) {
          maxScrollY = actualY
          reachedBottom = true
          break
        }
        if (maxScrollY <= 0) {
          reachedBottom = true
          break
        }
        if (actualY >= maxScrollY) {
          // 已到达底部：连续两次确认才认为真正结束（第二次通常是终态截图）。
          stableBottomChecks++
          if (stableBottomChecks >= 2) {
            reachedBottom = true
            break
          }
          requestedY = maxScrollY
        } else {
          stableBottomChecks = 0
          // 未到底：按“视口高度 - 重叠区”前进。Element UI 中常见吸顶表头和固定
          // 工具栏，相邻截图保留足够重叠，拼接时只取新进入视口的区域，
          // 避免固定内容在长图中重复出现。
          requestedY = Math.min(actualY + pageInfo.viewportHeight - overlap, maxScrollY)
        }
      }
      if (!reachedBottom) throw new Error('页面过长或持续加载，已达到最大截图屏数')

      // ---- 5. 拼接所有截图并下载 ----
      pageInfo.documentHeight = documentHeight
      pageInfo.maxScrollY = maxScrollY
      const stitched = await this.stitch(captures, pageInfo, groupNode.captureItems || [])
      const blob = stitched.blob
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
      return {
        path: filename,
        width: stitched.width,
        height: stitched.height,
        positions: stitched.positions,
        stoppedManually: this.stopRequested
      }
    } finally {
      // ---- 6. 无论成功失败，都恢复页面原始滚动位置与 scrollBehavior ----
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
      this.stopRequested = false
    }
  },

  /**
   * 将 dataUrl 解码为可绘制到 canvas 的 Image 对象。
   * 用 Promise 包装 Image 的异步加载，失败时抛出统一的解码错误。
   */
  loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('截图图像解码失败'))
      image.src = dataUrl
    })
  },

  /**
   * 把捕获到的所有屏图像裁切、拼接为一张完整长图。
   *
   * 坐标系说明（重要）：
   *   - captures 中的 y 是“逻辑像素”（CSS 像素，即容器 scrollTop）；
   *   - 每一屏截图（captureVisibleTab 产物）是设备像素（物理像素）图像，
   *     宽高 = 窗口宽高 × devicePixelRatio，因此需要 scale = 自然宽 / 窗口宽 换算；
   *   - 拼接时一律使用“由绝对坐标取整而来”的源/目标边界，避免在设备缩放比例
   *     为非整数（如 125%、150%）时，各段分别取整导致接缝处重复或空一行。
   *
   * 最终图片布局：
   *   - 文档滚动：高度 = logicalHeight × scale，每屏按实际内容位置依次贴入；
   *   - 内部滚动容器：横向保持全屏宽，高度 = 首屏自然高 + 滚动距离 × scale，
   *     页头/侧边保留，滚动内容插入，页脚（首屏中容器下方的区域）移到图片末尾。
   */
  async stitch(captures, pageInfo, captureItems) {
    const captureRect = pageInfo.captureRect
    // 设备像素与逻辑像素的换算比例：以首屏自然宽除以窗口宽得到。
    const scale = captures[0].image.naturalWidth / (pageInfo.windowWidth || pageInfo.viewportWidth)
    // captureVisibleTab 只能取得当前视口，横向溢出内容不在本次纵向滚动截图范围内。
    const logicalHeight = pageInfo.maxScrollY + pageInfo.viewportHeight
    const width = captures[0].image.naturalWidth
    const height = captureRect
      ? captures[0].image.naturalHeight + Math.ceil(pageInfo.maxScrollY * scale)
      : Math.ceil(logicalHeight * scale)
    if (width * height > screenshotMaxPixels) throw new Error('页面实际截图尺寸超过浏览器处理上限')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    const itemStatuses = new Map()
    ;(captureItems || []).forEach(item => itemStatuses.set(item.id, 'target-not-found'))
    const elementBoxes = new Map()

    function rememberStatus(elementInfo) {
      if (!elementInfo || !elementInfo.id) return
      const current = itemStatuses.get(elementInfo.id)
      if (elementInfo.status === 'visible' || current === 'target-not-found') {
        itemStatuses.set(elementInfo.id, elementInfo.status || current)
      }
    }

    function rememberBox(capture, currentRect, sourceX, sourceY, sourceOffsetY, sourceWidth,
      sourceHeight, destinationX, outputY) {
      const sourceTop = sourceY + sourceOffsetY
      const sourceBottom = sourceTop + sourceHeight
      const sourceRight = sourceX + sourceWidth
      ;(capture.elementRects || []).forEach(elementInfo => {
        rememberStatus(elementInfo)
        const rect = elementInfo.rect
        if (!rect || elementBoxes.has(elementInfo.id)) return
        const elementLeft = rect.left * scale
        const elementTop = rect.top * scale
        const elementRight = rect.right * scale
        const elementBottom = rect.bottom * scale
        if (elementRight <= sourceX || elementLeft >= sourceRight ||
            elementBottom <= sourceTop || elementTop >= sourceBottom) return
        const logicalLeft = currentRect
          ? (captureRect.left + rect.left - currentRect.left) * scale
          : elementLeft
        const logicalTop = currentRect
          ? (captureRect.top + capture.y + rect.top - currentRect.top) * scale
          : (capture.y + rect.top) * scale
        elementBoxes.set(elementInfo.id, {
          left: logicalLeft,
          top: logicalTop,
          width: rect.width * scale,
          height: rect.height * scale
        })
      })
    }

    // ---- 内部滚动容器场景：先铺设外壳（页头、两侧、页脚），再插入滚动内容 ----
    if (captureRect) {
      // 滚动内容会纵向向下延伸，超出首屏的部分用白色兜底，避免透明或残留画面。
      context.fillStyle = '#fff'
      context.fillRect(0, 0, width, height)

      // 页头：容器上方的固定区域原样保留一次。
      const contentTop = Math.round(captureRect.top * scale)
      const contentLeft = Math.round(captureRect.left * scale)
      const contentRight = Math.round((captureRect.left + captureRect.width) * scale)
      const contentHeight = Math.round(captureRect.height * scale)
      if (contentTop > 0) context.drawImage(captures[0].image, 0, 0, width, contentTop, 0, 0, width, contentTop)

      // 容器左侧固定侧边（如侧栏、导航阴影等）。
      if (contentLeft > 0) {
        context.drawImage(captures[0].image, 0, contentTop, contentLeft, contentHeight,
          0, contentTop, contentLeft, contentHeight)
      }
      // 容器右侧固定区域。
      if (contentRight < width) {
        context.drawImage(captures[0].image, contentRight, contentTop, width - contentRight, contentHeight,
          contentRight, contentTop, width - contentRight, contentHeight)
      }

      // 页脚：首屏画布中“容器底部以下”的区域，把它搬到滚动内容末尾之后，
      // 使固定页脚在长图底部恰好出现一次，而不是停留在原位置被滚动内容覆盖。
      const footerSourceY = Math.round((captureRect.top + captureRect.height) * scale)
      const footerHeight = captures[0].image.naturalHeight - footerSourceY
      if (footerHeight > 0) {
        context.drawImage(captures[0].image, 0, footerSourceY, width, footerHeight,
          0, height - footerHeight, width, footerHeight)
      }
    }

    // ---- 逐屏拼接滚动内容 ----
    // 按滚动位置升序排列，保证“上一屏/下一屏”的相对关系正确。
    captures.sort((a, b) => a.y - b.y)
    for (let index = 0; index < captures.length; index++) {
      const capture = captures[index]
      // 每屏可携带各自的容器几何（布局可能随滚动变化），缺失时回退到首次的 captureRect。
      const currentRect = capture.captureRect || captureRect

      // 源区域：当前屏截图图像中要取出的内容矩形（设备像素）。
      const sourceX = currentRect ? Math.round(currentRect.left * scale) : 0
      const sourceY = currentRect ? Math.round(currentRect.top * scale) : 0
      const sourceWidth = currentRect
        ? Math.min(Math.round(currentRect.width * scale), capture.image.naturalWidth - sourceX)
        : width
      const viewportHeight = currentRect
        ? Math.min(Math.round(currentRect.height * scale), capture.image.naturalHeight - sourceY)
        : capture.image.naturalHeight

      // ---- 只绘制“新进入视口”的内容，跳过与上一屏重叠的顶部区域 ----
      // 上一屏已经绘制到 previousCapture.y + previousViewportHeight，
      // 当前屏从该位置开始才有新内容；结合实际滚动位置取较大者。
      const previousCapture = index > 0 ? captures[index - 1] : null
      const previousRect = previousCapture && (previousCapture.captureRect || captureRect)
      const previousViewportHeight = previousRect ? previousRect.height : pageInfo.viewportHeight
      const currentViewportHeight = currentRect ? currentRect.height : pageInfo.viewportHeight
      const newContentY = previousCapture
        ? Math.max(capture.y, previousCapture.y + previousViewportHeight)
        : capture.y

      // 内容结束位置（首屏不可能超过最终图片底部）。
      const contentEndY = Math.min(capture.y + currentViewportHeight, logicalHeight)

      // 目标区域与源偏移：
      //   - captureStartPixel：当前屏顶部在最终画布上对应的设备像素行；
      //   - destinationY：新内容实际应贴入的设备像素行（即 newContentY 对应位置）；
      //   - sourceOffsetY：因重叠区跳过而需要在源图像上向下偏移的像素量。
      // 两者都用绝对坐标换算后取整，保证与上一屏的收尾边界严格衔接，不重不漏。
      const captureStartPixel = Math.round(capture.y * scale)
      const destinationY = Math.max(0, Math.round(newContentY * scale))
      const destinationEndY = Math.max(destinationY, Math.round(contentEndY * scale))
      const sourceOffsetY = Math.max(0, destinationY - captureStartPixel)

      // 内部滚动容器还需在水平方向平移到容器的目标列位置。
      const destinationX = captureRect ? Math.round(captureRect.left * scale) : 0
      const outputY = captureRect ? Math.round(captureRect.top * scale) + destinationY : destinationY

      // 实际可绘制高度：不超过“新内容结束边界”“源图像可用高度”“画布剩余高度”三者。
      const remainingHeight = height - outputY
      const sourceHeight = Math.min(destinationEndY - destinationY, viewportHeight - sourceOffsetY, remainingHeight)
      if (sourceWidth > 0 && sourceHeight > 0) {
        context.drawImage(capture.image, sourceX, sourceY + sourceOffsetY, sourceWidth, sourceHeight,
          destinationX, outputY, sourceWidth, sourceHeight)
        rememberBox(capture, currentRect, sourceX, sourceY, sourceOffsetY, sourceWidth,
          sourceHeight, destinationX, outputY)
      }
    }
    // Internal scrolling keeps the complete first viewport shell. Elements outside the scrolling
    // content rectangle retain their original first-screen coordinates.
    if (captureRect && captures[0]) {
      const rectLeft = captureRect.left * scale
      const rectTop = captureRect.top * scale
      const rectRight = (captureRect.left + captureRect.width) * scale
      const rectBottom = (captureRect.top + captureRect.height) * scale
      ;(captures[0].elementRects || []).forEach(elementInfo => {
        rememberStatus(elementInfo)
        const rect = elementInfo.rect
        if (!rect || elementBoxes.has(elementInfo.id)) return
        const left = rect.left * scale
        const top = rect.top * scale
        const right = rect.right * scale
        const bottom = rect.bottom * scale
        const insideScrollingContent = left >= rectLeft && right <= rectRight && top >= rectTop && bottom <= rectBottom
        if (!insideScrollingContent && left >= 0 && top >= 0 && right <= width && bottom <= captures[0].image.naturalHeight) {
          const movedTop = top >= rectBottom ? top + pageInfo.maxScrollY * scale : top
          elementBoxes.set(elementInfo.id, { left, top: movedTop, width: rect.width * scale, height: rect.height * scale })
        }
      })
    }

    const positions = {}
    ;(captureItems || []).forEach(item => {
      const box = elementBoxes.get(item.id)
      const completeBox = box && box.left >= 0 && box.top >= 0 &&
        box.left + box.width <= width && box.top + box.height <= height
      const itemStatus = itemStatuses.get(item.id)
      positions[item.id] = completeBox
        ? {
            x: box.left / width,
            y: box.top / height,
            width: box.width / width,
            height: box.height / height,
            coordinateType: 'normalized',
            status: 'captured'
          }
        : { status: itemStatus === 'target-not-found' || itemStatus === 'not-visible' ? itemStatus : 'not-captured' }
    })

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob)
        else reject(new Error('截图图片编码失败'))
      }, 'image/png')
    })
    return { blob, width, height, positions }
  },

  /**
   * 生成下载文件名：{分组名}-full-page-{yyyyMMdd-HHmmss-mmm}.png
   * 移除文件名中的非法字符并限制长度，默认目录来自全局配置 screenshotDownloadDirectory。
   */
  buildFilename(groupName) {
    const safeName = String(groupName || '主页面').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)
    const now = new Date()
    const timestamp = now.getFullYear() + this.pad(now.getMonth() + 1) + this.pad(now.getDate()) + '-' +
      this.pad(now.getHours()) + this.pad(now.getMinutes()) + this.pad(now.getSeconds()) + '-' + now.getMilliseconds()
    return screenshotDownloadDirectory + '/' + (safeName || '主页面') + '-full-page-' + timestamp + '.png'
  },

  /**
   * 提供截图 blob URL 供列表缩略图展示；无预览时返回空字符串。
   */
  getPreviewUrl(screenshotPath) {
    return this.previewUrls[screenshotPath] || ''
  },

  /**
   * 删除一张截图：同时清理下载记录文件、storage 跟踪以及本地预览 blob URL。
   * 仅匹配文件全路径结尾一致下载项，避免误删同名文件。
   */
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

  /**
   * 数字补零，用于时间戳格式化。
   */
  pad(value) {
    return String(value).padStart(2, '0')
  },

  /**
   * 计算相邻截图之间的重叠区高度（逻辑像素）。
   *
   * 目的：Element UI 页面往往同时存在页头、页签、工具栏和表格吸顶表头等固定元素，
   * 这些元素会出现在每一屏截图的同一位置。通过让两次截图保留一段重叠，拼接时丢弃
   * 每屏顶部的重叠区（即上一屏已绘制过的内容），把固定元素只保留首屏一份，避免长图中
   * 某个区域重复出现多次。
   *
   * 取值策略：不小于视口高度的 25%（至少 120px），但不超过 40%，
   * 以覆盖常见页头+吸顶栏总高度，同时避免重叠过大导致截图屏数过多。
   */
  getCaptureOverlap(viewportHeight) {
    // Vue + Element UI 页面经常同时存在页头、页签和表格吸顶栏。
    return Math.min(Math.floor(viewportHeight * 0.4), Math.max(120, Math.floor(viewportHeight * 0.25)))
  },

  /**
   * 延时工具，用于截图节流。
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
