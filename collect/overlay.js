/**
 * collect/overlay.js — 采集模式悬浮标记
 *
 * 职责：
 *   - 在页面右上角显示红色"采集中"标记和计时。
 *   - 默认显示"结束"按钮；鼠标悬停时展开 通过 / 不通过 / 废弃。
 *   - 整个悬浮区可拖动，避免遮挡被测页面。
 *   - 使用 Shadow DOM 隔离样式，不污染被测页面。
 */

const CollectOverlay = {
  hostElement: null,
  shadowRoot: null,
  startTime: 0,
  timerId: null,
  _dragging: false,
  _dragState: null,

  css: `
    :host {
      all: initial;
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      color: #fff;
      user-select: none;
    }
    .ty-collect-card {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(217, 48, 37, 0.95);
      border-radius: 20px;
      padding: 6px 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      backdrop-filter: blur(2px);
      cursor: move;
    }
    .ty-collect-card.dragging {
      cursor: grabbing;
    }
    .ty-collect-dot {
      width: 10px;
      height: 10px;
      background: #fff;
      border-radius: 50%;
      box-shadow: 0 0 0 0 rgba(255,255,255,0.7);
      animation: ty-pulse 1.5s infinite;
      flex: none;
    }
    @keyframes ty-pulse {
      0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.7); }
      70% { box-shadow: 0 0 0 8px rgba(255,255,255,0); }
      100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
    }
    .ty-collect-text {
      font-weight: 500;
      white-space: nowrap;
    }
    .ty-collect-timer {
      font-variant-numeric: tabular-nums;
      min-width: 42px;
      text-align: center;
    }
    .ty-collect-end {
      margin-left: 4px;
      padding: 2px 10px;
      border: 1px solid rgba(255,255,255,0.6);
      border-radius: 12px;
      background: transparent;
      color: #fff;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .ty-collect-end:hover {
      background: rgba(255,255,255,0.15);
    }
    .ty-collect-actions {
      display: none;
      gap: 4px;
      margin-left: 4px;
    }
    .ty-collect-actions.show {
      display: flex;
    }
    .ty-collect-btn {
      border: none;
      border-radius: 12px;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 12px;
      color: #fff;
      white-space: nowrap;
    }
    .ty-collect-btn:hover { opacity: 0.85; }
    .ty-collect-btn.pass { background: #1e8e3e; }
    .ty-collect-btn.fail { background: #b3261e; }
    .ty-collect-btn.discard { background: #5f6368; }
  `,

  show() {
    if (this.hostElement) {
      this.hostElement.style.display = 'block'
      this.showEnd()
      this.startTime = Date.now()
      this.startTimer()
      return
    }
    this.hostElement = document.createElement('div')
    this.hostElement.id = '__ty_collect_overlay__'
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = this.css

    const card = document.createElement('div')
    card.className = 'ty-collect-card'
    card.innerHTML = `
      <span class="ty-collect-dot"></span>
      <span class="ty-collect-text">采集中</span>
      <span class="ty-collect-timer">00:00</span>
      <button class="ty-collect-end" type="button">结束</button>
      <div class="ty-collect-actions">
        <button class="ty-collect-btn pass" type="button" data-result="pass">通过</button>
        <button class="ty-collect-btn fail" type="button" data-result="fail">不通过</button>
        <button class="ty-collect-btn discard" type="button" data-result="discard">废弃</button>
      </div>
    `

    this.shadowRoot.appendChild(style)
    this.shadowRoot.appendChild(card)

    document.documentElement.appendChild(this.hostElement)

    this.bindEvents(card)
    this.startTime = Date.now()
    this.startTimer()
  },

  hide() {
    if (this.hostElement) {
      this.hostElement.style.display = 'none'
    }
    this.stopTimer()
  },

  destroy() {
    this.stopTimer()
    if (this.hostElement && this.hostElement.parentNode) {
      this.hostElement.parentNode.removeChild(this.hostElement)
    }
    this.hostElement = null
    this.shadowRoot = null
  },

  bindEvents(card) {
    // 悬停展开结果按钮，移出恢复"结束"。
    card.addEventListener('mouseenter', () => {
      if (!this._dragging) this.showActions()
    })
    card.addEventListener('mouseleave', () => {
      if (!this._dragging) this.showEnd()
    })

    // "结束"按钮本身也直接展开，方便点击。
    card.querySelector('.ty-collect-end').addEventListener('click', (e) => {
      e.stopPropagation()
      this.showActions()
    })

    card.querySelectorAll('.ty-collect-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const result = btn.getAttribute('data-result')
        this.submitResult(result)
      })
    })

    // 拖动：按住卡片空白处移动。
    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      if (e.target && e.target.closest && e.target.closest('.ty-collect-btn, .ty-collect-end')) return
      this.startDrag(e, card)
    })
  },

  showActions() {
    if (!this.shadowRoot) return
    const endBtn = this.shadowRoot.querySelector('.ty-collect-end')
    const actions = this.shadowRoot.querySelector('.ty-collect-actions')
    if (endBtn) endBtn.style.display = 'none'
    if (actions) actions.classList.add('show')
  },

  showEnd() {
    if (!this.shadowRoot) return
    const endBtn = this.shadowRoot.querySelector('.ty-collect-end')
    const actions = this.shadowRoot.querySelector('.ty-collect-actions')
    if (endBtn) endBtn.style.display = ''
    if (actions) actions.classList.remove('show')
  },

  startDrag(e, card) {
    e.preventDefault()
    const rect = this.hostElement.getBoundingClientRect()
    this._dragState = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top
    }
    this._dragging = true
    card.classList.add('dragging')
    // 从 right 定位切换为 left/top，便于拖动。
    this.hostElement.style.right = 'auto'
    this.hostElement.style.left = rect.left + 'px'
    this.hostElement.style.top = rect.top + 'px'

    const onMove = (ev) => {
      const width = this.hostElement.offsetWidth
      const height = this.hostElement.offsetHeight
      const maxX = Math.max(0, window.innerWidth - width)
      const maxY = Math.max(0, window.innerHeight - height)
      const x = Math.max(0, Math.min(ev.clientX - this._dragState.offsetX, maxX))
      const y = Math.max(0, Math.min(ev.clientY - this._dragState.offsetY, maxY))
      this.hostElement.style.left = x + 'px'
      this.hostElement.style.top = y + 'px'
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      this._dragging = false
      card.classList.remove('dragging')
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  },

  submitResult(result) {
    console.log('[Overlay] submitResult', result)
    // 先让 Collector 停止本地监听，避免按钮本身被记录。
    if (typeof Collector !== 'undefined' && Collector.stopLocal) {
      Collector.stopLocal()
    }
    chrome.runtime.sendMessage({ type: 'collectEnd', result }).then(resp => {
      console.log('[Overlay] collectEnd response', resp)
    }).catch(err => {
      console.error('[Overlay] collectEnd failed', err)
    })
  },

  startTimer() {
    this.stopTimer()
    const update = () => {
      if (!this.shadowRoot) return
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000)
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
      const ss = String(elapsed % 60).padStart(2, '0')
      const timer = this.shadowRoot.querySelector('.ty-collect-timer')
      if (timer) timer.textContent = `${mm}:${ss}`
    }
    update()
    this.timerId = setInterval(update, 1000)
  },

  stopTimer() {
    if (this.timerId) {
      clearInterval(this.timerId)
      this.timerId = null
    }
  }
}