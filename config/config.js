// 配置窗口未保存时使用的默认值。用户修改后的值保存在 chrome.storage.sync。
var APP_DEFAULT_CONFIG = {
  llm: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  },
  screenshot: {
    downloadDirectory: 'TY-record-tools/screenshots',
    maxPixels: 25000000
  },
  upload: {
    baseUrl: 'http://172.20.101.63:11002'
  }
};

// 兼容现有截图与上传模块的全局配置变量。
var screenshotDownloadDirectory = APP_DEFAULT_CONFIG.screenshot.downloadDirectory;
var screenshotMaxPixels = APP_DEFAULT_CONFIG.screenshot.maxPixels;
var BASEURL = APP_DEFAULT_CONFIG.upload.baseUrl;
