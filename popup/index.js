window.onload = function () {
  main();
  initAutoFill()
}

let fillTabId = null
let fillRunning = false

let recordActionList = []
let recordInfoLit = []
let currentRecordInfo = {}
let zdhData = {}
let recordDataUrl = ''


function escHtml(s) {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function updateRecordCount() {
  const el = document.getElementById('recordCount')
  if (el) el.textContent = recordInfoLit.length + ' 条'
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  for (const t of tabs) {
    if (t.url && !t.url.startsWith('chrome-extension://')) return t
  }
  const all = await chrome.tabs.query({ active: true })
  for (const t of all) {
    if (t.url && !t.url.startsWith('chrome-extension://')) return t
  }
  return tabs[0]
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch (e) {
    if (e.message.includes('Receiving end does not exist')) {
      try {
        const tab = await chrome.tabs.get(tabId)
        if (tab.url && tab.url.startsWith('chrome-extension://')) {
          addFillLog({ type: 'error', text: '请先点击用户页面激活标签页' })
          return null
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['/libs/autoFormFill.js', '/libs/smartSelector.js', '/libs/elementBusinessName.js', '/libs/myXPathHelper.js', '/content/content.js']
        })
        await new Promise(r => setTimeout(r, 500))
        return await chrome.tabs.sendMessage(tabId, message)
      } catch (e2) {
        addFillLog({ type: 'error', text: '注入失败: ' + e2.message })
      }
    } else {
      addFillLog({ type: 'error', text: '通信错误: ' + e.message })
    }
    return null
  }
}


function initAutoFill() {
  document.getElementById('fillBar').addEventListener('click', toggleFillPanel)
  document.getElementById('fillConfigToggle').addEventListener('click', function (e) { e.stopPropagation(); toggleFillConfig() })
  document.getElementById('executeFillBtn').addEventListener('click', executeFill)
  document.getElementById('fillInstruction').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) executeFill()
  })
  document.getElementById('saveFillConfig').addEventListener('click', saveFillConfig)
  loadFillConfig()
}

function toggleFillPanel() {
  const body = document.getElementById('fillBody')
  const arrow = document.getElementById('fillToggleArrow')
  body.classList.toggle('open')
  arrow.textContent = body.classList.contains('open') ? '▴' : '▾'
}

function toggleFillConfig() {
  const el = document.getElementById('fillConfig')
  const arrow = document.getElementById('fillConfigArrow')
  el.classList.toggle('open')
  arrow.textContent = el.classList.contains('open') ? '▾' : '▸'
}

function addFillLog(entry) {
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
}

function clearFillLogs() {
  document.getElementById('fillLog').innerHTML = '<div class="fill-log-empty">等待操作...</div>'
}

async function executeFill() {
  if (fillRunning) return
  const instruction = document.getElementById('fillInstruction').value.trim()
  if (!instruction) { addFillLog({ type: 'error', text: '请输入指令' }); return }

  const body = document.getElementById('fillBody')
  if (!body.classList.contains('open')) {
    body.classList.add('open')
    document.getElementById('fillToggleArrow').textContent = '▴'
  }

  const tab = await getCurrentTab()
  if (!tab || !tab.id) { addFillLog({ type: 'error', text: '无法获取当前标签页' }); return }
  fillTabId = tab.id

  fillRunning = true
  const btn = document.getElementById('executeFillBtn')
  btn.disabled = true
  btn.textContent = '执行中'
  clearFillLogs()
  addFillLog({ type: 'info', text: '正在扫描表单字段...' })

  const scanResult = await sendToContent(fillTabId, { type: 'scanFields' })
  if (!scanResult) { fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }
  if (!scanResult.fields || scanResult.fields.length === 0) {
    addFillLog({ type: 'error', text: '未检测到 Element UI 表单字段' })
    fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return
  }

  const fields = scanResult.fields
  const kindCount = {}
  for (const f of fields) kindCount[f.kind] = (kindCount[f.kind] || 0) + 1
  const names = { input: '输入框', select: '下拉框', date: '日期', radio: '单选', checkbox: '多选', unknown: '未知' }
  const summary = Object.entries(kindCount).map(([k, n]) => (names[k] || k) + ' ' + n + ' 个').join('，')
  const summaryEl = document.getElementById('fillSummary')
  summaryEl.style.display = 'block'
  summaryEl.textContent = '检测到 ' + fields.length + ' 个字段（' + summary + '）'
  addFillLog({ type: 'info', text: '检测到 ' + fields.length + ' 个字段，正在调用 LLM...' })

  const llmResult = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'callLLM', fields, instruction }, resolve)
  })
  if (!llmResult) { addFillLog({ type: 'error', text: 'LLM 调用无响应' }); fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }
  if (llmResult.error) { addFillLog({ type: 'error', text: 'LLM 错误: ' + llmResult.error }); fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }

  const actions = llmResult.actions
  if (!actions || actions.length === 0) { addFillLog({ type: 'error', text: 'LLM 未返回动作' }); fillRunning = false; btn.disabled = false; btn.textContent = '执行'; return }

  addFillLog({ type: 'info', text: 'LLM 规划了 ' + actions.length + ' 个动作，开始执行...' })

  const listener = function (msg) {
    if (msg.type === 'actionProgress') addFillLog({ type: 'progress', data: msg.data, total: actions.length })
    if (msg.type === 'actionComplete') {
      chrome.runtime.onMessage.removeListener(listener)
      addFillLog({ type: 'success', text: '完成！共执行 ' + msg.data.length + ' 个动作' })
      fillRunning = false; btn.disabled = false; btn.textContent = '执行'
    }
  }
  chrome.runtime.onMessage.addListener(listener)
  sendToContent(fillTabId, { type: 'executeActions', actions })
}

function loadFillConfig() {
  chrome.storage.sync.get('atpFormConfig', (res) => {
    const c = res.atpFormConfig || {}
    document.getElementById('fillApiKey').value = c.apiKey || ''
    document.getElementById('fillBaseUrl').value = c.baseUrl || 'https://api.deepseek.com/v1'
    document.getElementById('fillModel').value = c.model || 'deepseek-v4-flash'
  })
}

function saveFillConfig() {
  const config = {
    apiKey: document.getElementById('fillApiKey').value.trim(),
    baseUrl: document.getElementById('fillBaseUrl').value.trim(),
    model: document.getElementById('fillModel').value.trim()
  }
  const statusEl = document.getElementById('fillConfigStatus')
  if (!config.apiKey) { statusEl.textContent = '请输入 API Key'; statusEl.className = 'config-msg err'; return }
  chrome.storage.sync.set({ atpFormConfig: config }, () => {
    statusEl.textContent = '已保存'; statusEl.className = 'config-msg ok'
    setTimeout(() => { statusEl.textContent = '' }, 2000)
  })
}


async function main() {
  initRecordControls()
}

function initRecordControls() {
  const startBtn = document.getElementById('recordStartBtn')
  const stopBtn = document.getElementById('recordStopBtn')
  const pauseBtn = document.getElementById('recordPauseBtn')
  const continueBtn = document.getElementById('recordContinueBtn')

  function setRecordingUI(state) {
    startBtn.style.display = 'none'
    stopBtn.style.display = 'none'
    pauseBtn.style.display = 'none'
    continueBtn.style.display = 'none'
    if (state === 'idle') { startBtn.style.display = 'inline-block' }
    else if (state === 'recording') { stopBtn.style.display = 'inline-block'; pauseBtn.style.display = 'inline-block' }
    else if (state === 'paused') { stopBtn.style.display = 'inline-block'; continueBtn.style.display = 'inline-block' }
  }

  async function sendToTab(type) {
    const tab = await getCurrentTab()
    if (!tab || !tab.id) return
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type })
      return resp
    } catch (e) {
      console.log('发送消息失败:', e.message)
    }
  }

  startBtn.addEventListener('click', async () => {
    const resp = await sendToTab('startRecording')
    if (resp) setRecordingUI('recording')
  })

  stopBtn.addEventListener('click', async () => {
    const resp = await sendToTab('stopRecording')
    if (resp) setRecordingUI('idle')
  })

  pauseBtn.addEventListener('click', async () => {
    const resp = await sendToTab('pauseRecording')
    if (resp) setRecordingUI('paused')
  })

  continueBtn.addEventListener('click', async () => {
    const resp = await sendToTab('continueRecording')
    if (resp) setRecordingUI('recording')
  })
}

function updateRecorder() {
  for (let item of recordInfoLit) {
    if (item.id === currentRecordInfo.id) { item = currentRecordInfo; break }
  }
  setTimeout(() => renderRecordList(recordInfoLit), 0)
}

function renderRecordList(data) {
  let html = ''
  let idx = 0
  for (let item of data) {
    let name = item.propertiesName
    if (!name && item.attributes && item.attributes.placeholder) name = item.attributes.placeholder
    idx++
    html += '<div class="list-row" id="' + item.id + '_' + item.timestamp + '">'
    html += '<span class="col-seq">' + idx + '</span>'
    html += '<span class="col-cmd">' + escHtml(item.command || '') + '</span>'
    html += '<span class="col-name" title="' + escHtml(name || '') + '">' + escHtml(name || '') + '</span>'
    html += '<span class="col-ttype">' + escHtml(item.targetType || '') + '</span>'
    html += '<span class="col-target" title="' + escHtml(item.target || '') + '">' + escHtml(item.target || '') + '</span>'
    html += '<span class="col-val" title="' + escHtml(item.value || '') + '">' + escHtml(item.value || '') + '</span>'
    html += '</div>'
  }
  document.getElementById('listBody').innerHTML = html
}

function filterRecordListData(data) {
  return data.filter(r =>
    r.target !== '//*[@id="record_stop_btn"]' &&
    r.target !== '//*[@id="record_pause_btn"]' &&
    r.target !== '//*[@id="record_continue_btn"]' &&
    r.target !== 'xpath=#record_stop_btn' &&
    r.target !== 'xpath=#record_pause_btn' &&
    r.target !== 'xpath=#record_continue_btn'
  )
}

function computedSamePropertiesName(list, name) {
  return list.filter(item => {
    if (!item.propertiesName) return false
    const arr = item.propertiesName.split('-')
    return arr[0] === name
  }).length
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'addActionData') {
    const target = message.data.target
    const name = message.data.propertiesName
    const byTarget = target ? recordActionList.findIndex(a => a.target === target) : -1
    if (byTarget >= 0) {
      recordActionList[byTarget] = { ...recordActionList[byTarget], value: message.data.value, command: message.data.command, propertiesName: message.data.propertiesName, action: message.data.action }
    } else {
      if (recordActionList.length > 0) {
        const cnt = computedSamePropertiesName(recordActionList, name)
        if (cnt > 0) message.data.propertiesName = name + '-' + cnt
      }
      recordActionList.push(message.data)
    }
    recordInfoLit = filterRecordListData(recordActionList)
    currentRecordInfo = {}
    renderRecordList(recordInfoLit)
    updateRecordCount()
  } else if (message.type === 'startRecord') {
    recordDataUrl = message.data
  }
})


$('#clearBtn').click(function () {
  document.getElementById('listBody').innerHTML = ''
  recordActionList = []
  recordInfoLit = []
  currentRecordInfo = {}
  recordDataUrl = ''
  updateRecordCount()
})

$('#downloadBtn').click(function () {
  saveAsBlobFile(txt2Blob(action2Json(recordInfoLit, recordDataUrl)), 'result.json')
})

$('#downloadAllElementsBtn').click(async function () {
  const tab = await getCurrentTab()
  if (!tab || !tab.id) { alert('无法获取当前标签页'); return }

  const resp = await sendToContent(tab.id, { type: 'getScannedElements' })
  if (!resp || !resp.elements || resp.elements.length === 0) {
    alert('暂无扫描元素，请先点击“开始录制”进行扫描')
    return
  }

  const payload = JSON.stringify({
    id: uuid(),
    name: 'all-elements',
    url: recordDataUrl || tab.url || '',
    scannedAt: Date.now(),
    elementCount: resp.elements.length,
    elements: resp.elements
  }, null, 2)

  const blob = new Blob([payload], { type: 'application/json' })
  const filename = 'all-elements-' + new Date().getTime() + '.json'
  saveAsBlobFile(blob, filename)
})

$('#submitBtn').click(async function () {
  const empty = recordInfoLit.filter(item => !item.propertiesName)
  if (empty.length > 0) { alert('请补充业务对象名称！'); return }
  chrome.storage.sync.get('tyAtpData', (res) => {
    zdhData = JSON.parse(res.tyAtpData)
    submitRecordUpload()
  })
})

$('#saveCmdBtn').click(function () {
  currentRecordInfo.command = $('#editCmd').val()
  updateRecorder()
})

$('#deleteCmdBtn').click(function () {
  recordInfoLit = recordInfoLit.filter(item => item.id !== currentRecordInfo.id)
  setTimeout(() => renderRecordList(recordInfoLit), 0)
})

$('#saveNameBtn').click(function () {
  currentRecordInfo.propertiesName = $('#editName').val()
  updateRecorder()
})

$('#saveValBtn').click(function () {
  currentRecordInfo.value = $('#editVal').val()
  updateRecorder()
})

$(document).on('click', '.list-row', function () {
  $(this).siblings().removeClass('active')
  $(this).addClass('active')
  const id = $(this).attr('id')
  for (let item of recordInfoLit) {
    if (item.id + '_' + item.timestamp === id) {
      currentRecordInfo = item
      break
    }
  }
  $('#editCmd').val(currentRecordInfo.command || '')
  $('#editName').val(currentRecordInfo.propertiesName || '')
  $('#editVal').val(currentRecordInfo.value || '')
})


function uploadTexResult() {
  return new Promise((resolve, reject) => {
    const file = new File([txt2Blob(action2Json(recordInfoLit, recordDataUrl))], 'result', { type: 'text/plain' })
    const fd = new FormData()
    fd.append('file', file)
    fd.append('mothed', 'By.XPATH')
    fd.append('transcationType', 'web')
    fd.append('transcationId', zdhData.transcationId)
    $.ajax({
      url: zdhData.hostOrigin + '/api/transaction/transcationproperties/importDataByBS',
      type: 'post',
      contentType: false,
      async: true,
      data: fd,
      processData: false,
      beforeSend: function (xhr) { xhr.setRequestHeader('access_token', zdhData.zdh_token) },
      success: function (res) { resolve(res) },
      error: function (err) { reject(err) }
    })
  })
}

async function submitRecordUpload() {
  const res = await uploadTexResult()
  if (res.code === '200') alert(res.msg)
  else alert(res.msg)
}

function saveAsBlobFile(blob, name) {
  const url = window.URL.createObjectURL(blob)
  chrome.downloads.download({ url, saveAs: true, filename: name })
}

function action2Json(actions, url) {
  const commands = (actions || []).filter(a => a.propertiesName).map(a => ({
    ...a,
    params: { label_text: a.propertiesName, value: a.value || '' }
  }))
  return JSON.stringify({
    id: uuid(), name: 'test', url,
    tests: [{ id: uuid(), name: 'test', commands }]
  })
}

function uuid() {
  const hex = '0123456789abcdef'
  const s = []
  for (let i = 0; i < 36; i++) s[i] = hex.substr(Math.floor(Math.random() * 16), 1)
  s[14] = '4'
  s[19] = hex.substr((s[19] & 0x3) | 0x8, 1)
  s[8] = s[13] = s[18] = s[23] = '-'
  return s.join('')
}

function txt2Blob(content) { return content ? new Blob([content], { type: 'application/json' }) : null }
