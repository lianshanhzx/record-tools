/**
 * 页面元素扫描器控制器 (PageElementScannerController)
 * ============================================================
 * 专门负责调用 libs/pageElementScanner.js 的扫描器。
 *
 * 调用规则：
 *   1. 当 popup 被打开时（插件图标点击唤起）触发一次全量扫描。
 *   2. 仅在 popup 打开期间监听页面 DOM 变化；当检测到新增/显示的可视区域
 *      （弹窗打开、tab 切换、折叠展开、异步加载显示等）时，只扫描变化区域，
 *      并增量合并到已有的扫描结果中。
 *   3. popup 关闭时停止监听并清空扫描结果。
 *
 * 依赖（由 manifest.json 保证加载顺序）：
 *   - PageElementScanner (libs/pageElementScanner.js)
 *   - Recorder (content/recorder.js)
 */

const PageElementScannerController = (function () {
  'use strict'

  const POPUP_OPEN = 'popupOpened'
  const POPUP_CLOSE = 'popupClosed'
  const SCAN_OVERLAY_ID = '__record_tools_scan_overlay__'

  const config = {
    // 变化触发后等待多久再扫描，避免连续变化导致重复扫描
    debounceMs: 2000,
    // 两次扫描之间的最小间隔
    minIntervalMs: 2000,
    // 按钮点击后多久内的 DOM 变化会被视为由该按钮触发
    triggerMaxAgeMs: 1500,
    // 路由轮询及新页面渲染稳定等待
    routeCheckMs: 300,
    routeQuietMs: 600,
    routeMaxWaitMs: 5000,
    // 滚动/视口变化后的响应式 DOM 更新不属于用户主动打开的新区域
    passiveLayoutQuietMs: 3000,
    // 页签、折叠面板、按钮等主动操作后的异步渲染仍允许触发扫描
    uiActivationMaxAgeMs: 3000,
    // MutationObserver 配置
    observerOptions: {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden']
    }
  }

  let popupOpen = false
  let scanOverlayCount = 0
  let scanLifecycleVersion = 0
  let fullScanToken = null
  let scanOverlayKeydownListener = null
  let observer = null
  let debounceTimer = null
  let deferredRegionScanTimer = null
  let lastScanTime = 0
  let routeCheckTimer = null
  let routeScanTimer = null
  let routeMaxWaitTimer = null
  let routeScanPending = false
  let currentRouteIdentity = ''
  let currentPageContext = null
  const pageOrderMap = new Map()
  let nextPageOrder = 0
  // 在 debounce 窗口内累积所有 mutation 的根节点，避免只扫描最后一次 mutation 的 roots
  let pendingRoots = []

  // 弹窗等区域已出现、但尚处于 debounce 等待的扫描上下文。
  // 录制器在此期间操作新区域内元素时，可使用该上下文与随后扫描结果保持同一锚点。
  let pendingScanAnchor = null
  let lastScrollTime = 0
  let lastResizeTime = 0
  let lastUiActivationTime = 0
  let lastViewportWidth = window.innerWidth
  let lastViewportHeight = window.innerHeight
  let significantRootState = new WeakMap()

  // 用 "页面 + 元素 target + 锚点 target" 作为 key 保存扫描快照。
  // 同一弹窗组件被 A/B 按钮复用时，允许同一 DOM/XPath 在不同锚点下同时保留。
  const scannedElementMap = new Map()

  // 当前 DOM 元素最近一次所属的锚点上下文。
  // 后续无触发源的小 mutation 继续更新当前上下文，不覆盖历史锚点快照。
  let activeAnchorByElement = new WeakMap()

  // 最近点击的按钮类元素（作为增量扫描的触发源候选）
  let lastTrigger = null

  // 页面点击监听器引用，stopObserver 时移除
  let clickListener = null

  // ==================== 基础工具 ====================

  /** 在业务网页上显示扫描蒙层，阻止扫描期间继续操作页面。 */
  function showScanOverlay() {
    let overlay = document.getElementById(SCAN_OVERLAY_ID)
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = SCAN_OVERLAY_ID
      overlay.setAttribute('role', 'status')
      overlay.setAttribute('aria-live', 'assertive')
      overlay.setAttribute('aria-label', '正在扫描中, 请等扫描结束再操作~')
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(15,23,42,0.58)',
        'pointer-events:auto',
        'cursor:wait'
      ].join(';')

      const message = document.createElement('div')
      message.textContent = '正在扫描中, 请等扫描结束再操作~'
      message.style.cssText = [
        'padding:18px 28px',
        'border-radius:8px',
        'background:rgba(17,24,39,0.92)',
        'box-shadow:0 12px 36px rgba(0,0,0,0.28)',
        'color:#fff',
        'font:600 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
        'letter-spacing:0.2px',
        'text-align:center'
      ].join(';')
      overlay.appendChild(message)
      overlay.addEventListener('wheel', event => event.preventDefault(), { passive: false })
      overlay.addEventListener('touchmove', event => event.preventDefault(), { passive: false })
      ;(document.body || document.documentElement).appendChild(overlay)
    }
    if (!scanOverlayKeydownListener) {
      scanOverlayKeydownListener = event => event.preventDefault()
      document.addEventListener('keydown', scanOverlayKeydownListener, true)
    }
  }

  function removeScanOverlay() {
    const overlay = document.getElementById(SCAN_OVERLAY_ID)
    if (overlay) overlay.remove()
    if (scanOverlayKeydownListener) {
      document.removeEventListener('keydown', scanOverlayKeydownListener, true)
      scanOverlayKeydownListener = null
    }
  }

  /** 等待浏览器绘制蒙层；返回 null 表示等待期间 popup 已关闭。 */
  async function beginScanOverlay() {
    const version = scanLifecycleVersion
    scanOverlayCount++
    if (document.hidden) {
      return popupOpen && version === scanLifecycleVersion ? version : null
    }
    showScanOverlay()
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
    return popupOpen && version === scanLifecycleVersion ? version : null
  }

  function endScanOverlay(version) {
    if (version !== scanLifecycleVersion) return
    scanOverlayCount = Math.max(0, scanOverlayCount - 1)
    if (scanOverlayCount === 0) removeScanOverlay()
  }

  function forceRemoveScanOverlay() {
    scanLifecycleVersion++
    scanOverlayCount = 0
    removeScanOverlay()
  }

  /**
   * 判断元素是否在 DOM 中且可见。
   * 用于过滤无意义的 MutationObserver 变化。
   */
  function isVisibleElement(element) {
    if (!element || !element.isConnected) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return false
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return true
  }

  function markScrollActivity() {
    lastScrollTime = Date.now()
    cancelPassivePendingScan()
  }

  function markResizeActivity() {
    lastResizeTime = Date.now()
    lastViewportWidth = window.innerWidth
    lastViewportHeight = window.innerHeight
    cancelPassivePendingScan()
  }

  function detectViewportResize() {
    if (window.innerWidth === lastViewportWidth && window.innerHeight === lastViewportHeight) return
    markResizeActivity()
  }

  function hasRecentUiActivation() {
    return Date.now() - lastUiActivationTime <= config.uiActivationMaxAgeMs
  }

  function cancelPassivePendingScan() {
    if (hasRecentUiActivation()) return
    clearTimeout(debounceTimer)
    debounceTimer = null
    clearTimeout(deferredRegionScanTimer)
    deferredRegionScanTimer = null
    pendingRoots = []
    pendingScanAnchor = null
    lastTrigger = null
  }

  function isPassiveLayoutChange() {
    const passiveTime = Math.max(lastScrollTime, lastResizeTime)
    return passiveTime > lastUiActivationTime &&
      Date.now() - passiveTime <= config.passiveLayoutQuietMs
  }

  /**
   * 判断按钮所属的弹窗/抽屉是否仍然可见。
   * 关闭按钮会先触发 DOM 变化，若其容器已隐藏，则该变化不应继续沿用该按钮作为扫描锚点。
   */
  function isAnchorDialogVisible(element) {
    if (!element || typeof element.closest !== 'function') return true
    if (!element.isConnected) return false

    const dialog = element.closest(
      '.el-dialog__wrapper, .el-dialog, .el-drawer__wrapper, .el-drawer, ' +
      '.ant-modal-wrap, .ant-modal, .ivu-modal-wrap, .ivu-modal, ' +
      '.modal, .modal-dialog, .drawer, .dialog, [role="dialog"]'
    )
    if (!dialog) return true

    let node = dialog
    while (node && node !== document.documentElement) {
      try {
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') return false
      } catch (e) {
        return false
      }
      node = node.parentElement
    }
    return true
  }

  function getPageContext() {
    if (typeof ElementGrouper !== 'undefined' && typeof ElementGrouper.getCurrentPageContext === 'function') {
      return ElementGrouper.getCurrentPageContext()
    }
    return {
      key: '__page__',
      url: window.location.href,
      routeIdentity: window.location.origin + window.location.pathname
    }
  }

  function activatePageContext() {
    currentPageContext = getPageContext()
    currentRouteIdentity = currentPageContext.routeIdentity
    if (!pageOrderMap.has(currentPageContext.key)) {
      pageOrderMap.set(currentPageContext.key, nextPageOrder++)
    }
    return currentPageContext
  }

  function makeContextKey(pageKey, target, anchorTarget) {
    return (pageKey || '') + '\n@@target=' + (target || '') + '\n@@anchor=' + (anchorTarget || '')
  }

  /**
   * 从触发按钮解析扫描锚点信息。
   * 优先复用已有扫描快照，未命中时再生成 XPath 与业务名称，保证正常增量扫描和
   * 扫描等待期内的人工操作使用同一份锚点解析规则。
   */
  function resolveAnchorContext(anchorElement) {
    if (!anchorElement) return null

    const anchorInfo = findInternalInfoByElement(anchorElement)
    if (anchorInfo && anchorInfo.target) {
      return {
        target: anchorInfo.target,
        propertiesName: anchorInfo.propertiesName || ''
      }
    }

    let target = ''
    let propertiesName = ''
    try {
      if (typeof SmartSelector !== 'undefined') {
        target = new SmartSelector(anchorElement).getSelector() || ''
      }
    } catch (e) {
      console.warn('[ScannerController] 生成锚点 XPath 失败', e)
    }
    try {
      if (target && typeof getChineseLabelByElement !== 'undefined') {
        propertiesName = getChineseLabelByElement(anchorElement) || ''
      }
    } catch (e) {}

    return target ? { target: target, propertiesName: propertiesName } : null
  }

  /**
   * 将 mutation 根节点提升为其所属的显著 UI 容器。
   * Vue/Element UI 常把弹窗内部的某个 DIV 作为 mutation 节点；若只保存该 DIV，用户随后
   * 操作同一弹窗中的兄弟字段时无法命中待扫描上下文。提升到最近容器可覆盖整块新区域。
   */
  function resolvePendingScanRoot(root) {
    if (!root || typeof root.closest !== 'function') return root
    return root.closest(
      '.el-dialog__wrapper, .el-dialog, .el-drawer__wrapper, .el-drawer, ' +
      '.ant-modal-wrap, .ant-modal, .ivu-modal-wrap, .ivu-modal, ' +
      '.modal, .modal-dialog, .drawer, .dialog, [role="dialog"], ' +
      '.el-tab-pane, .ant-tabs-tabpane, .ivu-tabs-tabpane, .tab-pane, [role="tabpanel"], ' +
      '.el-collapse-item, .ant-collapse-item, .ivu-collapse-item, .collapse-panel, .collapse-item'
    ) || root
  }

  /**
   * 缓存当前待扫描区域的锚点。
   * MutationObserver 已经确认该点击引发显著 UI 变化，但真正扫描仍在 debounce
   * 窗口内。此时用户可以先操作新弹窗中的元素，录制器需要该上下文避免产生无锚点记录。
   */
  function updatePendingScanAnchor(roots) {
    if (!lastTrigger || !lastTrigger.active || !isAnchorDialogVisible(lastTrigger.element)) return

    const context = resolveAnchorContext(lastTrigger.element)
    if (!context) return

    if (!pendingScanAnchor || pendingScanAnchor.element !== lastTrigger.element) {
      pendingScanAnchor = {
        element: lastTrigger.element,
        target: context.target,
        propertiesName: context.propertiesName,
        roots: []
      }
    }
    roots.forEach(root => {
      const contextRoot = resolvePendingScanRoot(root)
      if (contextRoot && !pendingScanAnchor.roots.includes(contextRoot)) {
        pendingScanAnchor.roots.push(contextRoot)
      }
    })
  }

  /**
   * 返回待扫描区域中元素应使用的锚点上下文。
   * 仅在元素属于已识别的待扫描根节点，且触发按钮所在弹窗仍可见时返回；因此确认、
   * 取消等关闭弹窗按钮不会把关闭后的主页面变化错误绑定到自身。
   */
  function getPendingScanAnchorByElement(element) {
    if (!pendingScanAnchor || !element || !isAnchorDialogVisible(pendingScanAnchor.element)) return null

    const isInsidePendingRoot = pendingScanAnchor.roots.some(root => {
      if (!root || !root.isConnected || typeof root.contains !== 'function') return false
      // 弹窗可能以包装器本身、内部内容节点或新加子节点作为 mutation root。
      // 两者存在包含关系都代表当前元素属于这轮待扫描区域。
      return root.contains(element) || (typeof element.contains === 'function' && element.contains(root))
    })
    if (!isInsidePendingRoot) return null

    return {
      target: pendingScanAnchor.target,
      propertiesName: pendingScanAnchor.propertiesName
    }
  }

  /**
   * 克隆扫描信息，删除内部 DOM 引用和位置缓存，避免被序列化到 JSON。
   * 保留 anchorTarget / anchorPropertiesName 供 popup 展示锚点关系。
   */
  function cloneInfo(info) {
    const clone = Object.assign({}, info)
    delete clone._sourceElement
    delete clone._targetElement
    delete clone._rect
    delete clone._anchorElement
    if (info._anchorTarget) {
      clone.anchorTarget = info._anchorTarget
      let anchorName = info._anchorPropertiesName || ''
      for (const [targetEl, anchorInfo] of scannedElementMap) {
        if (anchorInfo.pageKey === info.pageKey && anchorInfo.target === info._anchorTarget) {
          anchorName = anchorInfo.propertiesName || anchorName
          break
        }
      }
      clone.anchorPropertiesName = anchorName
    }
    delete clone._anchorTarget
    delete clone._anchorPropertiesName
    delete clone._contextUpdatedAt
    return clone
  }

  /**
   * 根据缓存的位置信息重新排序，并把结果同步到 Recorder.scannedPageElements。
   * 排序规则：
   *   1. 先按视觉位置（top -> left）计算基础序；
   *   2. 若元素带有锚点（_anchorTarget），则整体移动到锚点元素之后；
   *   3. 同锚点的元素之间保持视觉顺序；
   *   4. 最后按最终顺序分配全局 scanIndex，popup 按 scanIndex 渲染。
   */
  function updatePublicArray() {
    const entries = Array.from(scannedElementMap.entries())

    // 刷新位置缓存与公开坐标：页面滚动/元素移动后，使用当前真实位置排序和标注。
    entries.forEach(entry => {
      const info = entry[1]
      try {
        if (info._targetElement && info._targetElement.isConnected) {
          info._rect = info._targetElement.getBoundingClientRect()
          if (typeof PageElementScanner !== 'undefined' && typeof PageElementScanner.getPagePosition === 'function') {
            info.position = PageElementScanner.getPagePosition(info._targetElement)
          }
        }
      } catch (e) {}
    })

    // 阶段 1：按视觉位置计算基础序
    const visualSorted = entries.slice().sort((a, b) => {
      const pageA = typeof a[1].pageOrder === 'number' ? a[1].pageOrder : 0
      const pageB = typeof b[1].pageOrder === 'number' ? b[1].pageOrder : 0
      if (pageA !== pageB) return pageA - pageB
      const rectA = a[1]._rect || { top: 0, left: 0 }
      const rectB = b[1]._rect || { top: 0, left: 0 }
      if (rectA.top !== rectB.top) return rectA.top - rectB.top
      return rectA.left - rectB.left
    })

    const targetToBaseIndex = new Map()
    const idToBaseIndex = new Map()
    visualSorted.forEach((entry, idx) => {
      const info = entry[1]
      if (info.target) targetToBaseIndex.set((info.pageKey || '') + '\n' + info.target, idx)
      idToBaseIndex.set(info.id, idx)
    })

    // 阶段 2：按锚点目标分组，计算每个锚点组内的子序号（保持视觉顺序）
    const anchorSubIndexMap = new Map()
    const anchorGroups = new Map()
    visualSorted.forEach(entry => {
      const anchorTarget = entry[1]._anchorTarget
      const anchorKey = (entry[1].pageKey || '') + '\n' + anchorTarget
      if (anchorTarget && targetToBaseIndex.has(anchorKey)) {
        if (!anchorGroups.has(anchorKey)) anchorGroups.set(anchorKey, [])
        anchorGroups.get(anchorKey).push(entry)
      }
    })
    anchorGroups.forEach(items => {
      items.forEach((item, idx) => {
        anchorSubIndexMap.set(item[1].id, idx)
      })
    })

    // 阶段 3：最终排序键 [锚点基础序或自身基础序, 是否有锚点, 子序号或自身基础序]
    entries.sort((a, b) => {
      const infoA = a[1], infoB = b[1]
      const baseA = idToBaseIndex.get(infoA.id)
      const baseB = idToBaseIndex.get(infoB.id)
      const anchorKeyA = (infoA.pageKey || '') + '\n' + infoA._anchorTarget
      const anchorKeyB = (infoB.pageKey || '') + '\n' + infoB._anchorTarget
      const anchorBaseA = infoA._anchorTarget && targetToBaseIndex.has(anchorKeyA)
        ? targetToBaseIndex.get(anchorKeyA) : null
      const anchorBaseB = infoB._anchorTarget && targetToBaseIndex.has(anchorKeyB)
        ? targetToBaseIndex.get(anchorKeyB) : null

      const keyA = anchorBaseA !== null
        ? [anchorBaseA, 1, anchorSubIndexMap.get(infoA.id)]
        : [baseA, 0, baseA]
      const keyB = anchorBaseB !== null
        ? [anchorBaseB, 1, anchorSubIndexMap.get(infoB.id)]
        : [baseB, 0, baseB]

      for (let i = 0; i < 3; i++) {
        if (keyA[i] !== keyB[i]) return keyA[i] - keyB[i]
      }
      return 0
    })

    // 按最终顺序分配全局索引
    entries.forEach((entry, index) => {
      entry[1].scanIndex = index
    })

    if (typeof Recorder !== 'undefined') {
      Recorder.scannedPageElements = entries.map(([_, info]) => cloneInfo(info))
    }
  }

  /**
   * 根据 DOM 元素查找当前上下文中的内部扫描信息。
   * 若同一 DOM 元素在多个锚点下都有快照，优先返回 activeAnchorByElement 指向的当前锚点版本。
   */
  function findCurrentInfoByElement(element) {
    if (!element) return null
    const pageKey = currentPageContext ? currentPageContext.key : getPageContext().key

    let matched = null
    for (const [contextKey, info] of scannedElementMap) {
      const targetEl = info._targetElement
      if (!targetEl) continue
      if (info.pageKey !== pageKey) continue
      if (targetEl === element || (typeof targetEl.contains === 'function' && targetEl.contains(element))) {
        const activeAnchor = activeAnchorByElement.get(targetEl)
        if (activeAnchor && info._anchorTarget === activeAnchor.target) return info
        if (!matched || (info._contextUpdatedAt || 0) >= (matched._contextUpdatedAt || 0)) {
          matched = info
        }
      }
    }
    if (matched) return matched

    // DOM 被 Vue/React 重渲染后，使用 XPath + 当前活动锚点兜底匹配。
    try {
      if (typeof SmartSelector !== 'undefined') {
        const target = new SmartSelector(element).getSelector()
        if (target) {
          const activeAnchor = activeAnchorByElement.get(element)
          if (activeAnchor) {
            const activeInfo = scannedElementMap.get(makeContextKey(pageKey, target, activeAnchor.target))
            if (activeInfo) return activeInfo
          }
          for (const [contextKey, info] of scannedElementMap) {
            if (info.pageKey === pageKey && info.target === target &&
                (!matched || (info._contextUpdatedAt || 0) >= (matched._contextUpdatedAt || 0))) {
              matched = info
            }
          }
        }
      }
    } catch (e) {
      console.warn('[ScannerController] XPath 兜底匹配失败', e)
    }

    return matched
  }

  /**
   * 根据 DOM 元素反查对应的扫描信息。
   * 支持元素自身命中，或被扫描目标元素包含的情况（如点击按钮内部的 span 时命中外层按钮）。
   * @param {Element} element 待查找的 DOM 元素
   * @returns {Object|null} 扫描信息副本；未命中返回 null
   */
  function findScannedInfoByElement(element) {
    const matched = findCurrentInfoByElement(element)
    return matched ? cloneInfo(matched) : null
  }

  /**
   * 根据 DOM 元素反查内部扫描信息对象（非克隆，用于需要修改引用的场景）。
   * 支持：1) DOM 引用匹配；2) 子元素命中外层按钮；3) 重新生成 XPath 匹配（处理 Vue/React 重渲染后 DOM 引用失效）。
   * @param {Element} element 待查找的 DOM 元素
   * @returns {Object|null} 内部扫描信息对象；未命中返回 null
   */
  function findInternalInfoByElement(element) {
    return findCurrentInfoByElement(element)
  }

  /**
   * 将最新的扫描结果同步到 popup 录制记录列表。
   * 每次扫描完成后都应调用，保证 popup 列表与实际扫描结果一致。
   */
  function notifyPopup(replacePageKey) {
    updatePublicArray()
    const elements = typeof Recorder !== 'undefined' ? Recorder.scannedPageElements : []
    chrome.runtime.sendMessage({
      type: 'addScannedElements',
      data: elements,
      currentPageKey: currentPageContext ? currentPageContext.key : '',
      replacePageKey: replacePageKey || ''
    })
    return elements.length
  }

  /**
   * 通知 popup 当前扫描状态。状态消息与扫描元素数据分离，避免影响列表合并和分组渲染。
   */
  function notifyScanStatus(status, count) {
    chrome.runtime.sendMessage({
      type: 'scanStatus',
      data: { status: status, count: count }
    })
  }

  function getScannedElementCount() {
    return typeof Recorder !== 'undefined' && Recorder.scannedPageElements
      ? Recorder.scannedPageElements.length
      : 0
  }

  // ==================== 扫描执行 ====================

  /**
   * 扫描指定根节点，并保留内部引用以便增量合并。
   * @param {Document|Element} root 扫描根节点
   * @returns {Array} 扫描结果数组
   */
  function scanRoot(root) {
    try {
      if (typeof PageElementScanner === 'undefined') {
        console.warn('[ScannerController] PageElementScanner 未加载')
        return []
      }
      const results = PageElementScanner.scan(root, { keepRefs: true })
      return results
    } catch (e) {
      console.error('[ScannerController] 扫描失败', e)
      return []
    }
  }

  /**
   * 全量扫描整个页面。
   * @param {boolean} force 是否忽略最小扫描间隔强制扫描
   */
  async function fullScan(force = false) {
    const now = Date.now()
    if (!popupOpen ||
        (fullScanToken && fullScanToken.version === scanLifecycleVersion) ||
        (!force && now - lastScanTime < config.minIntervalMs)) {
      return getScannedElementCount()
    }
    const scanToken = { version: scanLifecycleVersion }
    fullScanToken = scanToken

    notifyScanStatus('scanning', getScannedElementCount())
    const overlayVersion = await beginScanOverlay()
    if (overlayVersion === null) {
      if (fullScanToken === scanToken) fullScanToken = null
      return getScannedElementCount()
    }

    try {
      pendingScanAnchor = null
      const page = activatePageContext()
      for (const [contextKey, info] of scannedElementMap) {
        if (info.pageKey === page.key) scannedElementMap.delete(contextKey)
      }
      activeAnchorByElement = new WeakMap()
      lastTrigger = null
      const results = scanRoot(document)
      results.forEach(info => {
        info.pageKey = page.key
        info.pageUrl = page.url
        info.routeIdentity = page.routeIdentity
        info.pageOrder = pageOrderMap.get(page.key)
        info._contextUpdatedAt = Date.now()
        scannedElementMap.set(makeContextKey(info.pageKey, info.target, ''), info)
      })

      const count = notifyPopup(page.key)
      notifyScanStatus('completed', count)
      lastScanTime = Date.now()
      return count
    } finally {
      if (fullScanToken === scanToken) fullScanToken = null
      endScanOverlay(overlayVersion)
    }
  }

  /**
   * 将区域扫描结果合并到已有结果中。
   * 新增/更新的元素写入 scannedElementMap。
   * 已扫描过的元素不会因后续隐藏/移除而被删除，确保元素列表尽量全面。
   * 合并时保留旧记录中已有的锚点关系（第一次为准）。
   */
  function mergeRegionResults(regionResults) {
    regionResults.forEach(info => {
      const page = currentPageContext || activatePageContext()
      info.pageKey = page.key
      info.pageUrl = page.url
      info.routeIdentity = page.routeIdentity
      info.pageOrder = pageOrderMap.get(page.key)
      if (!info._anchorTarget && info._targetElement) {
        const activeAnchor = activeAnchorByElement.get(info._targetElement)
        if (activeAnchor) info._anchorTarget = activeAnchor.target
        if (activeAnchor) info._anchorPropertiesName = activeAnchor.name
      }

      const contextKey = makeContextKey(info.pageKey, info.target, info._anchorTarget)
      const oldInfo = scannedElementMap.get(contextKey)
      if (oldInfo && oldInfo._anchorTarget && !info._anchorTarget) {
        info._anchorTarget = oldInfo._anchorTarget
        info._anchorPropertiesName = oldInfo._anchorPropertiesName
      }
      info._contextUpdatedAt = Date.now()
      if (info._anchorTarget && info._targetElement) {
        activeAnchorByElement.set(info._targetElement, {
          target: info._anchorTarget,
          name: info._anchorPropertiesName || ''
        })
      }
      scannedElementMap.set(contextKey, info)
    })

    return notifyPopup()
  }

  /**
   * 扫描一个或多个变化区域，并增量合并。
   * @param {Element[]} roots 变化区域根节点数组
   * @param {Element|null} [anchorElement] 触发本次变化的按钮类元素（可选）
   */
  async function scanRegions(roots, anchorElement = null) {
    if (!popupOpen || document.hidden) return
    const now = Date.now()
    if (now - lastScanTime < config.minIntervalMs) {
      const remaining = config.minIntervalMs - (now - lastScanTime)
      const scheduledVersion = scanLifecycleVersion
      clearTimeout(deferredRegionScanTimer)
      deferredRegionScanTimer = setTimeout(() => {
        deferredRegionScanTimer = null
        if (popupOpen && !document.hidden && scheduledVersion === scanLifecycleVersion) {
          scanRegions(roots, anchorElement)
        }
      }, remaining)
      return
    }
    if (roots.length === 0) {
      pendingScanAnchor = null
      return
    }

    const visibleRoots = roots.filter(isVisibleElement)
    if (visibleRoots.length === 0) {
      pendingScanAnchor = null
      return
    }

    notifyScanStatus('scanning', getScannedElementCount())
    const overlayVersion = await beginScanOverlay()
    if (overlayVersion === null) return

    try {
      // 解析锚点信息
      let anchorTarget = null
      let anchorPropertiesName = null
      if (anchorElement) {
        const anchorContext = resolveAnchorContext(anchorElement)
        if (anchorContext) {
          anchorTarget = anchorContext.target
          anchorPropertiesName = anchorContext.propertiesName
        }
      }

      const allResults = []
      const actualRoots = []

      for (const root of visibleRoots) {
        const results = scanRoot(root)

        if (results.length > 0) {
          allResults.push(...results)
          actualRoots.push(root)
        } else if (root.parentElement &&
                   root.parentElement !== document.body &&
                   root.parentElement !== document.documentElement) {
          const parent = root.parentElement
          // 避免同一个父节点被多次扫描
          if (!actualRoots.includes(parent)) {
            const parentResults = scanRoot(parent)
            if (parentResults.length > 0) {
              allResults.push(...parentResults)
              actualRoots.push(parent)
            }
          }
        }
      }

      if (actualRoots.length === 0) {
        notifyScanStatus('completed', getScannedElementCount())
        pendingScanAnchor = null
        return
      }

      // 为本次新扫描到的元素标记锚点（首次为准，已存在锚点的元素不会被覆盖）
      if (anchorTarget) {
        allResults.forEach(info => {
          if (info.target === anchorTarget) return
          if (!info._anchorTarget) {
            info._anchorTarget = anchorTarget
            info._anchorPropertiesName = anchorPropertiesName || ''
          }
        })
      } else if (anchorElement) {
        console.warn('[ScannerController] 存在触发按钮但未能解析为有效锚点:', anchorElement)
      }

      const count = mergeRegionResults(allResults)
      notifyScanStatus('completed', count)
      pendingScanAnchor = null
      lastScanTime = Date.now()
    } finally {
      endScanOverlay(overlayVersion)
    }
  }

  // ==================== 路由变化扫描 ====================

  function clearRouteScanTimers() {
    clearTimeout(routeScanTimer)
    clearTimeout(routeMaxWaitTimer)
    routeScanTimer = null
    routeMaxWaitTimer = null
  }

  function executeRouteScan() {
    if (!popupOpen || !routeScanPending) return
    routeScanPending = false
    clearRouteScanTimers()
    fullScan(true)
  }

  function scheduleRouteScan() {
    if (!routeScanPending) return
    clearTimeout(routeScanTimer)
    routeScanTimer = setTimeout(executeRouteScan, config.routeQuietMs)
  }

  function handleRouteChanged() {
    const nextPage = getPageContext()
    if (nextPage.routeIdentity === currentRouteIdentity) return

    // 滚动定位或 DevTools/窗口尺寸变化引起的响应式路由更新不触发扫描。
    if (isPassiveLayoutChange()) {
      clearTimeout(debounceTimer)
      debounceTimer = null
      pendingRoots = []
      pendingScanAnchor = null
      lastTrigger = null
      routeScanPending = false
      clearRouteScanTimers()
      activatePageContext()
      return
    }

    clearTimeout(debounceTimer)
    debounceTimer = null
    pendingRoots = []
    pendingScanAnchor = null
    lastTrigger = null
    routeScanPending = true
    activatePageContext()
    clearRouteScanTimers()
    scheduleRouteScan()
    routeMaxWaitTimer = setTimeout(executeRouteScan, config.routeMaxWaitMs)
  }

  function startRouteObserver() {
    if (routeCheckTimer) return
    if (!currentPageContext) activatePageContext()
    routeCheckTimer = setInterval(handleRouteChanged, config.routeCheckMs)
  }

  function stopRouteObserver() {
    if (routeCheckTimer) clearInterval(routeCheckTimer)
    routeCheckTimer = null
    routeScanPending = false
    clearRouteScanTimers()
  }

  // ==================== DOM 变化识别 ====================

  /**
   * 从 MutationRecord 中提取需要扫描的区域根节点。
   * 仅保留以下三类显著 UI 变化：
   *   1. 页面弹窗 / 抽屉 / 模态框出现
   *   2. 折叠面板展开
   *   3. Tab 页签切换
   * 其他微小变化（文字更新、按钮状态变化、tooltip 等）不再触发扫描。
   * 去重规则：如果某个区域被另一个区域包含，则只保留外层区域。
   * 排除规则：组件自身的弹窗面板（日期面板、下拉选项、树选择面板等）不触发扫描。
   */
  function findAffectedRoots(mutations) {
    const roots = new Set()
    const suppressPassiveChange = isPassiveLayoutChange()
    const allowActiveAncestor = hasRecentUiActivation()
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return
          const candidates = findSignificantRoots(node, allowActiveAncestor)
          for (const root of candidates) {
            const newlyVisible = updateSignificantRootState(root)
            if (!suppressPassiveChange && (newlyVisible || (allowActiveAncestor && root.contains(node)))) {
              roots.add(root)
            }
          }
        })
      } else if (m.type === 'attributes') {
        const target = m.target
        if (!target || target.nodeType !== Node.ELEMENT_NODE) continue
        const candidates = findSignificantRoots(target, false)
        for (const root of candidates) {
          const newlyVisible = updateSignificantRootState(root)
          if (!suppressPassiveChange && newlyVisible) roots.add(root)
        }
      }
    }

    const uniqueRoots = Array.from(roots)
    return uniqueRoots
      .filter((root, _, arr) => {
        return !arr.some(other => other !== root && other.contains(root))
      })
      .filter(root => !isInPopupPanel(root))
  }

  /**
   * 判断元素是否属于需要触发扫描的显著 UI 容器。
   * 仅包含：页面弹窗/抽屉、折叠面板、Tab 页签相关元素。
   */
  const significantSelectors = [
      // 1. 页面弹窗 / 抽屉 / 模态框
      '.el-dialog', '.el-dialog__wrapper',
      '.el-drawer', '.el-drawer__wrapper',
      '.ant-modal', '.ant-modal-wrap', '.ant-modal-content',
      '.ivu-modal', '.ivu-modal-wrap',
      // '.el-message-box', '.el-message-box__wrapper',//提示信息的出现不扫描
      '.modal', '.modal-dialog', '.modal-content',
      '.drawer', '.drawer-content',
      '.dialog', '.dialog-content',
      '[role="dialog"]',

      // 2. 折叠面板
      '.el-collapse', '.el-collapse-item',
      '.el-collapse-item__wrap', '.el-collapse-item__content',
      '.ant-collapse', '.ant-collapse-item', '.ant-collapse-content',
      '.ivu-collapse', '.ivu-collapse-item',
      '.collapse', '.collapse-panel', '.collapse-content',

      // 3. Tab 页签
      '.el-tabs', '.el-tab-pane', '.el-tabs__content', '.el-tabs__item',
      '.ant-tabs', '.ant-tabs-tabpane', '.ant-tabs-content', '.ant-tabs-tab',
      '.ivu-tabs', '.ivu-tabs-tabpane', '.ivu-tabs-tab',
      '.tabs', '.tab-pane', '.tab-content', '.tab-item',
      '[role="tabpanel"]'
  ]

  /** 返回节点自身、内部以及主动操作时所属的显著扫描容器。 */
  function findSignificantRoots(element, includeAncestor) {
    const roots = new Set()
    if (!element || typeof element.matches !== 'function') return roots
    for (const selector of significantSelectors) {
      try {
        if (element.matches(selector)) roots.add(element)
        element.querySelectorAll?.(selector).forEach(root => roots.add(root))
        if (includeAncestor) {
          const ancestor = element.closest(selector)
          if (ancestor) roots.add(ancestor)
        }
      } catch (e) {
        // 无效选择器跳过
      }
    }
    return roots
  }

  function updateSignificantRootState(root) {
    const wasKnown = significantRootState.has(root)
    const wasVisible = significantRootState.get(root) === true
    const isVisible = isVisibleElement(root)
    significantRootState.set(root, isVisible)
    return isVisible && (!wasKnown || !wasVisible)
  }

  function rememberSignificantRootStates() {
    for (const selector of significantSelectors) {
      try {
        document.querySelectorAll(selector).forEach(root => {
          significantRootState.set(root, isVisibleElement(root))
        })
      } catch (e) {
        // 无效选择器跳过
      }
    }
  }

  /**
   * 判断元素是否位于组件自身的弹窗面板内。
   * 日期面板、下拉选项面板、树选择面板等出现时不应触发扫描。
   */
  function isInPopupPanel(element) {
    if (!element || typeof element.closest !== 'function') return false

    const panelSelectors = [
      '.el-picker-panel',            // Element UI 日期/时间选择面板（通用包装器）
      '.el-select-dropdown',         // Element UI 下拉选项面板（含树选择下拉）
      '.el-dropdown-menu',           // Element UI 下拉菜单
      '.el-cascader-panel',          // Element UI 级联选择面板
      '.el-autocomplete-suggestion', // Element UI 自动补全面板
      '.el-color-picker__panel',      // Element UI 颜色选择面板
      '.el-popover',                  // Element UI popover提示框(包括信贷里面的树弹窗)
    ]

    for (const selector of panelSelectors) {
      try {
        if (element.closest(selector) || element.matches(selector)) return true
      } catch (e) {
        // 无效选择器跳过
      }
    }
    return false
  }

  /**
   * MutationObserver 回调。
   * 仅在 popup 打开期间处理，且只会在变化后 debounce 扫描一次。
   */
  function onMutations(mutations) {
    if (!popupOpen || document.hidden) return

    detectViewportResize()
    handleRouteChanged()

    // 路由已变化时，所有 DOM 更新都用于判断新页面何时稳定，不参与旧的锚点增量扫描。
    if (routeScanPending) {
      scheduleRouteScan()
      return
    }

    const roots = findAffectedRoots(mutations)
    if (roots.length === 0) return

    // 在 debounce 窗口内累积所有批次的 roots，避免只扫描最后一批
    pendingRoots.push(...roots)

    // 若存在待触发的按钮点击，且首次显著变化发生在时间窗内，则激活该触发源
    if (lastTrigger && !lastTrigger.active) {
      const age = Date.now() - lastTrigger.time
      if (age <= config.triggerMaxAgeMs) {
        lastTrigger.active = true
      } else {
        lastTrigger.active = false
      }
    }

    updatePendingScanAnchor(roots)

    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      // 对累积的所有 roots 做一次去重
      const uniqueRoots = pendingRoots.filter((root, _, arr) => {
        return !arr.some(other => other !== root && other.contains(root))
      })
      pendingRoots = []
      let trigger = getRecentTrigger()
      if (trigger && !isAnchorDialogVisible(trigger)) {
        trigger = null
      }
      scanRegions(uniqueRoots, trigger)
      lastTrigger = null
    }, config.debounceMs)
  }

  /**
   * 获取最近有效的触发按钮元素。
   * 触发源在按钮点击时被记录；当首次显著 DOM 变化发生在 config.triggerMaxAgeMs 内时，
   * 触发源被激活，并在本次扫描完成前保持有效。
   * @returns {Element|null}
   */
  function getRecentTrigger() {
    if (!lastTrigger) return null
    if (!lastTrigger.active) return null
    return lastTrigger.element
  }

  /**
   * 页面点击监听回调。
   * 识别按钮类元素并记录为最近一次触发源，供增量扫描时关联。
   */
  function onClick(event) {
    if (!popupOpen) return
    const target = event.target
    const uiControl = target.closest?.(
      'button, a[href], [role="button"], [role="link"], [role="tab"], ' +
      '.el-tabs__item, .ant-tabs-tab, .ivu-tabs-tab, .tab-item, ' +
      '.el-collapse-item__header, .ant-collapse-header, .ivu-collapse-header, .collapse-header'
    )
    if (uiControl) lastUiActivationTime = Date.now()
    let triggerEl = null
    if (typeof PageElementScanner !== 'undefined' && typeof PageElementScanner.resolveButtonRoot === 'function') {
      triggerEl = PageElementScanner.resolveButtonRoot(target)
    }
    if (triggerEl) {
      lastTrigger = { element: triggerEl, time: Date.now(), active: false }
    }
  }

  // ==================== 生命周期管理 ====================

  function startObserver() {
    if (document.hidden) return
    if (!observer) {
      rememberSignificantRootStates()
      const target = document.body || document.documentElement
      observer = new MutationObserver(onMutations)
      observer.observe(target, config.observerOptions)
      clickListener = onClick
      document.addEventListener('click', clickListener, true)
    }
    startRouteObserver()
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    if (clickListener) {
      document.removeEventListener('click', clickListener, true)
      clickListener = null
    }
    clearTimeout(debounceTimer)
    debounceTimer = null
    clearTimeout(deferredRegionScanTimer)
    deferredRegionScanTimer = null
    stopRouteObserver()
    pendingRoots = []
    pendingScanAnchor = null
    lastTrigger = null
  }

  function onVisibilityChanged() {
    if (!popupOpen) return
    if (document.hidden) {
      stopObserver()
      forceRemoveScanOverlay()
      return
    }

    // 后台期间的 DOM 变化不补做增量扫描；仅在路由确实变化时走正常路由扫描。
    startObserver()
    handleRouteChanged()
  }

  function clearData() {
    scannedElementMap.clear()
    activeAnchorByElement = new WeakMap()
    pendingScanAnchor = null
    lastTrigger = null
    pageOrderMap.clear()
    nextPageOrder = 0
    currentPageContext = null
    currentRouteIdentity = ''
    significantRootState = new WeakMap()
    if (typeof Recorder !== 'undefined') {
      Recorder.scannedPageElements = []
    }
  }

  // ==================== 消息处理 ====================

  async function onPopupOpened() {
    popupOpen = true
    startObserver()
    await fullScan()
    const count = (typeof Recorder !== 'undefined' && Recorder.scannedPageElements)
      ? Recorder.scannedPageElements.length
      : 0
    return count
  }

  function onPopupClosed() {
    popupOpen = false
    forceRemoveScanOverlay()
    stopObserver()
    clearData()
  }

  function pause() {
    stopObserver()
  }

  function resume() {
    if (!popupOpen) return
    startObserver()
    handleRouteChanged()
  }

  function getCurrentPageContext() {
    const latest = getPageContext()
    if (!currentPageContext || latest.routeIdentity !== currentRouteIdentity) activatePageContext()
    return Object.assign({}, currentPageContext, {
      pageOrder: pageOrderMap.get(currentPageContext.key)
    })
  }

  function initMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === POPUP_OPEN) {
        onPopupOpened()
          .then(count => sendResponse({ status: 'popupOpened', count: count }))
          .catch(error => sendResponse({ status: 'popupOpened', error: error.message }))
        return true
      }
      if (request.type === POPUP_CLOSE) {
        onPopupClosed()
        sendResponse({ status: 'popupClosed' })
        return true
      }
      if (request.type === 'clearAndRescan') {
        // 重录：清空已有扫描结果，强制重新全量扫描
        clearTimeout(debounceTimer)
        debounceTimer = null
        pendingRoots = []
        clearData()
        fullScan(true)
          .then(count => sendResponse({ status: 'clearedAndRescanned', count: count }))
          .catch(error => sendResponse({ status: 'clearedAndRescanned', error: error.message }))
        return true
      }
      return false
    })
  }

  function init() {
    initMessageListener()
    document.addEventListener('visibilitychange', onVisibilityChanged)
    document.addEventListener('scroll', markScrollActivity, true)
    window.addEventListener('resize', markResizeActivity)
    window.visualViewport?.addEventListener('resize', markResizeActivity)
  }

  // ==================== 暴露接口 ====================
  return {
    init: init,
    onPopupOpened: onPopupOpened,
    onPopupClosed: onPopupClosed,
    fullScan: fullScan,
    scanRegions: scanRegions,
    pause: pause,
    resume: resume,
    getCurrentPageContext: getCurrentPageContext,
    findScannedInfoByElement: findScannedInfoByElement,
    getPendingScanAnchorByElement: getPendingScanAnchorByElement
  }
})()

PageElementScannerController.init()
