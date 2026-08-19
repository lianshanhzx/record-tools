
/**
 * 查找元素的标签
 * @param {*} element 
 * @returns 
 */

// 方法1：查找label[for="id"]
function getLabelByFor(element) {
  if (!element.id) return null;
  const label = Array.from(document.querySelectorAll('label[for]'))
    .find(item => item.getAttribute('for') === element.id);

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
      .filter(Boolean)
      .join(' ')
    
    if (chineseText) return chineseText;
  }
  
  return null;
}


//找属性标签中的title ,label
function  getAttributeLabel(element){
   const title = element.getAttribute('title');
   const label = element.getAttribute('label');
   if (title && title.trim()) return title.trim();
   if (label && label.trim()) return label.trim();
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

//完整整合函数查找元素业务名称
function getChineseLabelByElement(element) {
  try {
    if (!element) {
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
      () => getTextContentLabel(element)
    ];
    
    // 执行策略直到找到中文标签
    for (const strategy of strategies) {
      const result = strategy();
      if (result ) {
        // 清理结果：移除多余空格、换行等
        return result.replace(/\s+/g, ' ').replace(/[\r\n\t]/g, '');
      }
    }
    
    return null;
    
  } catch (error) {
    console.error('获取业务对象名称时出错:', error);
    return null;
  }
}

