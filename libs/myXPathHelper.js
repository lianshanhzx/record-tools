class XPathHelper {
  // 获取单个元素
  static $(xpath, context = document) {
    try {
      const result = document.evaluate(
        xpath,
        context,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue;
    } catch (error) {
      console.error('XPath 错误:', error);
      return null;
    }
  }
  
  // 获取所有匹配元素
  static $$(xpath, context = document) {
    try {
      const result = document.evaluate(
        xpath,
        context,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      
      const elements = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        elements.push(result.snapshotItem(i));
      }
      return elements;
    } catch (error) {
      console.error('XPath 错误:', error);
      return [];
    }
  }
  
  // 检查元素是否存在
  static exists(xpath, context = document) {
    return this.$(xpath, context) !== null;
  }
  
  // 在特定上下文内查找
  static fromElement(element, xpath) {
    return this.$(xpath, element);
  }
  
  // 获取文本内容
  static getText(xpath, context = document) {
    const element = this.$(xpath, context);
    return element ? element.textContent.trim() : '';
  }
  
  // 获取属性值
  static getAttribute(xpath, attr, context = document) {
    const element = this.$(xpath, context);
    return element ? element.getAttribute(attr) : null;
  }
}

// 使用示例
// 1. 查找单个元素
// const loginBtn = XPathHelper.$('//button[text()="登录"]');
// if (loginBtn) loginBtn.click();

// // 2. 查找所有产品
// const products = XPathHelper.$$('//div[@class="product"]');
// products.forEach(product => {
//   console.log(product.textContent);
// });

// // 3. 在特定元素内查找
// const container = document.getElementById('container');
// const innerDiv = XPathHelper.fromElement(container, './/div[@class="inner"]');

// // 4. 获取文本内容
// const price = XPathHelper.getText('//span[@class="price"]');

// // 5. 获取属性值
// const href = XPathHelper.getAttribute('//a[@id="home"]', 'href');