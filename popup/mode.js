/**
 * popup/mode.js — 模式选择页交互
 */

const statusEl = document.getElementById('status')

function getTabId() {
  const params = new URLSearchParams(window.location.search)
  const id = params.get('tabId')
  return id ? Number(id) : null
}

const targetTabId = getTabId()

function setStatus(text) {
  statusEl.textContent = text
}

async function launch(type) {
  setStatus('启动中...')
  if (!targetTabId) {
    setStatus('未找到目标标签页')
    return
  }
  try {
    const resp = await chrome.runtime.sendMessage({
      type: type === 'record' ? 'startRecordTool' : 'startCollectTool',
      tabId: targetTabId
    })
    if (resp && resp.error) {
      setStatus(resp.error)
      return
    }
    window.close()
  } catch (e) {
    setStatus('启动失败：' + e.message)
  }
}

document.getElementById('recordBtn').addEventListener('click', () => launch('record'))
document.getElementById('collectBtn').addEventListener('click', () => launch('collect'))
