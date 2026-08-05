/**
 * 智能选择器 (XPath 版本)
 * 1. 优先尝试测试属性和 ID
 * 2. 尝试唯一业务属性
 * 3. 尝试文本内容
 * 4. 降级方案：生成层级路径（XPath 格式）
 */

/**
 * 为 XPath 属性值选择合适的引号。
 * 优先使用单引号，避免 JSON 序列化后产生转义反斜杠；
 * 当值中包含单引号时降级为双引号；同时包含两种引号时使用 concat。
 */
function quoteXPathValue(value) {
  const s = String(value);
  if (s.indexOf("'") === -1) return `'${s}'`;
  if (s.indexOf('"') === -1) return `"${s}"`;
  const parts = s.split("'").map(part => `'${part}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

class SmartSelector {
  constructor(element) {
    this.element = element;
    // 定义不需要 ID/Class 也能定位的标签（增加语义化权重）
    this.semanticTags = ['button', 'input', 'a', 'img', 'textarea', 'select'];
    // 常见的测试专用属性列表
    this.testAttributes = [
       'id', 'label', 'data-testid', 'data-cy', 'data-test', 'data-qa',
    ];
  }

  /**
   * 主入口：获取最佳 XPath 选择器
   */
  getSelector() {
    // 1. 优先尝试测试属性和 ID (The Gold Standard & Anchors)
    const idOrTestAttrXPath = this.findUniqueIdOrTestAttrXPath();
    if (idOrTestAttrXPath) {
      return idOrTestAttrXPath;
    }

    // 2. 尝试 placeholder (Placeholder Text , 排除select 框类型下的placeholder ,select框下载elementui 中的placeholder会随值改变)
    const uniquePlaceholderXPath = this.findUniquePlaceholderXPath();
    if (uniquePlaceholderXPath) {
      return uniquePlaceholderXPath;
    }

    // 3. 尝试唯一业务属性 (Unique Attributes like name, alt)
    const uniqueAttrXPath = this.findUniqueAttributeXPath();
    if (uniqueAttrXPath) {
      return uniqueAttrXPath;
    }

    // 4. 尝试文本内容 (Text Content - XPath Only)
    const textXPath = this.findTextXPath();
    if (textXPath) {
      return textXPath;
    }

    // 5. 降级方案：生成层级路径 (XPath 格式)
    return this.getXPathFromElement();
  }

  /**
   * 阶段一：寻找 ID 或 data-* 属性，生成 XPath
   */
  findUniqueIdOrTestAttrXPath() {
    for (const attr of this.testAttributes) {
      if (this.element.hasAttribute(attr)) {
        const value = this.element.getAttribute(attr);
        
        // 过滤逻辑：如果包含长数字或看起来像随机哈希，则跳过
        if (attr === 'id' && (/\d{4,}/.test(value) || /^[a-zA-Z0-9]{10,}$/.test(value) || /^el-id-.*$/.test(value))) {
          continue;
        }

        //如上层存在特殊元素,则将上册特殊元素的路径添加到xpath中
        let xpath = this.getUpperSpecialElementXPath(this.element)
        if (attr === 'id') {
          xpath = xpath + `//*[@id=${quoteXPathValue(value)}]`;
        } else {
          xpath = xpath + `//*[@${attr}=${quoteXPathValue(value)}]`;
        }
        
        if (this.isUniqueXPath(xpath)) {
          return xpath;
        }
      }
    }
    return null;
  }

  
  /**
   * 阶段二：寻找 placeholder，生成 XPath
   */
  findUniquePlaceholderXPath(){
    const selectElement = this.element.closest(".el-select")
    if(!selectElement){ 
      const tagName = this.element.tagName.toLowerCase();
      if (this.element.hasAttribute('placeholder')) {
        const value = this.element.getAttribute('placeholder');
        if (value && value.length <= 20){
            //如上层存在特殊元素,则将上册特殊元素的路径添加到xpath中
            let upperXpath = this.getUpperSpecialElementXPath(this.element)
            const xpath = upperXpath + `//${tagName}[@placeholder=${quoteXPathValue(value)}]`;
            if (this.isUniqueXPath(xpath)) return xpath;
        }
      }
    }
    return null;
  }



  /**
   * 阶段三：寻找 name, class , alt, title, type 等，生成 XPath
   */
  findUniqueAttributeXPath() {
    const usefulAttrs = ['name','title' ,'class' , 'alt', 'type' ];
    const tagName = this.element.tagName.toLowerCase();

    for (const attr of usefulAttrs) {
      if (this.element.hasAttribute(attr)) {
        const value = this.element.getAttribute(attr);
        if (value && value.length > 20) continue;
         
        //如上层存在特殊元素,则将上册特殊元素的路径添加到xpath中
        let upperXpath = this.getUpperSpecialElementXPath(this.element)
        const xpath = upperXpath + `//${tagName}[@${attr}=${quoteXPathValue(value)}]`;
        if (this.isUniqueXPath(xpath)) return xpath;
      }
    }
    return null;
  }



  /**
   * 阶段四：文本定位 (XPath)
   */
  findTextXPath() {
    const tagName = this.element.tagName.toLowerCase();
    let text = '';
    
    // 尝试获取文本内容
    if (this.element.innerText) {
      text = this.element.innerText.trim();
    } else if (this.element.textContent) {
      text = this.element.textContent.trim();
    }

    // 只有文本比较短，且是交互元素时才使用文本定位
    if (text && text.length <= 20 && text.length > 0) {
      // 使用 normalize-space 去除多余空格，contains 提高容错
      // const xpath = `//${tagName}[contains(normalize-space(), "${text}")]`;
      // if (this.isUniqueXPath(xpath)) return xpath;

      //如上层存在特殊元素,则将上册特殊元素的路径添加到xpath中
      let upperXpath = this.getUpperSpecialElementXPath(this.element)
      
      // 精确匹配版本
      const exactXPath = upperXpath + `//${tagName}[normalize-space()=${quoteXPathValue(text)}]`;
      if (this.isUniqueXPath(exactXPath)) return exactXPath;
    }
    return null;
  }


  /**
   * 检查上层是否存在特殊元素 ,加强唯一xpath的健壮性
   */
  getUpperSpecialElementXPath(element) {
    const dialogElement = this.element.closest(".el-dialog__wrapper")
    const popoverElement = this.element.closest('.el-popover:not(.el-popover_)');

    if(dialogElement && dialogElement.style.display !== "none"){
      return `//div[contains(@class, 'el-dialog__wrapper')][not(contains(@style, 'display: none'))]`
    }else if(popoverElement && popoverElement.style.display !== "none"){
      return `//div[contains(@class, 'el-popover')][not (contains(@class, 'el-popover_'))][not(contains(@style, 'display: none'))]`
    }
    return ''
  }


  //获取上层还有特殊元素 生层的层级xpath路径
  getUniqueUpperElementXPath(uppperElement ,upperXpath){
    // const dialogElementXpath = `div[contains(@class, "el-dialog__wrapper")][not(contains(@style, "display: none"))]`
    let specialObj = {
      element : uppperElement,
      specialFatherXPath : `//${upperXpath}`
    } 
    if (this.isUniqueXPath(specialObj.specialFatherXPath, specialObj.element)) {
      const directXPath = this.getXPath(this.element,'' ,specialObj);
      return  directXPath
    }else {
      //当前上级特殊元素定位不唯一,继续向上查到改特殊上级元素的唯一xpath路径
      const specialFatherXPath = this.getXPath(uppperElement.parentNode, upperXpath);
      specialObj.specialFatherXPath = specialFatherXPath
      //找到特殊元素的唯一xpath路径后,再在当前特殊元素下进行目标元素的定位
      const directXPath = this.getXPath(this.element,'' ,specialObj);
      return directXPath;
    }

  }


  /**
   * 从当前元素开始生成层级XPath路径
   */
  getXPathFromElement() {
    const dialogElement = this.element.closest(".el-dialog__wrapper")
    const popoverElement = this.element.closest('.el-popover:not(.el-popover_)');

    if(dialogElement && dialogElement.style.display !== "none"){
      // 上层有el-dialog弹窗
      const dialogElementXpath = `div[contains(@class, 'el-dialog__wrapper')][not(contains(@style, 'display: none'))]`
      this.getUniqueUpperElementXPath(dialogElement ,dialogElementXpath)
      
    }else if(popoverElement && popoverElement.style.display !== "none"){
       // 上层有el-popover弹窗
      const popoverXpath = `div[contains(@class, 'el-popover')][not (contains(@class, 'el-popover_'))][not(contains(@style, 'display: none'))]`
      this.getUniqueUpperElementXPath(popoverElement ,popoverXpath)
    }

    // 从目标元素开始，childPath 初始为空
    return this.getXPath(this.element, '');
  }



/**
 * 递归生成元素的 XPath
 * 每级元素优先尝试使用四个规则进行定位
 * 结合已确定的子路径检查唯一性，唯一则停止递归
 * 元素的类定位器 和其他定位器单独分开, 避免路径中存在的类名导致路径过长
 */
getXPath(element, childPath = '' , specialObj = null) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE || (specialObj && element === specialObj.element)) {
    return childPath;
  }
  
  // 1. 获取当前元素的定位器
  //获取id,label, name,placeholder , title , type ... 等定位器
  const currentLocator = this.getElementLocator(element);
  // 获取当前元素的类定位器
  const currentClassLocator = this.getElementClassLocator(element);
  
  // 2. 构建完整路径（当前元素定位器 + 子路径）
  let fullPath;
  let fullClassPath;
  if (childPath === '') {
    fullPath = currentLocator;
    fullClassPath = currentClassLocator;
  } else {
    fullPath = `${currentLocator}/${childPath}`;
    fullClassPath = `${currentClassLocator}/${childPath}`;
  }
  
  // 3. 检查路径是否能唯一定位到原始目标元素
  let currentTestXPath = `//${fullPath}`;
  let currentClassTestXPath = `//${fullClassPath}`;
  

  if(specialObj && specialObj.specialFatherXPath){
    currentTestXPath = `${specialObj.specialFatherXPath}//${fullPath}`;
    currentClassTestXPath = `${specialObj.specialFatherXPath}//${fullClassPath}`;
  }

  if (currentTestXPath && this.isUniqueXPath(currentTestXPath, this.element)) {
    // console.log('路径已唯一，停止递归:', currentTestXPath);
    return currentTestXPath;
  }else if(currentClassTestXPath && this.isUniqueXPath(currentClassTestXPath, this.element)){
    // console.log('--类--路径已唯一，停止递归:', currentClassTestXPath);
    return currentClassTestXPath;
  }
  
  // 4. 如果不唯一，继续向上递归（添加父元素）
  return this.getXPath(element.parentNode, fullPath ,specialObj);
}


/**
 * 获取当前元素的定位器（使用四个规则）
 */
getElementLocator(element) {
  
  const tagName = element.tagName.toLowerCase();
  // 规则1: 尝试测试属性和ID（优先）
  for (const attr of this.testAttributes) {
    if (element.hasAttribute(attr)) {
      const value = element.getAttribute(attr);
      
      // 过滤逻辑：如果包含长数字或看起来像随机哈希，则跳过
      if (attr === 'id' && (/\d{4,}/.test(value) || /^[a-zA-Z0-9]{10,}$/.test(value) || /^el-id-.*$/.test(value))) {
        continue;
      }
      
      return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
    }
  }
  
  // 规则2: 尝试placeholder（排除select框）
  const selectElement = element.closest(".el-select");
  if (!selectElement && element.hasAttribute('placeholder')) {
    const value = element.getAttribute('placeholder');
    if (value && value.length <= 20 && value.trim() !== '') {
      return `${tagName}[@placeholder=${quoteXPathValue(value)}]`;
    }
  }

  // 规则3: 尝试唯一业务属性
  const usefulAttrs = ['name', 'title', 'alt', 'type'];
  for (const attr of usefulAttrs) {
    if (element.hasAttribute(attr)) {
      const value = element.getAttribute(attr);
      if (value && value.length <= 20 && value.trim() !== '') {
        return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
      }
    }
  }

  
  
  // 规则4: 尝试文本内容
  // let text = '';
  // if (element.innerText) {
  //   text = element.innerText.trim();
  // } else if (element.textContent) {
  //   text = element.textContent.trim();
  // }
  
  // if (text && text.length < 20 && text.length > 0) {
  //   return `${tagName}[normalize-space()="${text}"]`;
  // }
  
  // 如果四个规则都不适用，使用默认的层级定位
  return this.getElementDefaultLocator(element);
}

// 获取元素的类定位器
getElementClassLocator(element){
  const tagName = element.tagName.toLowerCase();
  if (element.hasAttribute('class')) {
    const value = element.getAttribute('class');
    if (value && value.length <= 20 && value.trim() !== '') {
      return `${tagName}[@class=${quoteXPathValue(value)}]`;
    }
  }

  return ''
}

/**
 * 获取元素的默认定位器（基于层级位置）
 */
getElementDefaultLocator(element) {
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentNode;
  
  if (!parent || parent.nodeType !== Node.ELEMENT_NODE) {
    return tagName;
  }
  
  // 计算在同类型兄弟节点中的位置
  const siblings = Array.from(parent.children).filter(child => 
    child.tagName === element.tagName
  );
  
  if (siblings.length === 1) {
    return tagName;
  } else {
    const index = siblings.indexOf(element) + 1;
    return `${tagName}[${index}]`;
  }
}



  /**
   * 辅助：检查 XPath 是否唯一匹配当前元素
   */
  isUniqueXPath(xpath , context = document) {
    try {

      let elementNodeArr = getElementsByXPathWithShadow(xpath)
      // console.log('----elementNodeArr', xpath ,elementNodeArr.length)
      return elementNodeArr?.length === 1 ;
      
    } catch (e) {
      console.warn('XPath 解析错误:', e, 'XPath:', xpath);
      return false;
    }
  }

  /**
   * 生成带有属性的 XPath（备用方法）
   */
  generateXPathWithAttributes(element, attributes = []) {
    const tagName = element.tagName.toLowerCase();
    
    for (const attr of attributes) {
      if (element.hasAttribute(attr)) {
        const value = element.getAttribute(attr);
        if (value && value.length < 100) {
          const xpath = `//${tagName}[@${attr}=${quoteXPathValue(value)}]`;
          if (this.isUniqueXPath(xpath)) {
            return xpath;
          }
        }
      }
    }
    
    return null;
  }
}



//检查 XPath 是否唯一匹配当前元素
function getElementsByXPathWithShadow(xpath, root = document) {
  const results = new Set();
  
  // 1. 在当前文档中查找
  findInDocument(xpath, root, results);
  
  // 2. 查找所有 Shadow DOM
  findAllShadowRoots(root).forEach(shadowRoot => {
    findInDocument(xpath, shadowRoot, results);
  });
  
  // 3. 查找所有 iframe
  findAllIframes(root).forEach(iframeDoc => {
    findInDocument(xpath, iframeDoc, results);
  });
  
  return Array.from(results);
}

function findInDocument(xpath, doc, results) {
  try {
    const iterator = document.evaluate(
      xpath,
      doc,
      null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE,
      null
    );
    
    let node;
    while (node = iterator.iterateNext()) {
      if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) {
        results.add(node);
      }
    }
  } catch (e) {
    // console.warn(`在文档中查找失败:`, e);
  }
}

function findAllShadowRoots(element) {
  const shadowRoots = [];
  
  function traverse(el) {
    // 如果元素有 Shadow DOM
    if (el.shadowRoot) {
      shadowRoots.push(el.shadowRoot);
      // 递归遍历 Shadow DOM 内部
      el.shadowRoot.querySelectorAll('*').forEach(child => traverse(child));
    }
    
    // 检查是否有 ::shadow 或 /deep/ 等穿透 Shadow DOM 的元素
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
        // 递归查找 iframe 中的 iframe
        iframeDocs.push(...findAllIframes(iframe.contentDocument));
      }
    } catch (e) {
      // 跨域 iframe，忽略
    }
  });
  
  return iframeDocs;
}