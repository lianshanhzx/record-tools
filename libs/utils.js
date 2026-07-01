/**
 * 工具函数模块
 * 提供通用的工具函数，避免重复代码
 */

/**
 * 生成唯一ID (UUID格式)
 * @returns {string} UUID字符串
 */
function uuid() {
  const hexDigits = "0123456789abcdef";
  const s = [];
  for (let i = 0; i < 36; i++) {
    s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
  }
  s[14] = "4"; // bits 12-15 of the time_hi_and_version field to 0010
  s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1); // bits 6-7 of the clock_seq_hi_and_reserved to 01
  s[8] = s[13] = s[18] = s[23] = "-";
  return s.join("");
}

/**
 * 将录制动作转换为JSON格式
 * @param {Array} actions - 录制动作数组
 * @param {string} url - 录制的页面URL
 * @returns {string} JSON字符串
 */
function action2Json(actions, url) {
  const json = {
    id: uuid(),
    name: 'test',
    url: url,
    tests: [{
      id: uuid(),
      name: 'test',
      commands: []
    }]
  };
  if (actions && Array.isArray(actions)) {
    actions.forEach(action => {
      json.tests[0].commands.push(action);
    });
  }
  return JSON.stringify(json);
}

/**
 * 将文本转换为Blob对象
 * @param {string} content - 文本内容
 * @returns {Blob|null} Blob对象
 */
function txt2Blob(content) {
  if (content) {
    return new Blob([content]);
  }
  return null;
}

/**
 * 下载Blob文件
 * @param {Blob} blob - Blob对象
 * @param {string} fileName - 文件名
 */
function saveAsBlobFile(blob, fileName) {
  if (!blob || !fileName) {
    console.warn('saveAsBlobFile: 参数不完整');
    return;
  }
  const objectURL = window.URL.createObjectURL(blob);
  if (chrome && chrome.downloads) {
    chrome.downloads.download({
      url: objectURL,
      saveAs: true,
      filename: fileName
    }, () => {
      window.URL.revokeObjectURL(objectURL);
    });
  } else {
    // 非扩展环境下的下载方式
    const a = document.createElement('a');
    a.href = objectURL;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(objectURL);
  }
}

/**
 * 下载文本文件
 * @param {string} content - 文本内容
 * @param {string} fileName - 文件名
 */
function downloadTextFile(content, fileName) {
  const blob = txt2Blob(content);
  if (blob) {
    saveAsBlobFile(blob, fileName);
  }
}

/**
 * 计算相同业务对象名称的数量（用于避免重复）
 * @param {Array} recordList - 录制列表
 * @param {string} currentName - 当前业务对象名称
 * @returns {number} 相同名称的数量
 */
function countDuplicatePropertiesName(recordList, currentName) {
  if (!recordList || !currentName) return 0;
  return recordList.reduce((count, item) => {
    if (item.propertiesName) {
      const nameParts = item.propertiesName.split('-');
      if (nameParts[0] === currentName) {
        count++;
      }
    }
    return count;
  }, 0);
}

/**
 * 过滤录制数据（移除插件按钮相关操作）
 * @param {Array} data - 录制数据
 * @returns {Array} 过滤后的数据
 */
function filterRecordData(data) {
  if (!Array.isArray(data)) return [];
  const excludedTargets = [
    '//*[@id="record_stop_btn"]',
    '//*[@id="record_pause_btn"]',
    '//*[@id="record_continue_btn"]',
    'xpath=#record_stop_btn',
    'xpath=#record_pause_btn',
    'xpath=#record_continue_btn'
  ];
  return data.filter(record => {
    return !excludedTargets.includes(record.target);
  });
}

/**
 * 生成唯一标识符
 * @returns {string} 唯一ID
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 安全获取对象属性
 * @param {Object} obj - 目标对象
 * @param {string} path - 属性路径，支持点号分隔
 * @param {*} defaultValue - 默认值
 * @returns {*} 属性值或默认值
 */
function getSafe(obj, path, defaultValue = null) {
  if (!obj || typeof obj !== 'object') return defaultValue;
  const keys = path.split('.');
  let result = obj;
  for (const key of keys) {
    if (result === null || result === undefined) return defaultValue;
    result = result[key];
  }
  return result !== undefined ? result : defaultValue;
}

/**
 * 防抖函数
 * @param {Function} func - 需要防抖的函数
 * @param {number} wait - 等待时间（毫秒）
 * @returns {Function} 防抖后的函数
 */
function debounce(func, wait) {
  let timeout = null;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * 节流函数
 * @param {Function} func - 需要节流的函数
 * @param {number} limit - 节流时间（毫秒）
 * @returns {Function} 节流后的函数
 */
function throttle(func, limit) {
  let inThrottle = false;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

// 导出工具函数
const Utils = {
  uuid,
  action2Json,
  txt2Blob,
  saveAsBlobFile,
  downloadTextFile,
  countDuplicatePropertiesName,
  filterRecordData,
  generateId,
  getSafe,
  debounce,
  throttle
};

// 支持CommonJS和全局变量两种导出方式
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Utils;
} else {
  window.Utils = Utils;
}