/**
 * 工具函数模块
 * 供 popup 页面及内容脚本共享使用的通用工具函数。
 */

/**
 * 生成 UUID v4 字符串
 * @returns {string}
 */
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const hex = '0123456789abcdef'
  const s = []
  for (let i = 0; i < 36; i++) s[i] = hex.substr(Math.floor(Math.random() * 16), 1)
  s[14] = '4'
  s[19] = hex.substr((parseInt(s[19], 16) & 0x3) | 0x8, 1)
  s[8] = s[13] = s[18] = s[23] = '-'
  return s.join('')
}

/** 将内部命令、历史值归一为对接平台使用的事件类型。 */
function normalizeEventType(value) {
  switch (value) {
    case 'click':
    case 'click_element_by_index':
      return 'click'
    case 'select':
    case 'selectOption':
    case 'select_option':
    case 'select:click':
    case 'checkbox':
      return 'select:click'
    case 'radio':
    case 'select_radio':
      return 'radio'
    case 'fill_date_field':
    case 'date':
      return 'date'
    case 'select_tree_option':
    case 'select:tree':
      return 'select:tree'
    case 'input':
    case 'fill_form_field':
    default:
      return 'input'
  }
}

/** 返回事件类型对应的中文说明。 */
function getEventTypeName(value) {
  switch (normalizeEventType(value)) {
    case 'click': return '点击'
    case 'select:click': return '下拉框选择'
    case 'select:tree': return '树形选择'
    case 'radio': return '单选'
    case 'date': return '日期'
    default: return '输入'
  }
}

/** 从“天元相关配置”弹窗读取组件编号或者场景编号；弹窗可处于隐藏状态。 */
function getTianyuanComponentId(root) {
  const documentRoot = root || document
  const dialogs = documentRoot.querySelectorAll('[role="dialog"][aria-label="天元相关配置"]')
  for (const dialog of dialogs) {
    for (const row of dialog.querySelectorAll('p')) {
      const spans = row.querySelectorAll('span')
      if (spans.length < 2 || (spans[0].textContent.trim() !== '组件编号：' && spans[0].textContent.trim() !== '场景编号：')) continue
      const componentId = spans[1].textContent.trim()
      if (componentId) return componentId
    }
  }
  return ''
}

/** 生成一次录制会话使用的页面标识。 */
function generatePageId(timestamp) {
  return 'CJLZ' + String(timestamp == null ? Date.now() : timestamp)
}

/**
 * 将平行节点数组转换为自动化平台 JSON 格式
 * @param {Array} groups 通过 propertiesID/propertiesPID 表达层级的分组和操作节点
 * @param {string} url 录制页面 URL
 * @returns {string}
 */
function actionTree2Json(groups, url, pageId, name) {
  return JSON.stringify({
    id: uuid(), name: name || 'test', pageId: pageId || '', url,
    transcationProperties: groups || []
  })
}

/**
 * 将文本内容转换为 JSON 类型 Blob
 * @param {string} content
 * @returns {Blob|null}
 */
function txt2Blob(content) {
  return new Blob([content == null ? '' : content], { type: 'application/json' })
}

/**
 * 下载 Blob 文件
 * @param {Blob} blob
 * @param {string} name
 */
function saveAsBlobFile(blob, name) {
  const url = window.URL.createObjectURL(blob)
  chrome.downloads.download({ url, saveAs: true, filename: name }, () => {
    window.URL.revokeObjectURL(url)
  })
}

// 支持 CommonJS 和浏览器全局变量两种导出方式
const Utils = { uuid, normalizeEventType, getEventTypeName, getTianyuanComponentId, generatePageId, actionTree2Json, txt2Blob, saveAsBlobFile }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Utils
} else {
  window.Utils = Utils
}
