const ReplayService = {
  running: false,
  taskId: '',
  records: [],

  makeTaskId() { return 'replay-' + Utils.uuid() },

  setUi(running) {
    this.running = running
    const ids = ['replayBtn', 'selectAllRecords', 'clearBtn', 'saveCmdBtn', 'deleteCmdBtn', 'saveNameBtn', 'saveValBtn', 'recordStartBtn', 'recordStopBtn', 'recordPauseBtn', 'recordContinueBtn']
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = running })
    const cancel = document.getElementById('cancelReplayBtn')
    if (cancel) {
      cancel.disabled = !running
      cancel.style.display = running ? 'inline-block' : 'none'
    }
    const replay = document.getElementById('replayBtn')
    if (replay) replay.style.display = running ? 'none' : 'inline-block'
    document.querySelectorAll('.record-select, .cut-record-btn, .paste-record-btn, .delete-record-btn, .group-delete-btn, .group-screenshot-btn').forEach(el => { el.disabled = running })
  },

  updateStatus(text) {
    const el = document.getElementById('replayStatus')
    if (el) el.textContent = text || ''
  },

  async start() {
    if (this.running) return
    try {
      const tab = await getCurrentTab()
      if (!tab || !tab.id) { alert('无法获取目标页面'); return }
      // Use the same handler as the pause button so the UI and page state stay in sync.
      const pause = await window.pauseRecording()
      if (!pause) { alert('无法暂停录制，回放未开始'); return }
      const allVisibleRecords = RecordManager.recordInfoLit || []
      const emptyValueCount = RecordManager.getEmptyValueRecords(allVisibleRecords).length
      this.records = RecordManager.getReplayRecords()
      if (this.records.length === 0) {
        alert(emptyValueCount > 0 ? '暂无可回放记录，表单记录均无值' : '暂无可回放记录')
        return
      }
      this.taskId = this.makeTaskId()
      RecordManager.resetReplayStates(this.records)
      this.setUi(true)
      this.updateStatus('准备回放 ' + this.records.length + ' 条')
      const records = this.records.map(record => Object.assign({}, record, { recordKey: RecordManager.ensureRecordKey(record) }))
      const response = await sendToContent(tab.id, { type: 'replayStart', taskId: this.taskId, records: records, options: { timeout: 5000, stepDelay: 300 } })
      if (!response) this.finish('回放通信失败')
    } catch (error) {
      this.finish('回放启动失败')
      alert('回放启动失败：' + (error.message || String(error)))
    }
  },

  async stop() {
    if (!this.running) return
    const tab = await getCurrentTab()
    if (tab && tab.id) await sendToContent(tab.id, { type: 'replayStop', taskId: this.taskId })
    this.updateStatus('正在取消回放...')
  },

  handleMessage(message) {
    if (!this.running || message.taskId !== this.taskId) return
    if (message.type === 'replayProgress') {
       RecordManager.setReplayState(message.recordKey, message.status, message.error, {
         expectedValue: message.expectedValue,
         actualValue: message.actualValue,
         validation: message.validation
       })
      this.updateStatus(message.status === 'running' ? '正在回放 ' + (message.index + 1) + '/' + this.records.length : '已处理 ' + (message.index + 1) + '/' + this.records.length)
    } else if (message.type === 'replayComplete') {
      this.finish(message.status === 'cancelled' ? '回放已取消' : '回放完成')
    }
  },

  finish(text) {
    this.setUi(false)
    // Replay progress re-renders the list while controls are disabled. Render once
    // more after enabling the UI so group selectors are usable again.
    if (typeof RecordManager !== 'undefined') {
      RecordManager.renderRecordList(RecordManager.recordInfoLit || [])
      RecordManager.updateSelectionUi()
    }
    this.updateStatus(text)
    this.taskId = ''
    this.records = []
  }
}
