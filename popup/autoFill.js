/**
 * autoFill.js — 自动填表 UI 模块
 * 负责智能填表面板的交互逻辑：面板切换、日志显示、执行填表流程。
 *
 * 依赖：
 *   - getCurrentTab / sendToContent / addFillLog (popup/index.js 全局函数)
 *   - chrome.runtime API
 */

const AutoFillUI = {
  fillTabId: null,
  fillRunning: false,

  /**
   * 初始化自动填表相关事件绑定。
   * 调用位置：popup/index.js → window.onload
   */
  init() {
    document.getElementById('fillBar').addEventListener('click', () => this.toggleFillPanel())
    document.getElementById('executeFillBtn').addEventListener('click', () => this.executeFill())
    document.getElementById('fillInstruction').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) this.executeFill()
    })
  },

  /**
   * 切换填表面板展开/收起。
   * 调用位置：autoFill.js → init (fillBar 点击)
   */
  toggleFillPanel() {
    const body = document.getElementById('fillBody')
    const arrow = document.getElementById('fillToggleArrow')
    body.classList.toggle('open')
    arrow.textContent = body.classList.contains('open') ? '▴' : '▾'
  },

  /**
   * 向填表日志区域追加一条日志。
   * 调用位置：autoFill.js → executeFill / popup/index.js → sendToContent 错误处理
   */
  addFillLog(entry) {
    const log = document.getElementById('fillLog')
    const empty = log.querySelector('.fill-log-empty')
    if (empty) empty.remove()
    const div = document.createElement('div')
    div.className = 'log-line'
    if (entry.type === 'info') {
      div.innerHTML = '<span class="log-icon info">●</span><span class="msg">' + escHtml(entry.text) + '</span>'
    } else if (entry.type === 'success') {
      div.innerHTML = '<span class="log-icon ok">✓</span><span class="msg">' + escHtml(entry.text) + '</span>'
    } else if (entry.type === 'error') {
      div.innerHTML = '<span class="log-icon err">✗</span><span class="msg">' + escHtml(entry.text) + '</span>'
    } else if (entry.type === 'progress') {
      const ok = entry.data.result === 'ok' || (entry.data.result && entry.data.result.startsWith('ok'))
      const icon = ok ? '✓' : '✗'
      const cls = ok ? 'ok' : 'err'
      div.innerHTML = '<span class="log-icon ' + cls + '">' + icon + '</span><span class="log-idx">' + entry.data.index + '/' + entry.total + '</span><span class="msg">' + escHtml(entry.data.action) + ' "' + escHtml(entry.data.label) + '": ' + escHtml(entry.data.result) + '</span>'
    }
    log.appendChild(div)
    log.scrollTop = log.scrollHeight
  },

  /**
   * 清空填表日志区域。
   * 调用位置：autoFill.js → executeFill
   */
  clearFillLogs() {
    document.getElementById('fillLog').innerHTML = '<div class="fill-log-empty">等待操作...</div>'
  },

  /**
   * 执行自动填表完整流程：扫描字段 → 调用 LLM → 执行动作。
   * 调用位置：autoFill.js → init (executeFillBtn 点击 / Ctrl+Enter)
   */
  async executeFill() {
    if (this.fillRunning) return
    const instruction = document.getElementById('fillInstruction').value.trim()
    if (!instruction) { this.addFillLog({ type: 'error', text: '请输入指令' }); return }

    const body = document.getElementById('fillBody')
    if (!body.classList.contains('open')) {
      body.classList.add('open')
      document.getElementById('fillToggleArrow').textContent = '▴'
    }

    // 调用 popup/index.js → getCurrentTab
    const tab = await getCurrentTab()
    if (!tab || !tab.id) { this.addFillLog({ type: 'error', text: '无法获取当前标签页' }); return }
    this.fillTabId = tab.id

    this.fillRunning = true
    const btn = document.getElementById('executeFillBtn')
    btn.disabled = true
    btn.textContent = '执行中'
    this.clearFillLogs()
    this.addFillLog({ type: 'info', text: '正在扫描表单字段...' })

    // 调用 popup/index.js → sendToContent
    const scanResult = await sendToContent(this.fillTabId, { type: 'scanFields' })
    if (!scanResult) { this.fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }
    if (!scanResult.fields || scanResult.fields.length === 0) {
      this.addFillLog({ type: 'error', text: '未检测到 Element UI 表单字段' })
      this.fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return
    }

    const fields = scanResult.fields
    const kindCount = {}
    for (const f of fields) kindCount[f.kind] = (kindCount[f.kind] || 0) + 1
    const names = { input: '输入框', select: '下拉框', date: '日期', radio: '单选', checkbox: '多选', unknown: '未知' }
    const summary = Object.entries(kindCount).map(([k, n]) => (names[k] || k) + ' ' + n + ' 个').join('，')
    const summaryEl = document.getElementById('fillSummary')
    summaryEl.style.display = 'block'
    summaryEl.textContent = '检测到 ' + fields.length + ' 个字段（' + summary + '）'
    this.addFillLog({ type: 'info', text: '检测到 ' + fields.length + ' 个字段，正在调用 LLM...' })

    // 调用 background/llmService.js → callLLM (通过 chrome.runtime 消息)
    const llmResult = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'callLLM', fields, instruction }, resolve)
    })
    if (!llmResult) { this.addFillLog({ type: 'error', text: 'LLM 调用无响应' }); this.fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }
    if (llmResult.error) { this.addFillLog({ type: 'error', text: 'LLM 错误: ' + llmResult.error }); this.fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }

    const actions = llmResult.actions
    if (!actions || actions.length === 0) { this.addFillLog({ type: 'error', text: 'LLM 未返回动作' }); this.fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }

    this.addFillLog({ type: 'info', text: 'LLM 规划了 ' + actions.length + ' 个动作，开始执行...' })

    const self = this
    const listener = function (msg) {
      if (msg.type === 'actionProgress') self.addFillLog({ type: 'progress', data: msg.data, total: actions.length })
      if (msg.type === 'actionComplete') {
        chrome.runtime.onMessage.removeListener(listener)
        self.addFillLog({ type: 'success', text: '完成！共执行 ' + msg.data.length + ' 个动作' })
        self.fillRunning = false; btn.disabled = false; btn.textContent = '执行'
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    // 调用 popup/index.js → sendToContent
    sendToContent(this.fillTabId, { type: 'executeActions', actions })
  }
}
