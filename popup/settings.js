/**
 * Popup 配置窗口。保存值覆盖 config/config.js 中的默认配置。
 */
const SettingsUI = {
  storageKey: 'appConfig',

  init() {
    document.getElementById('settingsBtn').addEventListener('click', () => this.open())
    document.getElementById('closeSettingsBtn').addEventListener('click', () => this.close())
    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.save())
    document.getElementById('settingsDialog').addEventListener('click', (event) => {
      if (event.target.id === 'settingsDialog') this.close()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close()
    })
    return this.load()
  },

  async load() {
    const stored = await chrome.storage.sync.get([this.storageKey, 'atpFormConfig'])
    // 使用旧 LLM 配置作为一次性回退，确保已有保存配置仍然可用。
    const saved = stored[this.storageKey] || { llm: stored.atpFormConfig || {} }
    const config = {
      llm: Object.assign({}, APP_DEFAULT_CONFIG.llm, saved.llm || {}),
      screenshot: Object.assign({}, APP_DEFAULT_CONFIG.screenshot, saved.screenshot || {}),
      upload: Object.assign({}, APP_DEFAULT_CONFIG.upload, saved.upload || {})
    }
    this.fillForm(config)
    this.applyRuntimeConfig(config)
  },

  fillForm(config) {
    document.getElementById('settingsApiKey').value = config.llm.apiKey
    document.getElementById('settingsBaseUrl').value = config.llm.baseUrl
    document.getElementById('settingsModel').value = config.llm.model
    document.getElementById('settingsScreenshotDirectory').value = config.screenshot.downloadDirectory
    document.getElementById('settingsScreenshotMaxPixels').value = config.screenshot.maxPixels
    document.getElementById('settingsUploadBaseUrl').value = config.upload.baseUrl
    document.getElementById('settingsUploadAccessToken').value = config.upload.accessToken
  },

  open() {
    const dialog = document.getElementById('settingsDialog')
    dialog.classList.add('open')
    dialog.setAttribute('aria-hidden', 'false')
    document.getElementById('settingsApiKey').focus()
  },

  close() {
    const dialog = document.getElementById('settingsDialog')
    dialog.classList.remove('open')
    dialog.setAttribute('aria-hidden', 'true')
  },

  readForm() {
    return {
      llm: {
        apiKey: document.getElementById('settingsApiKey').value.trim(),
        baseUrl: document.getElementById('settingsBaseUrl').value.trim().replace(/\/+$/, ''),
        model: document.getElementById('settingsModel').value.trim()
      },
      screenshot: {
        downloadDirectory: document.getElementById('settingsScreenshotDirectory').value.trim().replace(/^\/+|\/+$/g, ''),
        maxPixels: Number(document.getElementById('settingsScreenshotMaxPixels').value)
      },
      upload: {
        baseUrl: document.getElementById('settingsUploadBaseUrl').value.trim().replace(/\/+$/, ''),
        accessToken: document.getElementById('settingsUploadAccessToken').value.trim()
      }
    }
  },

  validate(config) {
    if (!config.llm.baseUrl || !/^https?:\/\//i.test(config.llm.baseUrl)) return '请输入有效的 LLM API 地址'
    if (!config.llm.model) return '请输入 LLM 模型名称'
    if (!config.screenshot.downloadDirectory || /(^|\/)\.\.?(\/|$)/.test(config.screenshot.downloadDirectory)) return '截图目录必须是有效的相对路径'
    if (!Number.isInteger(config.screenshot.maxPixels) || config.screenshot.maxPixels <= 0) return '截图最大像素数必须是正整数'
    if (!config.upload.baseUrl || !/^https?:\/\//i.test(config.upload.baseUrl)) return '请输入有效的上传服务地址'
    return ''
  },

  applyRuntimeConfig(config) {
    screenshotDownloadDirectory = config.screenshot.downloadDirectory
    screenshotMaxPixels = config.screenshot.maxPixels
    BASEURL = config.upload.baseUrl
    ACCESS_TOKEN = config.upload.accessToken
  },

  async save() {
    const config = this.readForm()
    const error = this.validate(config)
    const status = document.getElementById('settingsStatus')
    if (error) {
      status.textContent = error
      status.className = 'config-msg err'
      return
    }
    await chrome.storage.sync.set({ [this.storageKey]: config })
    this.applyRuntimeConfig(config)
    status.textContent = '已保存'
    status.className = 'config-msg ok'
    setTimeout(() => { status.textContent = '' }, 2000)
  }
}
