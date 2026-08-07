/**
 * 智能选择器 (XPath 版本)
 *
 * 核心策略：
 * 1. 优先使用元素自身的稳定属性（data-testid / aria-label / name 等）
 * 2. 向上查找最近的稳定祖先作为"锚点"，锚点后使用 // 连接
 * 3. 锚点内部的路径段之间使用 /（子轴），保持结构精确性
 * 4. 按钮/链接优先使用文本内容定位
 * 5. 过滤 el-row/el-col 等布局类名
 * 6. 路径不唯一时自动加同级索引兜底
 */

function quoteXPathValue(value) {
  const s = String(value);
  if (s.indexOf("'") === -1) return `'${s}'`;
  if (s.indexOf('"') === -1) return `"${s}"`;
  const parts = s.split("'").map(part => `'${part}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

/**
 * 判断类名是否稳定（非框架动态生成、非通用布局类）
 */
function isStableClassName(className) {
  if (!className || className.length < 2) return false;
  if (/^data-v-/.test(className)) return false;              // Vue scoped
  if (/^(is-|has-)/.test(className)) return false;           // 状态类
  if (/[_-]{2}[a-z0-9]{4,}$/i.test(className)) return false; // 随机后缀
  if (/^\d+$/.test(className)) return false;                 // 纯数字

  // 过滤 Element UI 通用布局类（页面出现次数过多，无定位价值）
  const layoutClasses = [
    'el-row', 'el-col', 'el-scrollbar', 'el-container',
    'el-header', 'el-main', 'el-footer', 'el-aside',
  ];
  if (layoutClasses.includes(className)) return false;
  if (/^el-col-\d+$/.test(className)) return false;          // el-col-12 等栅格类

  return true;
}

/**
 * 判断属性值是否为框架动态生成（不应用于定位）
 */
function isDynamicValue(value) {
  if (!value) return true;
  if (/\d{6,}/.test(value)) return true;                     // 长数字
  if (/^[a-zA-Z0-9]{12,}$/.test(value)) return true;         // 长哈希
  if (/^el-id-/.test(value)) return true;                    // Element UI 动态 ID
  if (/^el-collapse-content-\d+$/.test(value)) return true;  // Element UI collapse 动态 ID
  return false;
}

class SmartSelector {
  constructor(element) {
    this.element = element;
    this.semanticTags = ['button', 'input', 'a', 'img', 'textarea', 'select'];
    this.testAttributes = [
      'data-testid', 'data-cy', 'data-test', 'data-qa',
      'aria-label', 'data-track', 'data-field',
      'id', 'label',
    ];
    this.usefulAttrs = ['name', 'title', 'alt', 'type', 'role', 'aria-labelledby', 'for', 'href', 'placeholder'];
  }

  /**
   * 主入口
   */
  getSelector() {
    // 1. 测试属性 / ID
    const idOrTestAttrXPath = this.findUniqueIdOrTestAttrXPath();
    if (idOrTestAttrXPath) return idOrTestAttrXPath;

    // 2. placeholder
    const uniquePlaceholderXPath = this.findUniquePlaceholderXPath();
    if (uniquePlaceholderXPath) return uniquePlaceholderXPath;

    // 3. 业务属性
    const uniqueAttrXPath = this.findUniqueAttributeXPath();
    if (uniqueAttrXPath) return uniqueAttrXPath;

    // 4. 文本内容
    const textXPath = this.findTextXPath();
    if (textXPath) return textXPath;

    // 5. 降级：构建相对路径
    return this.getXPathFromElement();
  }

  // ==================== 阶段 1-4：直接属性策略 ====================

  findUniqueIdOrTestAttrXPath() {
    for (const attr of this.testAttributes) {
      if (!this.element.hasAttribute(attr)) continue;
      const value = this.element.getAttribute(attr);
      if (!value || !value.trim()) continue;
      if (attr === 'id' && isDynamicValue(value)) continue;

      const upperXpath = this.getUpperSpecialElementXPath(this.element);
      const xpath = upperXpath + `//*[@${attr}=${quoteXPathValue(value)}]`;
      if (this.isUniqueXPath(xpath)) return xpath;
    }
    return null;
  }

  findUniquePlaceholderXPath() {
    const selectElement = this.element.closest(".el-select");
    if (selectElement) return null;

    const tagName = this.element.tagName.toLowerCase();
    if (this.element.hasAttribute('placeholder')) {
      const value = this.element.getAttribute('placeholder');
      if (value && value.length <= 20) {
        const upperXpath = this.getUpperSpecialElementXPath(this.element);
        const xpath = upperXpath + `//${tagName}[@placeholder=${quoteXPathValue(value)}]`;
        if (this.isUniqueXPath(xpath)) return xpath;
      }
    }
    return null;
  }

  findUniqueAttributeXPath() {
    const tagName = this.element.tagName.toLowerCase();

    for (const attr of this.usefulAttrs) {
      if (!this.element.hasAttribute(attr)) continue;
      const value = this.element.getAttribute(attr);
      if (!value || value.length > 30 || !value.trim()) continue;

      if (attr === 'href' && tagName !== 'a') continue;
      if (attr === 'for' && tagName !== 'label') continue;
      if (attr === 'type' && value.length > 15) continue;

      const upperXpath = this.getUpperSpecialElementXPath(this.element);
      const xpath = upperXpath + `//${tagName}[@${attr}=${quoteXPathValue(value)}]`;
      if (this.isUniqueXPath(xpath)) return xpath;
    }
    return null;
  }

  findTextXPath() {
    const tagName = this.element.tagName.toLowerCase();
    let text = '';
    if (this.element.innerText) {
      text = this.element.innerText.trim();
    } else if (this.element.textContent) {
      text = this.element.textContent.trim();
    }

    if (text && text.length <= 20 && text.length > 0) {
      const upperXpath = this.getUpperSpecialElementXPath(this.element);
      const exactXPath = upperXpath + `//${tagName}[normalize-space()=${quoteXPathValue(text)}]`;
      if (this.isUniqueXPath(exactXPath)) return exactXPath;
    }
    return null;
  }

  // ==================== 阶段 5：相对路径策略 ====================

  /**
   * 降级方案入口
   */
  getXPathFromElement() {
    // 1. 特殊容器处理
    const dialogElement = this.element.closest(".el-dialog__wrapper");
    const popoverElement = this.element.closest('.el-popover:not(.el-popover_)');

    if (dialogElement && dialogElement.style.display !== "none") {
      const containerXPath = `//div[contains(@class, 'el-dialog__wrapper')][not(contains(@style, 'display: none'))]`;
      const innerPath = this.buildRelativeXPath(this.element, dialogElement);
      // innerPath 形如 /seg1/seg2/target（不含开头的 //），拼接到容器后
      return `${containerXPath}${innerPath}`;
    }

    if (popoverElement && popoverElement.style.display !== "none") {
      const containerXPath = `//div[contains(@class, 'el-popover')][not(contains(@class, 'el-popover_'))][not(contains(@style, 'display: none'))]`;
      const innerPath = this.buildRelativeXPath(this.element, popoverElement);
      return `${containerXPath}${innerPath}`;
    }

    // 2. 兄弟节点关系定位
    const siblingXPath = this.findSiblingBasedXPath();
    if (siblingXPath) return siblingXPath;

    // 3. 构建相对路径
    return this.buildRelativeXPath(this.element);
  }

  /**
   * 核心算法：构建相对 XPath
   *
   * 从目标元素向上遍历：
   * - 每一级获取最佳路径段（按钮优先文本，其次属性，再次稳定类名，最后索引）
   * - 遇到稳定唯一锚点时，返回 锚点XPath + // + 相对路径（段间用 / 连接）
   * - 路径不唯一时，给目标段加同级索引兜底
   *
   * @param {Element} target - 目标元素
   * @param {Element|null} boundaryElement - 边界元素（如 dialog），到达后停止
   * @returns {string} 以 // 或 / 开头的相对 XPath
   */
  buildRelativeXPath(target, boundaryElement = null) {
    const segments = [];
    let current = target;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      // 到达边界或文档根，停止
      if (current === boundaryElement || current === document.body || current === document.documentElement) {
        break;
      }

      // 先检查当前祖先是否为稳定锚点（segments 里存的是 current 后代到 target 的路径）
      if (current !== target) {
        const anchorLocator = this.getStableLocator(current);
        if (anchorLocator) {
          const anchorXPath = `//${anchorLocator}`;
          if (this.isUniqueXPath(anchorXPath)) {
            const result = this.tryBuildFromAnchor(anchorXPath, segments, target);
            if (result) return result;
            // 锚点路径不唯一，继续向上找更近的锚点或更多上下文
          }
        }
      }

      // 获取当前元素的最佳路径段
      const segment = this.getBestPathSegment(current);
      segments.unshift(segment);

      // 检查累积路径是否唯一（段间用 / 连接）
      const currentPath = `//${segments.join('/')}`;
      if (this.isUniqueXPath(currentPath, target)) {
        return currentPath;
      }

      current = current.parentElement;
    }

    // 兜底：路径不唯一，给目标段加同级索引
    return this.buildFallbackXPath(segments, target);
  }

  /**
   * 尝试从锚点构建唯一路径
   * 优先 //锚点//seg1/seg2/target，其次加索引
   */
  tryBuildFromAnchor(anchorXPath, segments, target) {
    if (segments.length === 0) return anchorXPath;

    const relativePath = segments.join('/');

    // 尝试 //锚点//路径
    let fullXPath = `${anchorXPath}//${relativePath}`;
    if (this.isUniqueXPath(fullXPath, target)) {
      return fullXPath;
    }

    // 尝试给目标段加同级索引
    const indexedSegments = [...segments];
    indexedSegments[indexedSegments.length - 1] = this.addSiblingIndex(target, segments[segments.length - 1]);
    fullXPath = `${anchorXPath}//${indexedSegments.join('/')}`;
    if (this.isUniqueXPath(fullXPath, target)) {
      return fullXPath;
    }

    return null;
  }

  /**
   * 兜底方案：路径不唯一时，给目标段加同级索引
   */
  buildFallbackXPath(segments, target) {
    if (segments.length === 0) {
      const tagName = target.tagName.toLowerCase();
      return `//${tagName}[${this.getSiblingIndex(target)}]`;
    }

    // 给目标段加索引
    const indexed = [...segments];
    indexed[indexed.length - 1] = this.addSiblingIndex(target, indexed[indexed.length - 1]);

    let path = `//${indexed.join('/')}`;
    if (this.isUniqueXPath(path, target)) {
      return path;
    }

    // 索引后仍不唯一（极端情况），尝试逐级向上加索引
    for (let i = indexed.length - 2; i >= 0; i--) {
      const el = this.getElementAtDepth(target, indexed.length - 1 - i);
      if (el) {
        indexed[i] = this.addSiblingIndex(el, indexed[i]);
        path = `//${indexed.join('/')}`;
        if (this.isUniqueXPath(path, target)) {
          return path;
        }
      }
    }

    // 最终兜底：返回带索引的路径（即使不唯一也是最佳努力结果）
    return path;
  }

  /**
   * 获取目标元素向上第 depth 级的祖先元素
   */
  getElementAtDepth(target, depth) {
    let el = target;
    for (let i = 0; i < depth && el; i++) {
      el = el.parentElement;
    }
    return el;
  }

  /**
   * 给路径段添加同级索引
   * button[@type='button'] → button[2][@type='button']
   * button → button[2]
   */
  addSiblingIndex(element, segment) {
    const index = this.getSiblingIndex(element);
    const bracketPos = segment.indexOf('[');
    if (bracketPos === -1) {
      return `${segment}[${index}]`;
    }
    // 索引插入为第一个谓词（表示同级第N个）
    return segment.slice(0, bracketPos) + `[${index}]` + segment.slice(bracketPos);
  }

  /**
   * 获取元素在同名兄弟节点中的位置（1-based）
   */
  getSiblingIndex(element) {
    const parent = element.parentElement;
    if (!parent) return 1;
    const siblings = Array.from(parent.children).filter(c => c.tagName === element.tagName);
    if (siblings.length <= 1) return 1;
    return siblings.indexOf(element) + 1;
  }

  /**
   * 兄弟节点关系定位
   * 示例：//label[normalize-space()='Email']/following-sibling::input[1]
   */
  findSiblingBasedXPath() {
    const targetTag = this.element.tagName.toLowerCase();
    let sibling = this.element.previousElementSibling;
    let position = 1;

    while (sibling && position <= 3) {
      // 兄弟节点文本
      const text = sibling.textContent?.trim();
      if (text && text.length > 0 && text.length <= 20) {
        const siblingTag = sibling.tagName.toLowerCase();
        const xpath = `//${siblingTag}[normalize-space()=${quoteXPathValue(text)}]/following-sibling::${targetTag}[${position}]`;
        if (this.isUniqueXPath(xpath, this.element)) {
          return xpath;
        }
      }

      // 兄弟节点稳定属性
      const siblingLocator = this.getStableLocator(sibling);
      if (siblingLocator) {
        const xpath = `//${siblingLocator}/following-sibling::${targetTag}[${position}]`;
        if (this.isUniqueXPath(xpath, this.element)) {
          return xpath;
        }
      }

      sibling = sibling.previousElementSibling;
      position++;
    }

    return null;
  }

  // ==================== 辅助方法 ====================

  /**
   * 获取元素的稳定锚点定位器（严格模式，仅用于识别锚点）
   */
  getStableLocator(element) {
    const tagName = element.tagName.toLowerCase();

    // 1. 测试属性
    for (const attr of this.testAttributes) {
      if (!element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr);
      if (!value || !value.trim()) continue;
      if (attr === 'id' && isDynamicValue(value)) continue;
      return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
    }

    // 2. aria / role
    for (const attr of ['aria-label', 'role']) {
      if (!element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr);
      if (value && value.trim() && value.length <= 30) {
        return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
      }
    }

    // 3. 语义化元素的 name/title/alt
    if (this.semanticTags.includes(tagName)) {
      for (const attr of ['name', 'title', 'alt']) {
        if (!element.hasAttribute(attr)) continue;
        const value = element.getAttribute(attr);
        if (value && value.trim() && value.length <= 30) {
          return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
        }
      }
    }

    // 4. 其他元素的 name 属性
    if (element.hasAttribute('name')) {
      const value = element.getAttribute('name');
      if (value && value.trim() && value.length <= 30) {
        return `${tagName}[@name=${quoteXPathValue(value)}]`;
      }
    }

    return null;
  }

  /**
   * 获取元素在路径中的最佳定位段
   * 优先级：按钮/链接文本 > 稳定属性 > 其他属性 > 稳定类名 > tag[index]
   */
  getBestPathSegment(element) {
    const tagName = element.tagName.toLowerCase();

    // 1. 按钮/链接：优先使用文本内容
    if (tagName === 'button' || tagName === 'a' || element.getAttribute('role') === 'button') {
      const text = (element.innerText || element.textContent || '').trim();
      const type = element.getAttribute('type');

      if (text && text.length > 0 && text.length <= 20) {
        // 文本 + type 组合（更精确）
        if (type && type.length <= 15) {
          return `${tagName}[@type=${quoteXPathValue(type)}][normalize-space()=${quoteXPathValue(text)}]`;
        }
        return `${tagName}[normalize-space()=${quoteXPathValue(text)}]`;
      }

      // 无文本时用 type
      if (type && type.length <= 15) {
        return `${tagName}[@type=${quoteXPathValue(type)}]`;
      }
    }

    // 2. 稳定锚点属性
    const stableLocator = this.getStableLocator(element);
    if (stableLocator) return stableLocator;

    // 3. 其他有用属性
    for (const attr of ['type', 'placeholder', 'for', 'href']) {
      if (!element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr);
      if (!value || !value.trim() || value.length > 30) continue;
      if (attr === 'href' && tagName !== 'a') continue;
      if (attr === 'for' && tagName !== 'label') continue;
      return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
    }

    // 4. 稳定类名
    const classLocators = this.getElementClassLocators(element);
    if (classLocators.length > 0) {
      return classLocators[0];
    }

    // 5. 降级：tag + 同级索引
    const index = this.getSiblingIndex(element);
    if (index > 1) {
      return `${tagName}[${index}]`;
    }
    return tagName;
  }

  /**
   * 获取元素的稳定类名定位器候选列表
   */
  getElementClassLocators(element) {
    const tagName = element.tagName.toLowerCase();
    if (!element.hasAttribute('class')) return [];

    const classValue = element.getAttribute('class');
    if (!classValue || !classValue.trim()) return [];

    const classNames = classValue.split(/\s+/).filter(c => c.length > 0);
    const stableClasses = classNames.filter(isStableClassName);

    if (stableClasses.length === 0) return [];

    const locators = [];

    // 单个稳定类名
    for (const cls of stableClasses) {
      locators.push(`${tagName}[contains(@class, ${quoteXPathValue(cls)})]`);
    }

    // 双类名组合
    if (stableClasses.length >= 2) {
      for (let i = 0; i < stableClasses.length - 1; i++) {
        for (let j = i + 1; j < stableClasses.length; j++) {
          locators.push(
            `${tagName}[contains(@class, ${quoteXPathValue(stableClasses[i])})][contains(@class, ${quoteXPathValue(stableClasses[j])})]`
          );
        }
      }
    }

    return locators;
  }

  /**
   * 检查上层是否存在特殊元素（dialog/popover）
   */
  getUpperSpecialElementXPath(element) {
    const dialogElement = element.closest(".el-dialog__wrapper");
    const popoverElement = element.closest('.el-popover:not(.el-popover_)');

    if (dialogElement && dialogElement.style.display !== "none") {
      return `//div[contains(@class, 'el-dialog__wrapper')][not(contains(@style, 'display: none'))]`;
    } else if (popoverElement && popoverElement.style.display !== "none") {
      return `//div[contains(@class, 'el-popover')][not(contains(@class, 'el-popover_'))][not(contains(@style, 'display: none'))]`;
    }
    return '';
  }

  /**
   * 检查 XPath 是否唯一匹配当前元素
   */
  isUniqueXPath(xpath, context = document) {
    try {
      const elementNodeArr = getElementsByXPathWithShadow(xpath);
      return elementNodeArr?.length === 1;
    } catch (e) {
      console.warn('XPath 解析错误:', e, 'XPath:', xpath);
      return false;
    }
  }
}

// ==================== XPath 辅助函数 ====================

function getElementsByXPathWithShadow(xpath, root = document) {
  const results = new Set();
  findInDocument(xpath, root, results);
  findAllShadowRoots(root).forEach(shadowRoot => {
    findInDocument(xpath, shadowRoot, results);
  });
  findAllIframes(root).forEach(iframeDoc => {
    findInDocument(xpath, iframeDoc, results);
  });
  return Array.from(results);
}

function findInDocument(xpath, doc, results) {
  try {
    const iterator = document.evaluate(
      xpath, doc, null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE, null
    );
    let node;
    while (node = iterator.iterateNext()) {
      if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) {
        results.add(node);
      }
    }
  } catch (e) {
    // ignore
  }
}

function findAllShadowRoots(element) {
  const shadowRoots = [];
  function traverse(el) {
    if (el.shadowRoot) {
      shadowRoots.push(el.shadowRoot);
      el.shadowRoot.querySelectorAll('*').forEach(child => traverse(child));
    }
    if (el.children) {
      Array.from(el.children).forEach(child => traverse(child));
    }
  }
  traverse(element);
  return shadowRoots;
}

function findAllIframes(element) {
  const iframeDocs = [];
  element.querySelectorAll('iframe').forEach(iframe => {
    try {
      if (iframe.contentDocument) {
        iframeDocs.push(iframe.contentDocument);
        iframeDocs.push(...findAllIframes(iframe.contentDocument));
      }
    } catch (e) {
      // 跨域 iframe，忽略
    }
  });
  return iframeDocs;
}
