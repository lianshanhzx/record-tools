// 扩展运行模式：'record' 录制工具、'collect' 采集工具、'both' 两者可选。
// 修改后需要重新加载扩展生效。
var APP_MODE = 'collect'

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
    baseUrl: 'http://172.20.101.63:11002',
    accessToken: ''
  },
  collect: {
    downloadDirectory: 'collect',
    // 采集时记录的元素属性白名单，控制单条动作大小。
    attributesAllowlist: ['id', 'class', 'name', 'type', 'value', 'placeholder', 'title', 'role', 'aria-label', 'data-*'],
    // 接口调用监听：记录请求后多长时间内的网络请求关联到该动作（毫秒）。
    // 普通点击后接口通常在几百毫秒内发出，默认 1000ms 兼顾慢网络，避免混入无关请求。
    networkAssociateMs: 1000,
    // 是否采集 iframe 中的操作。
    captureIframes: true,
  
    // 采集结果上报地址为空时只下载本地 JSON，不触发上传。
    telemetryHost: 'http://47.101.58.49:3000'
  }
};

// 兼容现有截图与上传模块的全局配置变量。
var screenshotDownloadDirectory = APP_DEFAULT_CONFIG.screenshot.downloadDirectory;
var screenshotMaxPixels = APP_DEFAULT_CONFIG.screenshot.maxPixels;
var BASEURL = APP_DEFAULT_CONFIG.upload.baseUrl;
var ACCESS_TOKEN = APP_DEFAULT_CONFIG.upload.accessToken;
