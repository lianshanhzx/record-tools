(function () {
  'use strict'

  const results = document.getElementById('results')
  const summary = document.getElementById('summary')
  let passed = 0

  function run(name, test) {
    const row = document.createElement('li')
    Promise.resolve()
      .then(test)
      .then(() => {
        row.className = 'pass'
        row.textContent = 'PASS: ' + name
        passed++
      })
      .catch(error => {
        row.className = 'fail'
        row.textContent = 'FAIL: ' + name + ' - ' + error.message
        console.error(name, error)
      })
      .finally(() => {
        results.appendChild(row)
        summary.textContent = passed + '/1 通过'
        summary.className = passed === 1 ? 'pass' : 'fail'
        document.title = passed === 1 ? 'PASS - Downloader tests' : 'FAIL - Downloader tests'
      })
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  run('downloader 返回 ArrayBuffer 而不是调用 chrome.downloads', async function () {
    const resp = await chrome.runtime.sendMessage({
      type: 'collectDownloadJson',
      payload: { id: 'test', name: 'collect' },
      filename: 'collect/test.json'
    })
    assert(resp && resp.ok, '响应应 ok')
    assert(resp.arrayBuffer instanceof ArrayBuffer, '应返回 ArrayBuffer')
    assert(resp.arrayBuffer.byteLength > 0, 'ArrayBuffer 不应为空')
    assert(resp.filename === 'collect/test.json', 'filename 应透传')
  })
})()
