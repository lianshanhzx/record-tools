
/**
 * 查找元素的标签
 * @param {*} element 
 * @returns 
 */

// 方法1：查找label[for="id"]
function getLabelByFor(element) {
  if (!element.id) return null;
  const label = document.querySelector(`label[for="${element.id}"]`);

  console.log('getLabelByFor:', label);
  return label ? label.textContent.trim() : null;
}

// 判断元素是否是按钮类型（button/a/[role="button"]/el-button 等）
// 兼容 Element UI 按钮内部子元素（如 span/i）作为点击 target 的场景
function _isButtonElement(element) {
  if (!element || !element.tagName) return false
  const tagName = element.tagName.toLowerCase()
  if (['button', 'a'].includes(tagName)) return true
  if (element.getAttribute('role') === 'button') return true
  const classAttr = element.getAttribute('class') || ''
  if (/\bel-button\b/.test(classAttr)) return true
  // 元素位于 button/a/role=button/.el-button 内部
  if (element.closest && element.closest('button, a, [role="button"], .el-button')) return true
  return false
}

// 获取按钮自身的文本名称
// 若 element 是按钮内部子元素，向上找到真正的按钮再取文本
function _getButtonOwnName(element) {
  if (!element) return null
  let target = element
  if (element.closest) {
    target = element.closest('button, a, [role="button"], .el-button') || element
  }
  let text = target.textContent ? target.textContent.trim() : ''
  if (text && text.length >= 1 && text.length <= 30) {
    return text
  }
  return null
}

// 方法2：查找包裹元素的label
function getWrappingLabel(element) {
  let label = element.closest('label');
  console.log('getWrappingLabel:', label);
  if(label){
    return label.textContent.trim(); 
  }

  //查询elementUI 的标签
  let formItemContent = element.closest('.el-form-item');
  //查询navite ui 的标签
  let formItemContentnavite = element.closest('.n-form-item');
  
  if(formItemContent){ 
    label = formItemContent.querySelector('label')
    var formItemLabelText = label ? label.textContent.trim() : null
    if (formItemLabelText && _isButtonElement(element)) {
      var btnName = _getButtonOwnName(element)
      if (btnName) {
        console.log('[业务对象] 按钮在 el-form-item 内，组合名称:', formItemLabelText, '+', btnName)
        return formItemLabelText + ' ' + btnName
      }
    }
    return formItemLabelText
  }else if(formItemContentnavite){
    label = formItemContentnavite.querySelector('.n-form-item-label__text')
  }
  return label ? label.textContent.trim() : null;

}


//ARIA属性检查
function getAriaLabel(element) {
  // 直接aria-label
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel ) {
    return ariaLabel.trim();
  }
  
  // aria-labelledby指向的元素
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelElements = labelledBy.split(' ')
      .map(id => document.getElementById(id))
      .filter(el => el);
    
    const chineseText = labelElements
      .map(el => el.textContent.trim())
      // .find(text => /[\u4e00-\u9fa5]/.test(text));
    
      console.log('aria-labelledby:', chineseText);
    if (chineseText) return chineseText;
  }
  
  return null;
}


//找属性标签中的title ,label
function  getAttributeLabel(element){
   const title = element.getAttribute('title');
   const label = element.getAttribute('label');
   if (title || label) {
    return title.trim()  || label.trim();
  }
  return  null;
}

//找占位符中的label
function getPlaceHolderLabel(element) {
  const placeholder = element.getAttribute('placeholder');
  if(placeholder){
    if(placeholder.includes('请选择您的') || placeholder.includes('请输入您的') ||placeholder.includes('请填写您的')){
        let trimPlaceHoldder =  placeholder.replace('请选择您的', '').replace('请输入您的', '').replace('请填写您的', '').trim();
        if(trimPlaceHoldder){
          return trimPlaceHoldder;
        }else{
          return null;
        }
    }else if (placeholder.includes('请选择') || placeholder.includes('请输入') ||placeholder.includes('请填写')){
        let trimPlaceHoldder =  placeholder.replace('请选择', '').replace('请输入', '').replace('请填写', '').trim();
        if(trimPlaceHoldder){
          return trimPlaceHoldder;
        }else{
          return null;
        }
    } else if(placeholder.includes('选择') || placeholder.includes('输入') ||placeholder.includes('填写')){
      let trimPlaceHoldder =  placeholder.replace('选择', '').replace('输入', '').replace('填写', '').trim();
      if(trimPlaceHoldder){
        return trimPlaceHoldder;
      }else{
        return null;
      }
    }else{
      return placeholder.trim();
    }
  }else{
    return null;
  }
}


//数据属性中的业务名称
function getDataAttributesLabel(element) {
  // 检查常见的数据属性
  const dataAttrs = [
    'data-label', 'data-title', 'data-name',
    'data-placeholder', 'data-tip', 'data-text'
  ];
  
  for (const attr of dataAttrs) {
    const value = element.getAttribute(attr);
    //避免提取大段文本
    if (value && value.length >= 1 && value.length <= 50) {
      return value.trim();
    }
  }
  
  // 检查所有属性中的中文
  // const attributes = Array.from(element.attributes);
  // for (const attr of attributes) {
  //   if (attr.value && /[\u4e00-\u9fa5]{2,}/.test(attr.value)) {
  //     // 过滤掉URL、类名等
  //     if (!attr.name.includes('src') && !attr.name.includes('href') && 
  //         !attr.name.includes('class') && !attr.name.includes('style')) {
  //       return attr.value.trim();
  //     }
  //   }
  // }
  
  return null;
}


//按照文本内容匹配业务名称
function getTextContentLabel(element) {
  const tagName = element.tagName.toLowerCase();
  let textContentStr = ''
  if (['button', 'a', '[role="button"]'].includes(tagName)) {
    textContentStr = element.textContent.trim();
  }else if (['div', 'p', 'span', 'li'].includes(tagName) && element.children.length == 0) {
    textContentStr = element.textContent.trim();
    console.log('--div-p-span--:', textContentStr);
  }else {
    const parent = element.closest('button, a, [role="button"] , span');
    if(parent){
      textContentStr = parent.textContent.trim();
    }
  }

  //避免提取大段文本
  if (textContentStr && textContentStr.length >= 1 && textContentStr.length <= 50) {
    return textContentStr;
  }
  return null;
}

// 查找邻近的label文本
function getAdjacentLabelText(element) {
  // 查找前一个兄弟元素中的文本
  let prev = element.previousElementSibling;
  while (prev) {
    if (prev.tagName === 'LABEL') {
      return prev.textContent.trim();
    }
    if (prev.textContent && prev.textContent.trim()) {
      return prev.textContent.trim();
    }
    prev = prev.previousElementSibling;
  }
  
  // 查找父元素中的文本
  const parentText = element.parentElement.textContent.trim();
  const elementText = element.textContent || element.value || '';
  
  console.log('查找邻近的label文本:', parentText);
  return parentText.replace(elementText, '').trim();
}


//智能上下文分析
function getContextualLabel(element) {
  // 查找最近的容器元素中的文本
  const containers = ['div', 'section', 'article', 'form', 'fieldset', 'td', 'th'];
  let container = element.parentElement;
  
  while (container) {
    // 检查容器内的文本结构
    const text = container.textContent.trim();
    const elementText = element.textContent || element.value || element.placeholder || '';
    
    if (text && text !== elementText) {
      // 提取可能的中文标签
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      for (const line of lines) {
        if (/[\u4e00-\u9fa5]{2,}/.test(line) && 
            line.length < 50 && // 避免提取大段文本
            !line.includes(elementText)) {
          return line;
        }
      }
    }
    
    // 检查legend（用于fieldset）
    if (container.tagName === 'FIELDSET') {
      const legend = container.querySelector('legend');
      if (legend && /[\u4e00-\u9fa5]/.test(legend.textContent)) {
        return legend.textContent.trim();
      }
    }
    
    // 向上查找
    container = container.parentElement;
  }
  
  return null;
}



//完整整合函数查找元素业务名称
function getChineseLabelByElement(element) {
  try {
    // 1. 通过XPath获取元素
    // const element = document.evaluate(
    //   xpath,
    //   document,
    //   null,
    //   XPathResult.FIRST_ORDERED_NODE_TYPE,
    //   null
    // ).singleNodeValue;
    
    if (!element) {
      console.warn('未找到元素:', xpath);
      return null;
    }
    
    // 2. 按优先级尝试各种方法
    const strategies = [
      // 直接关联的label
      () => getLabelByFor(element),
      // 包裹的label
      () => getWrappingLabel(element),
      // ARIA标签
      () => getAriaLabel(element),
       // 标题属性
      () => getAttributeLabel(element),
      // 占位符文本（针对输入框）
      () => getPlaceHolderLabel(element),
      // 数据属性
      () => getDataAttributesLabel(element),
      // 按钮/链接的文本内容
      () => getTextContentLabel(element),
      // 邻近文本
      // () => getAdjacentLabelText(element),
      // // 上下文分析
      // () => getContextualLabel(element),
      // // value属性（最后的手段）
      // () => {
      //   const value = element.getAttribute('value');
      //   return value && /[\u4e00-\u9fa5]/.test(value) 
      //     ? value.trim() 
      //     : null;
      // }
    ];
    
    // 执行策略直到找到中文标签
    for (const strategy of strategies) {
      const result = strategy();
      if (result ) {
        // 清理结果：移除多余空格、换行等
        return result.replace(/\s+/g, ' ').replace(/[\r\n\t]/g, '');
      }
    }
    
    console.log('未找到中文标签，元素信息:', {
      tag: element.tagName,
      id: element.id,
      class: element.className,
      type: element.type,
      allAttributes: Array.from(element.attributes).map(a => `${a.name}="${a.value}"`)
    });
    
    return null;
    
  } catch (error) {
    console.error('获取业务对象名称时出错:', error);
    return null;
  }
}

