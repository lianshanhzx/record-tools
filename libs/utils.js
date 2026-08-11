/**
 * 工具函数模块
 * 供 popup 页面及内容脚本共享使用的通用工具函数。
 */

/**
 * 生成 UUID v4 字符串
 * @returns {string}
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

/**
 * 将录制动作数组转换为自动化平台 JSON 格式
 * @param {Array} actions 动作数组
 * @param {string} url 录制页面 URL
 * @returns {string}
 */
function action2Json(actions, url) {
  const commands = (actions || []).filter(a => a.propertiesName).map(a => {
    const item = {
      ...a,
      params: { label_text: a.propertiesName, value: a.value || '' }
    }
    // group 字段仅用于 popup 树形分组展示，不输出到下载/提交的 JSON
    delete item.group
    return item
  })
  return JSON.stringify({
    id: uuid(), name: 'test', url,
    tests: [{ id: uuid(), name: 'test', commands }]
  })
}

/**
 * 将文本内容转换为 JSON 类型 Blob
 * @param {string} content
 * @returns {Blob|null}
 */
function txt2Blob(content) {
  return content ? new Blob([content], { type: 'application/json' }) : null
}

/**
 * 下载 Blob 文件
 * @param {Blob} blob
 * @param {string} name
 */
function saveAsBlobFile(blob, name) {
  const url = window.URL.createObjectURL(blob)
  chrome.downloads.download({ url, saveAs: true, filename: name })
}

// 支持 CommonJS 和浏览器全局变量两种导出方式
const Utils = { uuid, action2Json, txt2Blob, saveAsBlobFile }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Utils
} else {
  window.Utils = Utils
}
