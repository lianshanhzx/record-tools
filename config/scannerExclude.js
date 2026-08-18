/**
 * 页面元素扫描器排除规则配置
 * ============================================================
 * 当调用 libs/pageElementScanner.js 的 PageElementScanner.scan() 时，
 * 本配置用于排除（忽略）某些特定区域或特定文本的元素，避免把不需要的
 * 元素（如弹窗、抽屉、导航栏、操作按钮区等）扫描到结果中。
 *
 * 使用方式：
 *   1. 在 excludedSelectors 中填写 CSS 选择器，命中该选择器的元素及其
 *      内部元素都会被排除。
 *   2. 在 excludedKeywords 中填写关键词，当元素的 label / placeholder /
 *      title / value 中包含该关键词时，也会被排除。
 *
 * 示例：
 *   excludedSelectors: ['.header', '.sidebar', '.modal', '.drawer'],
 *   excludedKeywords: ['退出', '关闭', '取消']
 */
const PageElementScannerExcludeConfig = (function () {
  'use strict'

  return {
    // 排除区域的 CSS 选择器列表 , 可以浏览器检查中选中元素然后复制元素的选择器(copy selector)
    // 元素自身或其任一祖先命中该选择器，则跳过。
    excludedSelectors: [
      '#app > div > section > div.headerbox', //信贷系统的顶部栏内容
      'table', // 表格(table)内的元素不扫描
      // 翻页相关组件不扫描
      '.el-pagination',      // Element UI 分页
      '.el-pager',           // Element UI 页码区
      '.ant-pagination',     // Ant Design 分页
      '.ivu-page',           // iView 分页
      '.pagination',         // Bootstrap 等通用分页
      '.page-link',          // 通用分页链接
      '.page-item',          // 通用分页项
      '.layui-laypage'       // layui 分页
    ],

    // 排除关键词列表
    // 匹配元素的 label / placeholder / title / value 时，跳过该元素。
    excludedKeywords: [
      // 翻页导航按钮文案
      '下一页',
      '上一页',
      '首页',
      '尾页',
      '末页'
    ]
  }
})()

// 兼容 Node 测试环境（非浏览器环境下）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PageElementScannerExcludeConfig
}
