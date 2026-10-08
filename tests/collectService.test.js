(function () {
  'use strict'

  const results = document.getElementById('results')
  const summary = document.getElementById('summary')
  let passed = 0
  let total = 0

  function updateSummary() {
    summary.textContent = passed + '/' + total + ' 通过'
    summary.className = passed === total ? 'pass' : 'fail'
    document.title = passed === total ? 'PASS - CollectService tests' : 'FAIL - CollectService tests'
  }

  function run(name, test) {
    total++
    const row = document.createElement('li')
    results.appendChild(row)
    try {
      const maybePromise = test()
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(() => {
          row.className = 'pass'
          row.textContent = 'PASS: ' + name
          passed++
          updateSummary()
        }).catch(error => {
          row.className = 'fail'
          row.textContent = 'FAIL: ' + name + ' - ' + error.message
          console.error(name, error)
          updateSummary()
        })
        return
      }
      row.className = 'pass'
      row.textContent = 'PASS: ' + name
      passed++
    } catch (error) {
      row.className = 'fail'
      row.textContent = 'FAIL: ' + name + ' - ' + error.message
      console.error(name, error)
    }
    updateSummary()
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  function findByName(list, name) {
    return list.filter(item => item.propertiesName === name)
  }

  function indexOfName(list, name) {
    return list.findIndex(item => item.propertiesName === name)
  }

  const page = { type: 'page', key: '__page__:test', propertiesName: '主页面' }
  const dialog = { type: 'dialog', key: '//div[dialog]', propertiesName: '详情弹窗' }

  run('弹窗内容紧跟触发按钮之后', function () {
    const actions = [
      { clientId: 'a1', group: [page], propertiesName: '打开详情', eventTypeValue: 'click' },
      { clientId: 'a2', group: [page, dialog], propertiesName: '名称', eventTypeValue: 'input' }
    ]
    const list = CollectService.buildTransactionProperties(actions)
    const openIdx = indexOfName(list, '打开详情')
    const dialogIdx = indexOfName(list, '详情弹窗')
    const nameIdx = indexOfName(list, '名称')
    assert(openIdx >= 0, '缺少打开详情操作')
    assert(dialogIdx >= 0, '缺少详情弹窗分组')
    assert(nameIdx >= 0, '缺少名称操作')
    assert(openIdx < dialogIdx, '弹窗分组没有挂在打开详情之后')
    assert(dialogIdx < nameIdx, '弹窗内容没有挂在弹窗分组之后')
  })

  run('同弹窗多次打开生成独立实例并保持时间顺序', function () {
    const actions = [
      { clientId: 'a1', group: [page], propertiesName: '打开详情', eventTypeValue: 'click', timestamp: 1 },
      { clientId: 'a2', group: [page, dialog], propertiesName: '名称1', eventTypeValue: 'input', timestamp: 2 },
      { clientId: 'a3', group: [page], propertiesName: '其他操作', eventTypeValue: 'click', timestamp: 3 },
      { clientId: 'a4', group: [page, dialog], propertiesName: '名称2', eventTypeValue: 'input', timestamp: 4 }
    ]
    const list = CollectService.buildTransactionProperties(actions)
    const dialogGroups = list.filter(item => item.type === 'dialog')
    assert(dialogGroups.length === 2, '同弹窗应生成两个独立实例，实际 ' + dialogGroups.length)

    const openIdx = indexOfName(list, '打开详情')
    const name1Idx = indexOfName(list, '名称1')
    const otherIdx = indexOfName(list, '其他操作')
    const name2Idx = indexOfName(list, '名称2')
    assert(openIdx < name1Idx, '第一次弹窗内容应紧跟打开详情')
    assert(name1Idx < otherIdx, '其他操作应在第一次弹窗内容之后')
    assert(otherIdx < name2Idx, '第二次弹窗内容应紧跟其他操作')
  })

  run('嵌套分组切换保持正确顺序', function () {
    const tab = { type: 'tab', key: '//div[tab]', propertiesName: '基本信息' }
    const actions = [
      { clientId: 'a1', group: [page], propertiesName: '打开详情', eventTypeValue: 'click', timestamp: 1 },
      { clientId: 'a2', group: [page, dialog], propertiesName: '弹窗输入', eventTypeValue: 'input', timestamp: 2 },
      { clientId: 'a3', group: [page, dialog, tab], propertiesName: 'tab输入', eventTypeValue: 'input', timestamp: 3 },
      { clientId: 'a4', group: [page], propertiesName: '关闭', eventTypeValue: 'click', timestamp: 4 }
    ]
    const list = CollectService.buildTransactionProperties(actions)
    const openIdx = indexOfName(list, '打开详情')
    const dialogIdx = indexOfName(list, '详情弹窗')
    const dialogInputIdx = indexOfName(list, '弹窗输入')
    const tabIdx = indexOfName(list, '基本信息')
    const tabInputIdx = indexOfName(list, 'tab输入')
    const closeIdx = indexOfName(list, '关闭')
    assert(openIdx < dialogIdx, '弹窗分组应紧跟打开详情')
    assert(dialogIdx < dialogInputIdx, '弹窗输入应在弹窗分组后')
    assert(dialogInputIdx < tabIdx, '页签分组应紧跟弹窗输入')
    assert(tabIdx < tabInputIdx, '页签输入应在页签分组后')
    assert(tabInputIdx < closeIdx, '关闭应在最后')
  })

  run('无分组信息时动作归入默认主页面', function () {
    const actions = [
      { clientId: 'a1', propertiesName: '页面操作', eventTypeValue: 'click' }
    ]
    const list = CollectService.buildTransactionProperties(actions)
    const pageIdx = indexOfName(list, '主页面')
    const actionIdx = indexOfName(list, '页面操作')
    assert(pageIdx >= 0, '缺少默认主页面分组')
    assert(actionIdx >= 0, '缺少页面操作')
    assert(pageIdx < actionIdx, '页面操作应在主页面分组之后')
  })

  run('折叠面板内按钮触发的弹窗挂在该按钮之后', function () {
    const tab = { type: 'tab', key: '//div[tab]', propertiesName: '客户基本信息' }
    const collapse = { type: 'collapse', key: '//div[collapse]', propertiesName: '对公客户概况' }
    const addressDialog = { type: 'dialog', key: '//div[address]', propertiesName: '地址填写' }
    const actualDialog = { type: 'dialog', key: '//div[actual]', propertiesName: '选择实际经营地址' }

    const actions = [
      { clientId: 'a1', group: [page, tab, collapse], propertiesName: '单位地址邮政编码', eventTypeValue: 'input', timestamp: 1 },
      { clientId: 'a2', group: [page, tab, collapse], propertiesName: '单位地址_获取地址', eventTypeValue: 'click', timestamp: 2 },
      { clientId: 'a3', group: [page, addressDialog], propertiesName: '省份', eventTypeValue: 'select', timestamp: 3 },
      { clientId: 'a4', group: [page, addressDialog], propertiesName: '确认', eventTypeValue: 'click', timestamp: 4 },
      { clientId: 'a5', group: [page, tab, collapse], propertiesName: '实际经营地址_选择', eventTypeValue: 'click', timestamp: 5 },
      { clientId: 'a6', group: [page, actualDialog], propertiesName: '城市', eventTypeValue: 'select', timestamp: 6 },
      { clientId: 'a7', group: [page, actualDialog], propertiesName: '确认', eventTypeValue: 'click', timestamp: 7 }
    ]

    const list = CollectService.buildTransactionProperties(actions)
    const collapseIdx = indexOfName(list, '对公客户概况')
    const getAddressIdx = indexOfName(list, '单位地址_获取地址')
    const addressDialogIdx = list.findIndex(item => item.type === 'dialog' && item.propertiesName.startsWith('地址填写'))
    const provinceIdx = indexOfName(list, '省份')
    const chooseActualIdx = indexOfName(list, '实际经营地址_选择')
    const actualDialogIdx = list.findIndex(item => item.type === 'dialog' && item.propertiesName.startsWith('选择实际经营地址'))
    const cityIdx = indexOfName(list, '城市')

    assert(collapseIdx >= 0, '缺少对公客户概况分组')
    assert(getAddressIdx >= 0, '缺少单位地址_获取地址')
    assert(addressDialogIdx >= 0, '缺少地址填写弹窗')
    assert(provinceIdx >= 0, '缺少省份')
    assert(chooseActualIdx >= 0, '缺少实际经营地址_选择')
    assert(actualDialogIdx >= 0, '缺少选择实际经营地址弹窗')
    assert(cityIdx >= 0, '缺少城市')

    // 两个弹窗分组的父分组都应该是“对公客户概况”
    const collapseId = list[collapseIdx].propertiesID
    assert(list[addressDialogIdx].propertiesPID === collapseId, '地址填写弹窗应挂在“对公客户概况”下')
    assert(list[actualDialogIdx].propertiesPID === collapseId, '选择实际经营地址弹窗应挂在“对公客户概况”下')

    // 弹窗分组紧跟对应触发按钮
    assert(getAddressIdx < addressDialogIdx, '地址填写弹窗应位于单位地址_获取地址之后')
    assert(addressDialogIdx < provinceIdx, '省份应在地址填写弹窗之后')
    assert(chooseActualIdx < actualDialogIdx, '选择实际经营地址弹窗应位于实际经营地址_选择之后')
    assert(actualDialogIdx < cityIdx, '城市应在选择实际经营地址弹窗之后')
  })

  run('弹窗关闭后回到原分组不生成重复分组', function () {
    const tab = { type: 'tab', key: '//div[tab]', propertiesName: '客户基本信息' }
    const collapse = { type: 'collapse', key: '//div[collapse]', propertiesName: '基本信息' }
    const dialog = { type: 'dialog', key: '//div[dialog]', propertiesName: '获取单位地址' }

    const actions = [
      { clientId: 'a1', group: [page, tab, collapse], propertiesName: '户号', eventTypeValue: 'input', timestamp: 1 },
      { clientId: 'a2', group: [page, tab, collapse], propertiesName: '获取单位地址', eventTypeValue: 'click', timestamp: 2 },
      { clientId: 'a3', group: [page, dialog], propertiesName: '省份', eventTypeValue: 'select', timestamp: 3 },
      { clientId: 'a4', group: [page, dialog], propertiesName: '确认', eventTypeValue: 'click', timestamp: 4 },
      { clientId: 'a5', group: [page, tab, collapse], propertiesName: '职务', eventTypeValue: 'select', timestamp: 5 },
      { clientId: 'a6', group: [page, tab, collapse], propertiesName: '职称', eventTypeValue: 'select', timestamp: 6 }
    ]

    const list = CollectService.buildTransactionProperties(actions)
    const tabGroups = list.filter(item => item.type === 'tab')
    const collapseGroups = list.filter(item => item.type === 'collapse')
    assert(tabGroups.length === 1, '客户基本信息不应生成重复分组，实际 ' + tabGroups.length)
    assert(collapseGroups.length === 1, '基本信息不应生成重复分组，实际 ' + collapseGroups.length)

    const confirmIdx = indexOfName(list, '确认')
    const jobIdx = indexOfName(list, '职务')
    const titleIdx = indexOfName(list, '职称')
    assert(confirmIdx < jobIdx, '职务应在弹窗确认之后')
    assert(jobIdx < titleIdx, '职称应在职务之后')
  })

  run('无中间页面操作的连续弹窗动作保持同一实例', function () {
    const collapse = { type: 'collapse', key: '//div[collapse]', propertiesName: '基本信息' }
    const dialog = { type: 'dialog', key: '//div[dialog]', propertiesName: '获取单位地址' }

    const actions = [
      { clientId: 'a1', group: [page, collapse], propertiesName: '获取单位地址', eventTypeValue: 'click', timestamp: 1 },
      { clientId: 'a2', group: [page, dialog], propertiesName: '省份', eventTypeValue: 'select', timestamp: 2 },
      { clientId: 'a3', group: [page, dialog], propertiesName: '详细地址', eventTypeValue: 'input', timestamp: 3 },
      { clientId: 'a4', group: [page, dialog], propertiesName: '确认', eventTypeValue: 'click', timestamp: 4 }
    ]

    const list = CollectService.buildTransactionProperties(actions)
    const dialogGroups = list.filter(item => item.type === 'dialog')
    assert(dialogGroups.length === 1, '连续弹窗动作不应被切到两个分组，实际 ' + dialogGroups.length)

    const provinceIdx = indexOfName(list, '省份')
    const detailIdx = indexOfName(list, '详细地址')
    const confirmIdx = indexOfName(list, '确认')
    assert(provinceIdx < detailIdx, '详细地址应紧跟省份')
    assert(detailIdx < confirmIdx, '确认应在详细地址之后')
  })

  run('downloadJsonOffscreen 在 service worker 中触发下载', async function () {
    window._downloadCalls.length = 0
    const payload = { id: 'test', name: 'collect', data: { value: '中文测试' } }
    await CollectService.downloadJsonOffscreen(payload, 'collect/2026-test.json')
    assert(window._downloadCalls.length === 1, '应触发一次下载')
    const call = window._downloadCalls[0]
    assert(call.filename === 'collect/2026-test.json', 'filename 应正确')
    assert(call.saveAs === false, 'saveAs 应为 false')
    assert(typeof call.url === 'string' && call.url.startsWith('blob:'), '应使用 blob URL 下载')
  })

  run('telemetryHost 为空时跳过上传', async function () {
    APP_DEFAULT_CONFIG.collect.telemetryHost = ''
    const result = await CollectService.uploadJson({ id: 'test' })
    assert(result.skipped === true, '应返回 skipped=true')
  })

  run('telemetryHost 配置后上传 JSON 到 /api/v2/telemetry/batches', async function () {
    APP_DEFAULT_CONFIG.collect.telemetryHost = 'http://172.20.101.63:11002'
    const calls = []
    const originalFetch = window.fetch
    window.fetch = async function (url, options) {
      calls.push({ url: url, options: options })
      return { ok: true, status: 200 }
    }
    try {
      const payload = { id: 'test-upload', name: 'collect' }
      const result = await CollectService.uploadJson(payload)
      assert(result.uploaded === true, '应返回 uploaded=true')
      assert(calls.length === 1, '应发起一次 fetch')
      assert(calls[0].url === 'http://172.20.101.63:11002/api/v2/telemetry/batches', 'URL 应正确')
      assert(calls[0].options.method === 'POST', '应使用 POST')
      assert(calls[0].options.headers['Content-Type'] === 'application/json', 'Content-Type 应为 application/json')
      assert(calls[0].options.body === JSON.stringify(payload), 'body 应为序列化后的 payload')
    } finally {
      window.fetch = originalFetch
    }
  })

  run('上传接口非 2xx 时返回失败但不抛异常', async function () {
    APP_DEFAULT_CONFIG.collect.telemetryHost = 'http://172.20.101.63:11002'
    const originalFetch = window.fetch
    window.fetch = async function () {
      return { ok: false, status: 500, statusText: 'Internal Server Error' }
    }
    try {
      const result = await CollectService.uploadJson({ id: 'test' })
      assert(result.uploaded === false, '应返回 uploaded=false')
      assert(result.error && result.error.includes('500'), 'error 应包含 HTTP 500')
    } finally {
      window.fetch = originalFetch
    }
  })
})()
