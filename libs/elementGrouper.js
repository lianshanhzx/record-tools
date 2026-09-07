/**
 * 元素分组器 (ElementGrouper)
 * ============================================================
 * 负责将扫描/录制的元素按照页面显示区域进行树形分组。
 *
 * 分组规则：
 *   1. 同一个弹窗/抽屉（.el-dialog / .el-drawer / [role="dialog"] 等）下的元素为一组
 *   2. 同一个 Tab 页签（.el-tab-pane / [role="tabpanel"] / .tab-pane）下的元素为一组
 *   3. 同一个折叠面板（.el-collapse-item 等）下的元素为一组
 *
 * 分组路径按 DOM 真实嵌套关系排列（最外层 -> 最内层），
 * 例如弹窗内的页签中的折叠面板：[dialog, tab, collapse]。
 * 不属于任何容器的元素归入"主页面"默认组（type: 'page'）。
 *
 * 使用位置：
 *   - content 侧：getGroupPath(element) 计算元素的分组路径（依赖 DOM）
 *   - popup  侧：buildTree(items) 将扁平列表构建为树形结构（纯函数，不依赖 DOM）
 *
 * 依赖（由 manifest.json 保证在 content_scripts 中先加载）：
 *   - SmartSelector   为分组容器生成稳定且可序列化的 key
 */

const ElementGrouper = (function () {
  'use strict'

  /** 分组类型的中文显示名（popup 组标题徽标使用） */
  const GROUP_TYPE_LABELS = {
    dialog: '弹窗',
    tab: '页签',
    collapse: '折叠',
    page: '主页'
  }

  /** 默认组（主页面）的固定 key */
  const PAGE_GROUP_KEY = '__page__'

  /**
   * 生成用于区分业务页面的路由标识。
   * 普通 URL 忽略查询参数；Hash Router 仅保留 hash 中的路径部分。
   */
  function getRouteIdentity(locationLike) {
    const loc = locationLike || window.location
    const origin = loc.origin || ''
    const pathname = loc.pathname || '/'
    const hash = loc.hash || ''
    let hashPath = ''
    if (hash.indexOf('#/') === 0 || hash.indexOf('#!/') === 0) {
      hashPath = hash.replace(/^#!?/, '').split('?')[0]
    }
    return origin + pathname + (hashPath ? '#' + hashPath : '')
  }

  /**
   * 解析页面面包屑名称。
   * 仅识别应用主面包屑，按层级拼接各项文本，避免分隔符或嵌套节点带来重复内容。
   */
  function getBreadcrumbName() {
    try {
      const breadcrumb = document.querySelector('.el-breadcrumb.app-breadcrumb')
      if (!breadcrumb) return ''

      const items = breadcrumb.querySelectorAll('.el-breadcrumb__inner')
      const names = Array.prototype.map.call(items, item => cleanText(item.innerText || item.textContent))
        .filter(Boolean)
      return cleanText(names.join('-'))
    } catch (e) {
      return ''
    }
  }

  function getCurrentPageContext() {
    const routeIdentity = getRouteIdentity(window.location)
    return {
      type: 'page',
      propertiesName: getBreadcrumbName() || '主页面',
      key: PAGE_GROUP_KEY + ':' + encodeURIComponent(routeIdentity),
      fixedKey: true,
      url: window.location.href,
      routeIdentity: routeIdentity
    }
  }

  /**
   * 分组容器识别配置。
   * 一个节点只识别为第一种命中的类型（规则按优先级排列）。
   * 选择器与 content/pageElementScannerController.js 中的显著 UI 容器保持对齐。
   */
  const CONTAINER_RULES = [
    {
      type: 'dialog',
      selectors: ['.el-dialog', '.el-drawer', '[role="dialog"]', '.el-message-box', '.modal', '.dialog', '.drawer']
    },
    {
      type: 'tab',
      selectors: ['.el-tab-pane',  '.tab-pane'] , //'[role="tabpanel"]'这个大部分情况是虚拟的容器框
    },
    {
      type: 'collapse',
      selectors: ['.el-collapse-item', '.collapse-panel', '.collapse-item']
    }
  ]

  // 容器元素 -> 分组信息缓存，避免对同一容器重复生成名称与 key。
  // 使用 WeakMap，容器被移除后缓存自动回收。
  const containerCache = new WeakMap()

  // ==================== 基础工具 ====================

  /**
   * 清理文本：压缩空白字符并限制长度，用于组显示名。
   * @param {string} text 原始文本
   * @returns {string} 清理后的文本
   */
  function cleanText(text) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, 30)
  }

  // ==================== 分组路径计算（content 侧） ====================

  /**
   * 判断节点属于哪种分组容器类型。
   * @param {Element} node 待判断的 DOM 节点
   * @returns {string|null} 'dialog' / 'tab' / 'collapse'，未命中返回 null
   */
  function matchContainerType(node) {
    if (!node || typeof node.matches !== 'function') return null
    for (const rule of CONTAINER_RULES) {
      for (const selector of rule.selectors) {
        try {
          if (node.matches(selector)) return rule.type
        } catch (e) {
          // 无效选择器跳过
        }
      }
    }
    return null
  }

  /**
   * 解析弹窗/抽屉容器的显示名。
   * 优先级：aria-labelledby 引用元素 > 常见标题选择器 > aria-label > '弹窗'
   */
  function resolveDialogName(dialog) {
    const labelledBy = dialog.getAttribute('aria-labelledby')
    if (labelledBy) {
      const titleEl = document.getElementById(labelledBy)
      const text = cleanText(titleEl && titleEl.innerText)
      if (text) return text
    }
    const titleSelectors = [
      '.el-dialog__title',
      '.el-drawer__header',
      '.el-message-box__title',
      '.modal-title',
      '.dialog-title',
      '.drawer-title'
    ]
    for (const selector of titleSelectors) {
      const el = dialog.querySelector(selector)
      const text = cleanText(el && el.innerText)
      if (text) return text
    }
    const aria = cleanText(dialog.getAttribute('aria-label'))
    if (aria) return aria
    return '弹窗'
  }

  /**
   * 解析 Tab 页签面板的显示名。
   * 优先级：aria-labelledby 引用页签头 > 所属 tabs 容器中 aria-controls 反查 > label 属性 > '页签'
   */
  function resolveTabName(pane) {
    // 1. aria-labelledby → 对应页签头文本（标准 ARIA 结构，部分框架使用真实 id）
    const labelledBy = pane.getAttribute('aria-labelledby')
    if (labelledBy) {
      const tabItem = document.getElementById(labelledBy)
      const text = cleanText(tabItem && tabItem.innerText)
      if (text) return text
    }
    // 2. 通过 pane 的 tab-id / id 构造页签头 id
    //    Element UI 实际 DOM 中页签头 id 为 "tab-{tab-id}"，
    //    而 aria-labelledby 的值是逻辑引用（如 "tab-客户基本信息"），不能用 getElementById 直接定位。
    const tabId = pane.getAttribute('tab-id') || pane.id
    if (tabId) {
      const tabItem = document.getElementById('tab-' + tabId)
      const text = cleanText(tabItem && tabItem.innerText)
      if (text) return text
    }
    // 3. 在所属 tabs 容器中通过 aria-controls 反查页签头（其他 UI 框架可能使用此映射）
    const tabs = typeof pane.closest === 'function' ? pane.closest('.el-tabs, .tabs') : null
    if (tabs && pane.id) {
      try {
        const item = tabs.querySelector(
          '.el-tabs__item[aria-controls="' + pane.id + '"], [role="tab"][aria-controls="' + pane.id + '"]'
        )
        const text = cleanText(item && item.innerText)
        if (text) return text
      } catch (e) {
        // id 中含特殊字符导致选择器无效时跳过
      }
    }
    // 4. label / name 属性兜底
    const label = cleanText(pane.getAttribute('label'))
    if (label) return label
    return '页签'
  }

  /**
   * 解析折叠面板容器的显示名。
   * 优先级：常见面板头选择器 > '折叠面板'
   */
  function resolveCollapseName(item) {
    const headerSelectors = [
      '.el-collapse-item__header',
      '.collapse-header',
      '.collapse-title',
      '.panel-title'
    ]
    for (const selector of headerSelectors) {
      const el = item.querySelector(selector)
      const text = cleanText(el && el.innerText)
      if (text) return text
    }
    return '折叠面板'
  }

  /**
   * 为分组容器生成稳定且可序列化的 key。
   * 优先使用 SmartSelector 生成唯一 XPath；
   * 失败时降级为 "类型#同类容器中的序号"，保证同名组之间仍可区分。
   */
  function makeContainerKey(container, type) {
    try {
      if (typeof SmartSelector !== 'undefined') {
        const selector = new SmartSelector(container).getSelector()
        if (selector) return selector
      }
    } catch (e) {
      console.warn('[ElementGrouper] 生成容器 key 失败:', e, container)
    }
    try {
      const rule = CONTAINER_RULES.find(r => r.type === type)
      const all = document.querySelectorAll(rule.selectors.join(','))
      const idx = Array.prototype.indexOf.call(all, container)
      return type + '#' + (idx >= 0 ? idx : 0)
    } catch (e) {
      return type + '#0'
    }
  }

  /**
   * 获取容器节点的分组信息（带缓存）。
   * @param {Element} container 分组容器节点
   * @param {string} type 容器类型
   * @returns {{type: string, propertiesName: string, key: string}} 分组节点描述
   */
  function getContainerInfo(container, type) {
    let info = containerCache.get(container)
    if (!info) {
      let name
      try {
        if (type === 'dialog') name = resolveDialogName(container)
        else if (type === 'tab') name = resolveTabName(container)
        else if (type === 'collapse') name = resolveCollapseName(container)
      } catch (e) {
        console.warn('[ElementGrouper] 解析容器名称失败:', e, container)
      }
      info = {
        type: type,
        propertiesName: name || GROUP_TYPE_LABELS[type] || '分组',
        key: makeContainerKey(container, type)
      }
      containerCache.set(container, info)
    }
    return info
  }

  /**
   * 计算元素的分组路径（content 侧调用，依赖 DOM）。
   *
   * 从元素向上遍历祖先链，收集命中的分组容器，
   * 返回按"最外层 -> 最内层"排列的分组路径数组。
   * 路径第一层始终为当前路由对应的"主页面"，其后追加 DOM 容器分组。
   *
   * @param {Element} element 目标元素
   * @returns {Array<{type: string, propertiesName: string, key: string}>} 分组路径
   */
  function getGroupPath(element) {
    const page = getCurrentPageContext()
    if (!element || !element.parentElement) return [page]
    const path = []
    let node = element.parentElement
    while (node && node !== document.body && node !== document.documentElement) {
      const type = matchContainerType(node)
      if (type) {
        // 一个提示框常同时存在 wrapper、dialog、content 等嵌套节点，
        // 它们代表同一个可操作区域，分组路径只保留最近的 dialog 容器。
        if (type === 'dialog' && path.some(item => item.type === 'dialog')) {
          node = node.parentElement
          continue
        }
        // 直接取缓存中的字段副本，避免外部修改污染缓存
        const info = getContainerInfo(node, type)
        path.unshift({ type: info.type, propertiesName: info.propertiesName, key: info.key })
      }
      node = node.parentElement
    }
    return [page].concat(path)
  }

  // ==================== 树形构建（popup 侧） ====================

  /**
   * 将带有 group 分组路径的扁平列表构建为树形结构（popup 侧调用，纯函数）。
   *
   * 返回节点结构：
   *   { key, type, propertiesName, children: [子组节点...], items: [原始记录...] }
   *
   * 规则：
   *   - group 为空的记录归入"主页面"默认组（type: 'page'）
   *   - 组的出现顺序按记录中首次出现的顺序
   *   - 每个节点的 items 保持原列表中的相对顺序
   *
   * @param {Array} items 扁平记录列表（每项可带 group 分组路径数组）
   * @returns {Array} 树形结构的根节点数组
   */
  function buildTree(items) {
    const roots = []
    const nodeMap = new Map()

    ;(items || []).forEach(item => {
      const path = Array.isArray(item.group) ? item.group.filter(g => g && (g.key || g.propertiesName)) : []

      // 无分组信息 → 归入"主页面"默认组
      if (path.length === 0) {
        let pageNode = nodeMap.get(PAGE_GROUP_KEY)
        if (!pageNode) {
          pageNode = { key: PAGE_GROUP_KEY, type: 'page', propertiesName: '主页面', children: [], items: [] }
          nodeMap.set(PAGE_GROUP_KEY, pageNode)
          roots.push(pageNode)
        }
        pageNode.items.push(item)
        return
      }

      // 沿分组路径逐级创建/复用节点，记录挂到最内层节点
      let children = roots
      let prefix = ''
      let deepest = null
      path.forEach(g => {
        const nodeKey = prefix + '|' + (g.type || '') + ':' + (g.key || g.propertiesName)
        let node = nodeMap.get(nodeKey)
        if (!node) {
          node = {
            key: nodeKey,
            type: g.type || 'group',
            propertiesName: g.propertiesName || '分组',
            children: [],
            items: []
          }
          nodeMap.set(nodeKey, node)
          children.push(node)
        }
        deepest = node
        children = node.children
        prefix = nodeKey
      })
      deepest.items.push(item)
    })

    return roots
  }

  // 暴露公共接口
  return {
    GROUP_TYPE_LABELS: GROUP_TYPE_LABELS,
    PAGE_GROUP_KEY: PAGE_GROUP_KEY,
    getRouteIdentity: getRouteIdentity,
    getCurrentPageContext: getCurrentPageContext,
    getGroupPath: getGroupPath,
    buildTree: buildTree
  }
})()

// 兼容 CommonJS / 浏览器环境
// 在浏览器扩展中通过 window.ElementGrouper 访问；
// 在 Node 测试环境中可通过 module.exports 引入。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ElementGrouper
} else {
  window.ElementGrouper = ElementGrouper
}
