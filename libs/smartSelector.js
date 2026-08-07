/**
 * 智能选择器 (XPath 版本)
 *
 * 核心策略（参考 XPath 稳定性最佳实践）：
 * 1. 优先使用元素自身的稳定属性（data-testid / aria-label / name 等）
 * 2. 向上查找最近的稳定祖先作为"锚点"，构建相对路径
 * 3. 路径段尽量使用属性而非纯索引
 * 4. 锚点与路径之间使用 //（后代轴），允许中间结构变化
 * 5. 避免绝对路径（/html/body/...）和纯索引链
 */

function quoteXPathValue(value) {
  const s = String(value);
  if (s.indexOf("'") === -1) return `'${s}'`;
  if (s.indexOf('"') === -1) return `"${s}"`;
  const parts = s.split("'").map(part => `'${part}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

/**
 * 判断类名是否稳定（非框架动态生成）
 */
function isStableClassName(className) {
  if (!className || className.length < 2) return false;
  if (/^data-v-/.test(className)) return false;           // Vue scoped
  if (/^(is-|has-)/.test(className)) return false;        // 状态类
  if (/[_-]{2}[a-z0-9]{4,}$/i.test(className)) return false; // 随机后缀
  if (/^\d+$/.test(className)) return false;              // 纯数字
  return true;
}

/**
 * 判断属性值是否为框架动态生成（不应用于定位）
 */
function isDynamicValue(value) {
  if (!value) return true;
  if (/\d{6,}/.test(value)) return true;                  // 长数字
  if (/^[a-zA-Z0-9]{12,}$/.test(value)) return true;      // 长哈希
  if (/^el-id-/.test(value)) return true;                 // Element UI 动态 ID
  return false;
}

class SmartSelector {
  constructor(element) {
    this.element = element;
    this.semanticTags = ['button', 'input', 'a', 'img', 'textarea', 'select'];
    // 测试属性（最高优先级）
    this.testAttributes = [
      'data-testid', 'data-cy', 'data-test', 'data-qa',
      'aria-label', 'data-track', 'data-field',
      'id', 'label',
    ];
    // 业务属性
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

    // 3. 业务属性（name/title/aria 等）
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

      if (attr === 'id' && (/\d{4,}/.test(value) || /^[a-zA-Z0-9]{10,}$/.test(value) || /^el-id-/.test(value))) {
        continue;
      }

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
   * 降级方案入口：生成相对 XPath
   * 策略优先级：
   * 1. 特殊容器（dialog/popover）内的相对路径
   * 2. 兄弟节点关系定位
   * 3. 最近稳定祖先锚点 + 相对路径
   */
  getXPathFromElement() {
    // 1. 特殊容器处理
    const dialogElement = this.element.closest(".el-dialog__wrapper");
    const popoverElement = this.element.closest('.el-popover:not(.el-popover_)');

    if (dialogElement && dialogElement.style.display !== "none") {
      const containerXPath = `//div[contains(@class, 'el-dialog__wrapper')][not(contains(@style, 'display: none'))]`;
      const innerPath = this.buildRelativeXPath(this.element, dialogElement);
      return `${containerXPath}${innerPath}`;
    }

    if (popoverElement && popoverElement.style.display !== "none") {
      const containerXPath = `//div[contains(@class, 'el-popover')][not(contains(@class, 'el-popover_'))][not(contains(@style, 'display: none'))]`;
      const innerPath = this.buildRelativeXPath(this.element, popoverElement);
      return `${containerXPath}${innerPath}`;
    }

    // 2. 尝试兄弟节点关系定位（如：label[text()='Email']/following-sibling::input）
    const siblingXPath = this.findSiblingBasedXPath();
    if (siblingXPath) return siblingXPath;

    // 3. 构建相对路径（从最近稳定锚点出发）
    return this.buildRelativeXPath(this.element);
  }

  /**
   * 核心算法：构建相对 XPath
   *
   * 从目标元素向上遍历：
   * - 每一级尝试获取最佳路径段（优先属性，其次稳定类名，最后索引）
   * - 遇到稳定且唯一的祖先元素时，将其作为锚点，返回 锚点//相对路径
   * - 使用 //（后代轴）连接，允许中间 DOM 结构变化
   *
   * @param {Element} target - 目标元素
   * @param {Element|null} boundaryElement - 边界元素（如 dialog），到达后停止
   * @returns {string} 相对 XPath
   */
  buildRelativeXPath(target, boundaryElement = null) {
    const segments = [];
    let current = target;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      // 到达边界或文档根，停止
      if (current === boundaryElement || current === document.body || current === document.documentElement) {
        break;
      }

      // 对于祖先元素（非目标本身），检查是否为稳定锚点
      if (current !== target) {
        const anchorLocator = this.getStableLocator(current);
        if (anchorLocator) {
          const anchorXPath = `//${anchorLocator}`;
          if (this.isUniqueXPath(anchorXPath)) {
            // 找到稳定锚点，用 // 连接相对路径（允许中间结构变化）
            const relativePath = segments.join('//');
            const fullXPath = relativePath ? `${anchorXPath}//${relativePath}` : anchorXPath;
            if (this.isUniqueXPath(fullXPath, target)) {
              return fullXPath;
            }
          }
        }
      }

      // 获取当前元素的最佳路径段
      const segment = this.getBestPathSegment(current);
      segments.unshift(segment);

      // 检查当前累积路径是否已唯一（无锚点时的短路径）
      const currentPath = `//${segments.join('//')}`;
      if (this.isUniqueXPath(currentPath, target)) {
        return currentPath;
      }

      current = current.parentElement;
    }

    // 到达顶层，返回累积路径
    return segments.length > 0 ? `//${segments.join('//')}` : `//${target.tagName.toLowerCase()}`;
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
      // 尝试兄弟节点的文本内容
      const text = sibling.textContent?.trim();
      if (text && text.length > 0 && text.length <= 20) {
        const siblingTag = sibling.tagName.toLowerCase();
        const xpath = `//${siblingTag}[normalize-space()=${quoteXPathValue(text)}]/following-sibling::${targetTag}[${position}]`;
        if (this.isUniqueXPath(xpath, this.element)) {
          return xpath;
        }
      }

      // 尝试兄弟节点的稳定属性
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
   * 获取元素的稳定锚点定位器
   * 仅当元素具有稳定且可能唯一的属性时返回，否则返回 null
   * 用于在向上遍历过程中识别"锚点"元素
   */
  getStableLocator(element) {
    const tagName = element.tagName.toLowerCase();

    // 1. 测试属性（最高优先级）
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
   * 优先使用属性，其次是稳定类名，最后是 tag[index]
   */
  getBestPathSegment(element) {
    const tagName = element.tagName.toLowerCase();

    // 1. 尝试稳定锚点属性
    const stableLocator = this.getStableLocator(element);
    if (stableLocator) return stableLocator;

    // 2. 尝试其他有用属性
    for (const attr of ['type', 'placeholder', 'for', 'href']) {
      if (!element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr);
      if (!value || !value.trim() || value.length > 30) continue;
      if (attr === 'href' && tagName !== 'a') continue;
      if (attr === 'for' && tagName !== 'label') continue;
      return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
    }

    // 3. 尝试稳定类名
    const classLocators = this.getElementClassLocators(element);
    if (classLocators.length > 0) {
      return classLocators[0];
    }

    // 4. 降级：tag + 同级索引
    const parent = element.parentElement;
    if (!parent) return tagName;

    const siblings = Array.from(parent.children).filter(c => c.tagName === element.tagName);
    if (siblings.length === 1) return tagName;

    const index = siblings.indexOf(element) + 1;
    return `${tagName}[${index}]`;
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
