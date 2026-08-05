/**
 * 页面元素扫描器 (PageElementScanner)
 * ============================================================
 * 用于在开始录制时扫描当前页面中已渲染的表单元素与按钮元素，
 * 生成与录制记录格式对齐的 xpath / label 信息，供后续下载使用。
 *
 * 扫描范围：
 *   - 整页 DOM（包含当前未滚动到可视区的元素）。
 *   - 排除 display:none / visibility:hidden 所在容器内的元素。
 *   - 兼容 Element UI 等框架组件（.el-select / .el-date-editor / .el-radio / .el-checkbox 等）。
 *
 * 依赖（由 manifest.json 保证在 content_scripts 中先加载）：
 *   - SmartSelector              生成唯一 XPath
 *   - getChineseLabelByElement   提取中文业务名称/label
 *
 * 使用示例：
 *   const results = PageElementScanner.scan(document)
 *   console.log('扫描到元素数量:', results.length)
 *   console.log(results[0].target)      // xpath
 *   console.log(results[0].propertiesName) // label
 */

const PageElementScanner = (function () {
  'use strict'

  // ==================== 基础工具方法 ====================

  /**
   * 生成一个符合录制系统风格的 UUID，用于为每个扫描元素分配唯一 id。
   * @returns {string} 36 位 UUID 字符串
   */
  function uuid() {
    const hex = '0123456789abcdef'
    const s = []
    for (let i = 0; i < 36; i++) s[i] = hex.substr(Math.floor(Math.random() * 16), 1)
    s[14] = '4'
    s[19] = hex.substr((s[19] & 0x3) | 0x8, 1)
    s[8] = s[13] = s[18] = s[23] = '-'
    return s.join('')
  }

  // ==================== 可见性判断 ====================

  /**
   * 判断元素是否在 DOM 中且其所在容器可见。
   *
   * 注意：
   *   1. 本方法允许 Element UI 等框架中“功能性隐藏”的原生 input
   *      （例如 .el-radio / .el-checkbox 内部 display:none 的 input）
   *      因为这些 input 虽然视觉上被隐藏，但仍承载交互事件。
   *   2. 只要任一祖先容器被隐藏，就视为未渲染，避免扫到弹窗/抽屉里的隐藏元素。
   *
   * @param {Element} element 待判断的 DOM 元素
   * @returns {boolean} 是否已渲染
   */
  function isRendered(element) {
    if (!element || !element.isConnected) return false

    const tagName = element.tagName ? element.tagName.toLowerCase() : ''

    // 标记：是否为框架中功能性隐藏的单选/多选 input
    const isFrameworkHiddenInput = tagName === 'input' && (
      element.type === 'radio' || element.type === 'checkbox'
    ) && !!element.closest('.el-radio, .el-checkbox, .el-radio-group, .el-checkbox-group, .el-switch')

    // 自身样式不可见，且不是“功能性隐藏 input”时，认为未渲染
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      if (!isFrameworkHiddenInput) return false
    }

    // 检查祖先容器是否被隐藏
    let parent = element.parentElement
    while (parent) {
      const ps = window.getComputedStyle(parent)
      if (ps.display === 'none' || ps.visibility === 'hidden') return false
      parent = parent.parentElement
    }

    return true
  }

  // ==================== 排除规则 ====================

  /**
   * 获取页面元素扫描器的排除规则配置。
   * 配置由 config/scannerExclude.js 提供，在 content script 中先于本文件加载。
   * @returns {Object|null} 排除配置对象，未配置时返回 null
   */
  function getExcludeConfig() {
    if (typeof PageElementScannerExcludeConfig !== 'undefined') return PageElementScannerExcludeConfig
    return null
  }

  /**
   * 判断元素是否位于配置文件中指定的排除区域。
   *
   * 判定规则：
   *   1. 元素自身或其任一祖先命中 excludedSelectors 中的 CSS 选择器，则排除。
   *   2. 目标元素（targetElement）同样会被检查，确保包装器与其内部真实元素
   *      只要有一个在排除区域内，就整体跳过。
   *
   * @param {Element} element 候选源元素
   * @param {Element|null} targetElement 解析后的目标元素
   * @returns {boolean} 是否应被排除
   */
  function isExcludedBySelector(element, targetElement) {
    const cfg = getExcludeConfig()
    if (!cfg) return false
    const selectors = cfg.excludedSelectors || []
    if (!selectors.length) return false

    for (const selector of selectors) {
      if (!selector) continue
      try {
        if (typeof element.closest === 'function' && element.closest(selector)) return true
        if (targetElement && targetElement !== element && typeof targetElement.closest === 'function' && targetElement.closest(selector)) {
          return true
        }
      } catch (e) {
        console.warn('[PageElementScanner] 排除选择器无效:', selector, e)
      }
    }
    return false
  }

  /**
   * 根据配置的关键词排除元素。
   *
   * 匹配字段：propertiesName / label / placeholder / title / value。
   * 只要任一字段包含 excludedKeywords 中的关键词，即被排除。
   *
   * @param {Object} info 扫描元素信息对象
   * @returns {boolean} 是否应被排除
   */
  function isExcludedByKeywords(info) {
    const cfg = getExcludeConfig()
    if (!cfg) return false
    const keywords = cfg.excludedKeywords || []
    if (!keywords.length) return false

    const texts = [
      info.propertiesName,
      info.label,
      info.placeholder,
      info.title,
      info.value
    ].filter(Boolean)

    return keywords.some(k => k && texts.some(t => t.indexOf(k) !== -1))
  }

  /**
   * 判断 <a> 标签是否没有文本内容（空标签，如纯图标占位链接）。
   * 没有内容的 <a> 标签不纳入扫描。
   */
  function isEmptyAnchor(element) {
    if (!element || !element.tagName) return false
    if (element.tagName.toLowerCase() !== 'a') return false
    return !(element.innerText || '').trim()
  }

  /**
   * 判断是否为下拉框箭头等无实际意义的装饰图标。
   */
  function isDecorativeCaret(element) {
    if (!element || !element.tagName) return false
    const cls = element.getAttribute('class') || ''
    return /\bel-select__caret\b/.test(cls)
  }

  // ==================== 按钮识别 ====================

  /**
   * 判断元素是否属于按钮类元素，或在按钮类元素内部。
   *
   * 按钮判定优先级：
   *   1. 原生 <button>、<a>
   *   2. role="button"
   *   3. 带有 .el-button 类（Element UI 按钮）
   *   4. 位于 button / a / role=button / .el-button 内部时，返回外层按钮
   *
   * 这样做是为了避免把按钮内部的 <span>、<i> 图标等子元素也单独识别成按钮。
   *
   * @param {Element} element 待判断元素
   * @returns {Element|null} 按钮根元素；不是按钮则返回 null
   */
  function resolveButtonRoot(element) {
    if (!element || !element.tagName) return null
    const tagName = element.tagName.toLowerCase()

    // 1. 原生交互元素
    if (tagName === 'button' || tagName === 'a' || element.getAttribute('role') === 'button') {
      return element
    }

    // 2. Element UI 按钮类
    const classAttr = element.getAttribute('class') || ''
    if (/\bel-button\b/.test(classAttr)) return element

    // 3. 在按钮内部时，向上找到真正的按钮
    if (typeof element.closest === 'function') {
      return element.closest('button, a, [role="button"], .el-button')
    }

    return null
  }

  // ==================== 表单识别 ====================

  /**
   * 判断元素是否为表单类元素（原生或 Element UI 风格组件）。
   *
   * @param {Element} element 待判断元素
   * @returns {boolean}
   */
  function isFormElement(element) {
    if (!element || !element.tagName) return false
    const tagName = element.tagName.toLowerCase()

    // 原生表单标签
    if (['input', 'textarea', 'select'].includes(tagName)) return true

    // Element UI / 常见 UI 库表单组件
    if (typeof element.closest === 'function') {
      if (element.closest('.el-select, .el-date-editor, .tsscdatepicker, .el-radio, .el-checkbox, .el-radio-group, .el-checkbox-group')) {
        return true
      }
    }

    return false
  }

  // ==================== 元素种类判定 ====================

  /**
   * 获取元素的类型/种类（kind）。
   *
   * 该字段用于：
   *   - 决定 command/action（输入/选择/日期/点击）
   *   - 在下载的 JSON 中直观标识元素类型
   *
   * 判定顺序：
   *   1. Element UI 组件（.el-select / .el-date-editor / .tsscdatepicker）
   *   2. 原生表单元素（input / textarea / select）
   *   3. Element UI 单选/多选包装器（.el-radio / .el-checkbox）
   *   4. 按钮类元素
   *   5. 未知类型
   *
   * @param {Element} element 待判定元素
   * @returns {string} 元素种类，如 'input' / 'select' / 'date' / 'radio' / 'checkbox' / 'button' / 'unknown'
   */
  function getElementKind(element) {
    if (!element || !element.tagName) return 'unknown'
    const tagName = element.tagName.toLowerCase()

    // 1. 优先识别 Element UI 组件
    //    .el-select 表示下拉框；内部 input 是只读触发器
    if (element.closest('.el-select') || element.classList.contains('el-select')) return 'select'

    //    .el-date-editor / .tsscdatepicker 表示日期选择器
    if (element.closest('.el-date-editor') || element.classList.contains('el-date-editor') ||
        element.closest('.tsscdatepicker') || element.classList.contains('tsscdatepicker')) {
      return 'date'
    }

    // 2. 原生表单元素
    if (tagName === 'select') return 'select'
    if (tagName === 'textarea') return 'textarea'
    if (tagName === 'input') {
      const type = (element.type || 'text').toLowerCase()
      if (type === 'radio') return 'radio'
      if (type === 'checkbox') return 'checkbox'
      if (['date', 'datetime-local', 'month', 'week', 'time'].includes(type)) return 'date'
      // 其他常见 input 类型统一归为 input
      return 'input'
    }

    // 3. Element UI 单选/多选组件包装器
    //    这些组件内部的原生 input 通常是 display:none，我们直接识别包装器
    if (element.classList.contains('el-radio') || element.closest('.el-radio')) return 'radio'
    if (element.classList.contains('el-checkbox') || element.closest('.el-checkbox')) return 'checkbox'

    // 4. 按钮类元素
    if (resolveButtonRoot(element)) return 'button'

    return 'unknown'
  }

  // ==================== command 映射 ====================

  /**
   * 根据元素种类映射到录制命令，与现有录制系统的 command 字段保持一致。
   *
   * 映射规则：
   *   input / textarea   -> 'input'            输入动作
   *   select / radio / checkbox -> 'select'    选择动作
   *   date               -> 'fill_date_field'  日期填写动作
   *   button             -> 'click'            点击动作
   *
   * @param {string} kind 元素种类
   * @returns {string} 对应的 command
   */
  function getCommandByKind(kind) {
    switch (kind) {
      case 'input':
      case 'textarea':
        return 'input'
      case 'select':
      case 'radio':
      case 'checkbox':
        return 'select'
      case 'date':
        return 'fill_date_field'
      case 'button':
        return 'click'
      default:
        return 'input'
    }
  }

  // ==================== 目标元素解析 ====================

  /**
   * 针对 Element UI 等组件，找到最能代表该组件的可交互元素。
   *
   * 处理逻辑：
   *   - .el-select 包装器        -> 返回内部 input（触发下拉）
   *   - .el-date-editor 包装器   -> 返回内部 input（日期输入框）
   *   - .tsscdatepicker 包装器   -> 返回内部 input
   *   - .el-radio / .el-checkbox -> 返回组件包装器本身（原生 input 被隐藏）
   *   - 普通元素                 -> 返回自身
   *
   * 为什么要这样做？
   *   SmartSelector 生成 XPath 时，需要定位到“回放时真正能被操作”的元素。
   *   下拉框和日期框的实际可交互元素是内部 input；
   *   单选/多选的实际可点击区域是包装器，因此取包装器。
   *
   * @param {Element} element 扫描到的候选元素
   * @returns {Element} 用于生成 XPath 的目标元素
   */
  function resolveTargetElement(element) {
    if (!element || !element.tagName) return element
    const classAttr = element.getAttribute('class') || ''

    // ----- Element UI 下拉框 .el-select -----
    // 无论是 .el-select 包装器本身，还是它内部的 input，都统一指向内部 input
    const closestSelect = typeof element.closest === 'function' ? element.closest('.el-select') : null
    if (classAttr.includes('el-select') || closestSelect) {
      const root = classAttr.includes('el-select') ? element : closestSelect
      const input = root.querySelector('input:not([type="hidden"])')
      if (input) return input
    }

    // ----- Element UI 日期选择器 .el-date-editor / .tsscdatepicker -----
    const closestDate = typeof element.closest === 'function' ? element.closest('.el-date-editor, .tsscdatepicker') : null
    if (classAttr.includes('el-date-editor') || classAttr.includes('tsscdatepicker') || closestDate) {
      const root = (classAttr.includes('el-date-editor') || classAttr.includes('tsscdatepicker')) ? element : closestDate
      const input = root.querySelector('input:not([type="hidden"])')
      if (input) return input
    }

    // ----- Element UI 单选/多选 .el-radio / .el-checkbox -----
    // 原生 input 多为 display:none，取可见的包装器作为目标
    const closestRadio = typeof element.closest === 'function' ? element.closest('.el-radio') : null
    const closestCheckbox = typeof element.closest === 'function' ? element.closest('.el-checkbox') : null
    if (classAttr.includes('el-radio') || closestRadio) {
      return classAttr.includes('el-radio') ? element : closestRadio
    }
    if (classAttr.includes('el-checkbox') || closestCheckbox) {
      return classAttr.includes('el-checkbox') ? element : closestCheckbox
    }

    // 默认返回元素自身
    return element
  }

  // ==================== 候选元素收集 ====================

  /**
   * 从指定根节点收集所有需要扫描的候选元素。
   *
   * 收集策略：
   *   1. 表单元素：input / textarea / select / .el-select / .el-date-editor /
   *               .tsscdatepicker / .el-radio / .el-checkbox
   *   2. 按钮元素：button / a / [role="button"] / .el-button
   *
   * 对于按钮，会通过 resolveButtonRoot() 把按钮内部的子元素归一到外层按钮，
   * 避免 <button><span>文字</span></button> 产生重复扫描。
   *
   * @param {Document|Element} root 扫描根节点，默认 document
   * @returns {Element[]} 候选元素数组
   */
  function collectCandidates(root) {
    const candidates = new Set()

    // 当扫描具体区域（非 document）时，检查 root 自身是否就是表单/按钮元素。
    // 因为 querySelectorAll 只查后代，会漏掉作为叶子节点直接添加的 form/button。
    if (root !== document && root.nodeType === Node.ELEMENT_NODE) {
      if (isFormElement(root)) {
        candidates.add(root)
      }
      const btnRoot = resolveButtonRoot(root)
      if (btnRoot) {
        candidates.add(btnRoot)
      }
    }

    // ---- 表单相关元素 ----
    const formSelectors = [
      'input:not([type="hidden"])', // 原生输入框（同时会命中 el-select / el-date-editor 内部 input）
      'textarea',
      'select',
      '.el-select',       // Element UI 下拉框包装器
      '.el-date-editor',  // Element UI 日期选择器包装器
      '.tsscdatepicker',  // 天阳日期选择器包装器
      '.el-radio',        // Element UI 单选框包装器
      '.el-checkbox'      // Element UI 多选框包装器
    ]
    root.querySelectorAll(formSelectors.join(', ')).forEach(el => candidates.add(el))

    // ---- 按钮相关元素 ----
    root.querySelectorAll('button, a, [role="button"], .el-button').forEach(el => {
      const btnRoot = resolveButtonRoot(el)
      if (btnRoot) candidates.add(btnRoot)
    })

    return Array.from(candidates)
  }

  // ==================== 单个元素扫描 ====================

  /**
   * 扫描单个元素，生成与录制记录格式对齐的标准化描述对象。
   *
   * 生成的字段：
   *   id              UUID
   *   command/action  录制命令
   *   target          唯一 XPath
   *   targetType      固定为 'xpath'
   *   tagName         目标元素标签名
   *   kind            元素种类
   *   propertiesName  中文业务名称/label（与录制记录字段名一致）
   *   label           同上，冗余一份方便阅读
   *   placeholder     placeholder 提示
   *   title           title 属性
   *   value           当前值
   *   disabled        是否禁用
   *   required        是否必填
   *   readonly        是否只读
   *   type            input 类型
   *   timestamp       扫描时间戳
   *
   * @param {Element} element 候选元素（用于判定 kind）
   * @returns {Object} 元素信息对象
   */
  function scanElement(element) {
    const kind = getElementKind(element)
    const targetElement = resolveTargetElement(element)

    // ---- 生成 XPath ----
    // 复用项目已有的 SmartSelector，优先使用 id/data-testid/placeholder/name/text 等，
    // 最后降级为层级 XPath。
    let xpath = ''
    try {
      if (typeof SmartSelector !== 'undefined') {
        xpath = new SmartSelector(targetElement).getSelector()
      }
    } catch (e) {
      console.warn('[PageElementScanner] 生成 XPath 失败:', e, targetElement)
    }

    // ---- 提取中文 label / 业务对象名称 ----
    // 复用项目已有的 getChineseLabelByElement，支持 label[for]、el-form-item label、
    // aria-label、placeholder、按钮文本等多种策略。
    let label = ''
    try {
      if (typeof getChineseLabelByElement !== 'undefined') {
        label = getChineseLabelByElement(targetElement) || ''
      }
    } catch (e) {
      console.warn('[PageElementScanner] 获取 label 失败:', e, targetElement)
    }

    // ---- 提取其他属性 ----
    const tagName = targetElement.tagName ? targetElement.tagName.toLowerCase() : ''
    const inputType = targetElement.getAttribute ? (targetElement.getAttribute('type') || '') : ''
    const placeholder = targetElement.getAttribute ? (targetElement.getAttribute('placeholder') || '') : ''
    const title = targetElement.getAttribute ? (targetElement.getAttribute('title') || '') : ''
    const value = targetElement.value || ''
    const disabled = !!targetElement.disabled
    const required = !!targetElement.required
    const readonly = !!targetElement.readOnly

    return {
      id: uuid(),
      command: getCommandByKind(kind),
      action: getCommandByKind(kind),
      target: xpath,
      targetType: 'xpath',
      tagName: tagName,
      kind: kind,
      propertiesName: label,
      label: label,
      placeholder: placeholder,
      title: title,
      value: value,
      disabled: disabled,
      required: required,
      readonly: readonly,
      type: inputType,
      timestamp: Date.now()
    }
  }

  // ==================== 主入口 ====================

  /**
   * 扫描页面元素主入口。
   *
   * 执行流程：
   *   1. 收集所有表单元素与按钮元素候选。
   *   2. 过滤掉未渲染的元素。
   *   3. 通过 resolveTargetElement 统一目标元素，避免重复。
   *      例如：.el-select 包装器和它内部 input 会指向同一个 input，
   *      最终只保留一条记录。
   *   4. 为每个唯一目标生成 XPath / label 等信息。
   *   5. 按元素在页面中的位置（top -> left）排序，便于人工查看。
   *   6. 清理内部临时字段后返回结果数组。
   *
   * @param {Document|Element} root 扫描根节点，不传则默认 document
   * @param {Object} [options] 扫描选项
   * @param {boolean} [options.keepRefs=false] 是否保留内部 _sourceElement / _targetElement / _rect 引用
   * @returns {Object[]} 扫描结果数组
   */
  function scan(root, options) {
    root = root || document
    options = options || {}
    const results = []

    // seenSources：记录已经处理过的“候选元素”，防止同一候选被重复处理
    const seenSources = new Set()
    // seenTargets：记录已经输出过的“目标元素”，防止 .el-select 包装器和内部 input 产生重复记录
    const seenTargets = new Set()

    const candidates = collectCandidates(root)

    for (const element of candidates) {
      // 跳过未渲染的元素（如隐藏弹窗、抽屉内的元素）
      if (!isRendered(element)) continue

      // 跳过已处理过的候选元素
      if (seenSources.has(element)) continue
      seenSources.add(element)

      // 解析真正需要生成 XPath 的目标元素
      const targetElement = resolveTargetElement(element)
      if (!targetElement) continue

      // 跳过已输出过的目标元素（去重）
      if (seenTargets.has(targetElement)) continue
      seenTargets.add(targetElement)

      // 跳过配置文件中标记为排除的区域元素
      if (isExcludedBySelector(element, targetElement)) continue

      // 跳过没有文本内容的 <a> 标签（纯图标占位等无意义链接）
      if (isEmptyAnchor(element)) continue

      // 跳过下拉框图标等无实际意义的装饰元素
      if (isDecorativeCaret(element)) continue

      // 生成元素信息
      const info = scanElement(element)

      // 根据关键词进一步排除
      if (isExcludedByKeywords(info)) continue

      // 临时保存源元素和目标元素引用，用于后续按位置排序
      info._sourceElement = element
      info._targetElement = targetElement

      // 缓存目标元素位置信息，避免排序时重复调用 getBoundingClientRect
      try {
        info._rect = targetElement.getBoundingClientRect()
      } catch (e) {
        info._rect = { top: 0, left: 0, width: 0, height: 0 }
      }

      // 只有成功生成 XPath 的元素才保留（SmartSelector 通常都会生成）
      if (info.target) {
        results.push(info)
      }
    }

    // ---- 按页面位置排序 ----
    // 先按 top 从上到下，同一行再按 left 从左到右，
    // 这样下载的 JSON 顺序与页面视觉顺序基本一致，方便人工核对。
    results.sort((a, b) => {
      try {
        const rectA = a._rect || { top: 0, left: 0 }
        const rectB = b._rect || { top: 0, left: 0 }
        if (rectA.top !== rectB.top) return rectA.top - rectB.top
        return rectA.left - rectB.left
      } catch (e) {
        return 0
      }
    })

    // ---- 清理内部临时字段 ----
    // _sourceElement 和 _targetElement 是运行期 DOM 引用，不能序列化到 JSON 中
    // 当 options.keepRefs 为 true 时保留这些引用，供区域扫描控制器做增量合并。
    if (!options.keepRefs) {
      results.forEach(r => {
        delete r._sourceElement
        delete r._targetElement
        delete r._rect
      })
    }

    return results
  }

  // 暴露公共接口
  return {
    scan: scan
  }
})()

// 兼容 CommonJS / 浏览器环境
// 在浏览器扩展中通过 window.PageElementScanner 访问；
// 在 Node 测试环境中可通过 module.exports 引入。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PageElementScanner
} else {
  window.PageElementScanner = PageElementScanner
}
