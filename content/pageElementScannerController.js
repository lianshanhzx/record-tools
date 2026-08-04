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

  const config = {
    // 变化触发后等待多久再扫描，避免连续变化导致重复扫描
    debounceMs: 2000,
    // 两次扫描之间的最小间隔
    minIntervalMs: 2000,
    // MutationObserver 配置
    observerOptions: {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden']
    }
  }

  let popupOpen = false
  let observer = null
  let debounceTimer = null
  let lastScanTime = 0
  // 在 debounce 窗口内累积所有 mutation 的根节点，避免只扫描最后一次 mutation 的 roots
  let pendingRoots = []

  // 用 targetElement 作为 key，保存完整的扫描信息（含内部 _rect 引用）
  const scannedElementMap = new Map()

  // ==================== 基础工具 ====================

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

  /**
   * 克隆扫描信息，删除内部 DOM 引用和位置缓存，避免被序列化到 JSON。
   */
  function cloneInfo(info) {
    const clone = Object.assign({}, info)
    delete clone._sourceElement
    delete clone._targetElement
    delete clone._rect
    return clone
  }

  /**
   * 根据缓存的位置信息重新排序，并把结果同步到 Recorder.scannedPageElements。
   */
  function updatePublicArray() {
    const entries = Array.from(scannedElementMap.entries())
    entries.sort((a, b) => {
      const rectA = a[1]._rect || { top: 0, left: 0 }
      const rectB = b[1]._rect || { top: 0, left: 0 }
      if (rectA.top !== rectB.top) return rectA.top - rectB.top
      return rectA.left - rectB.left
    })

    if (typeof Recorder !== 'undefined') {
      Recorder.scannedPageElements = entries.map(([_, info]) => cloneInfo(info))
    }
  }

  /**
   * 将最新的扫描结果同步到 popup 操作列表。
   * 每次扫描完成后都应调用，保证 popup 列表与实际扫描结果一致。
   */
  function notifyPopup() {
    updatePublicArray()
    chrome.runtime.sendMessage({
      type: 'addScannedElements',
      data: typeof Recorder !== 'undefined' ? Recorder.scannedPageElements.map(cloneInfo) : []
    })
  }

  // ==================== 扫描执行 ====================

  /**
   * 扫描指定根节点，并保留内部引用以便增量合并。
   * @param {Document|Element} root 扫描根节点
   * @param {string} reason 扫描触发原因，用于日志
   * @returns {Array} 扫描结果数组
   */
  function scanRoot(root, reason) {
    try {
      if (typeof PageElementScanner === 'undefined') {
        console.warn('[ScannerController] PageElementScanner 未加载')
        return []
      }
      const results = PageElementScanner.scan(root, { keepRefs: true })
      console.log(`[ScannerController] ${reason} 扫描区域 ${root?.nodeName || 'document'}，共 ${results.length} 个元素`)
      return results
    } catch (e) {
      console.error('[ScannerController] 扫描失败', e)
      return []
    }
  }

  /**
   * 全量扫描整个页面。
   */
  function fullScan(reason) {
    const now = Date.now()
    if (now - lastScanTime < config.minIntervalMs) return

    scannedElementMap.clear()
    const results = scanRoot(document, reason)
    results.forEach(info => {
      scannedElementMap.set(info._targetElement, info)
    })

    notifyPopup()
    lastScanTime = Date.now()
  }

  /**
   * 将区域扫描结果合并到已有结果中。
   *  - 新增/更新的元素写入 scannedElementMap。
   *  - 区域内已不存在于本次扫描结果的旧元素会被移除。
   */
  function mergeRegionResults(regionResults, roots) {
    const foundKeys = new Set()
    regionResults.forEach(info => {
      foundKeys.add(info._targetElement)
      scannedElementMap.set(info._targetElement, info)
    })

    // 清理区域内已消失或不再可见的元素
    for (const [key] of scannedElementMap) {
      if (!key.isConnected) {
        scannedElementMap.delete(key)
        continue
      }
      for (const root of roots) {
        if (root.contains(key) && !foundKeys.has(key)) {
          scannedElementMap.delete(key)
          break
        }
      }
    }

    notifyPopup()
  }

  /**
   * 扫描一个或多个变化区域，并增量合并。
   */
  function scanRegions(roots, reason) {
    const now = Date.now()
    if (now - lastScanTime < config.minIntervalMs) {
      const remaining = config.minIntervalMs - (now - lastScanTime)
      setTimeout(() => scanRegions(roots, reason), remaining)
      return
    }
    if (roots.length === 0) return

    const allResults = []
    const actualRoots = []

    for (const root of roots) {
      if (!isVisibleElement(root)) continue
      const results = scanRoot(root, reason)

      if (results.length > 0) {
        allResults.push(...results)
        actualRoots.push(root)
      } else if (root.parentElement &&
                 root.parentElement !== document.body &&
                 root.parentElement !== document.documentElement) {
        const parent = root.parentElement
        // 避免同一个父节点被多次扫描
        if (!actualRoots.includes(parent)) {
          const parentResults = scanRoot(parent, reason)
          if (parentResults.length > 0) {
            console.log(`[ScannerController] ${reason} 根节点 ${root.nodeName} 无元素，向上扫描父节点 ${parent.nodeName}，共 ${parentResults.length} 个元素`)
            allResults.push(...parentResults)
            actualRoots.push(parent)
          }
        }
      }
    }

    if (actualRoots.length === 0) return
    mergeRegionResults(allResults, actualRoots)
    lastScanTime = Date.now()
  }

  // ==================== DOM 变化识别 ====================

  /**
   * 清理已从 DOM 中移除的元素，避免关闭弹窗/移除区域后结果仍保留。
   */
  function removeDisconnectedElements() {
    for (const [key] of scannedElementMap) {
      if (!key.isConnected) {
        scannedElementMap.delete(key)
      }
    }
  }

  /**
   * 从 MutationRecord 中提取需要扫描的区域根节点。
   *  - 新增节点：直接取该节点作为区域。
   *  - 属性变化：取变化的目标元素作为区域。
   * 去重规则：如果某个区域被另一个区域包含，则只保留外层区域。
   */
  function findAffectedRoots(mutations) {
    const roots = new Set()
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) roots.add(node)
        })
      } else if (m.type === 'attributes') {
        const target = m.target
        if (target && target.nodeType === Node.ELEMENT_NODE) roots.add(target)
      }
    }

    const uniqueRoots = Array.from(roots)
    return uniqueRoots.filter((root, _, arr) => {
      return !arr.some(other => other !== root && other.contains(root))
    })
  }

  /**
   * MutationObserver 回调。
   * 仅在 popup 打开期间处理，且只会在变化后 debounce 扫描一次。
   */
  function onMutations(mutations) {
    if (!popupOpen) return

    const roots = findAffectedRoots(mutations)
    if (roots.length === 0) return

    // 先清理已从 DOM 移除的元素，避免关闭弹窗后结果仍残留
    removeDisconnectedElements()

    // 在 debounce 窗口内累积所有批次的 roots，避免只扫描最后一批
    pendingRoots.push(...roots)

    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      // 对累积的所有 roots 做一次去重
      const uniqueRoots = pendingRoots.filter((root, _, arr) => {
        return !arr.some(other => other !== root && other.contains(root))
      })
      pendingRoots = []
      scanRegions(uniqueRoots, 'domMutation')
    }, config.debounceMs)
  }

  // ==================== 生命周期管理 ====================

  function startObserver() {
    if (observer) return
    const target = document.body || document.documentElement
    observer = new MutationObserver(onMutations)
    observer.observe(target, config.observerOptions)
    console.log('[ScannerController] DOM 观察已启动')
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    clearTimeout(debounceTimer)
    debounceTimer = null
    pendingRoots = []
    console.log('[ScannerController] DOM 观察已停止')
  }

  function clearData() {
    scannedElementMap.clear()
    if (typeof Recorder !== 'undefined') {
      Recorder.scannedPageElements = []
    }
  }

  // ==================== 消息处理 ====================

  function onPopupOpened() {
    popupOpen = true
    startObserver()
    fullScan('popupOpened')
    const count = (typeof Recorder !== 'undefined' && Recorder.scannedPageElements)
      ? Recorder.scannedPageElements.length
      : 0
    return count
  }

  function onPopupClosed() {
    popupOpen = false
    stopObserver()
    clearData()
  }

  function initMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === POPUP_OPEN) {
        const count = onPopupOpened()
        sendResponse({ status: 'popupOpened', count: count })
        return true
      }
      if (request.type === POPUP_CLOSE) {
        onPopupClosed()
        sendResponse({ status: 'popupClosed' })
        return true
      }
      return false
    })
  }

  function init() {
    initMessageListener()

    // 页面从后台切回前台时，如果 popup 仍打开，补一次全量扫描
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && popupOpen) {
        fullScan('visibilityChange')
      }
    })
  }

  // ==================== 暴露接口 ====================
  return {
    init: init,
    onPopupOpened: onPopupOpened,
    onPopupClosed: onPopupClosed,
    fullScan: fullScan,
    scanRegions: scanRegions
  }
})()

PageElementScannerController.init()
