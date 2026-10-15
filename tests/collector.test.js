(function () {
  'use strict'

  const results = document.getElementById('results')
  const summary = document.getElementById('summary')
  let passed = 0
  let total = 0

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  let testQueue = Promise.resolve()
  function run(name, test) {
    total++
    const row = document.createElement('li')
    results.appendChild(row)

    testQueue = testQueue.then(async () => {
      try {
        await test()
        passed++
        row.className = 'pass'
        row.textContent = 'PASS: ' + name
      } catch (error) {
        row.className = 'fail'
        row.textContent = 'FAIL: ' + name + ' - ' + error.message
        console.error(name, error)
      }
      summary.textContent = passed + '/' + total + ' 通过'
      summary.className = passed === total ? 'pass' : 'fail'
      document.title = passed === total ? 'PASS - Collector tests' : 'FAIL - Collector tests'
    })
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function fixture() {
    const root = document.createElement('div')
    root.innerHTML = [
      '<div class="el-form-item"><div class="el-input" aria-describedby="tree-popup"><input id="industry"></div></div>',
      '<div id="tree-popup" class="el-popover tree-popover">',
      '  <div class="tsscTree"><div class="el-tree" role="tree">',
      '    <div class="el-tree-node"><div class="el-tree-node__content"><span class="el-tree-node__expand-icon"></span><span class="dropdown-tree"><span class="node">建筑业</span></span></div></div>',
      '    <div class="el-tree-node"><div class="el-tree-node__content"><span class="el-tree-node__expand-icon is-leaf"></span><span class="dropdown-tree"><span class="node">住宅房屋建筑</span></span></div></div>',
      '  </div></div>',
      '</div>'
    ].join('')
    document.body.appendChild(root)
    return root
  }

  run('表格字段采集属性名称和真实标签', async function () {
    const root = document.createElement('div')
    root.innerHTML = [
      '<table><tbody>',
      '  <tr><td><div class="cell">资产负债率：</div></td><td><div class="cell"><input></div></td></tr>',
      '  <tr><td><div class="cell">业务往来及使用</div></td><td><div class="cell"><div class="el-select"><input class="el-input__inner" readonly></div></div></td></tr>',
      '</tbody></table>'
    ].join('')
    document.body.appendChild(root)
    const originalCollecting = Collector._collecting
    Collector._collecting = true
    window._messages.length = 0

    const inputAction = Collector.recordAction(root.querySelector('input'), 'input', '输入')
    const selectAction = Collector.recordAction(root.querySelectorAll('input')[1], 'select', '下拉框xpath选择')

    assert(inputAction.propertiesName === '资产负债率', '输入框 propertiesName 未清理并写入表格标签')
    assert(inputAction.realLabel === '资产负债率：', '输入框 realLabel 未写入原始表格标签')
    assert(selectAction.propertiesName === '业务往来及使用', '下拉框 propertiesName 未写入表格标签')
    assert(selectAction.realLabel === '业务往来及使用', '下拉框 realLabel 未写入表格标签')
    assert(inputAction.xpath.indexOf('资产负债率') !== -1, '输入框 XPath 未使用表格标签')
    assert(selectAction.xpath.indexOf('业务往来及使用') !== -1, '下拉框 XPath 未使用表格标签')

    Collector._collecting = originalCollecting
    root.remove()
  })

  run('树节点展开不产生独立动作，叶子节点更新入口动作', async function () {
    const root = fixture()
    const input = root.querySelector('#industry')
    const branch = root.querySelectorAll('.el-tree-node__content')[0]
    const leaf = root.querySelectorAll('.el-tree-node__content')[1]
    const action = {
      clientId: 'tree-action', eventTypeValue: 'click', eventTypeName: '点击', objectValue: '',
      group: [{ type: 'page', key: 'page' }, { type: 'collapse', key: 'collapse' }],
      attributes: {}, _reportPromise: Promise.resolve()
    }
    Object.defineProperty(action, '_reportPromise', { enumerable: false, value: Promise.resolve() })
    window._messages.length = 0
    const originalHasVisibleTreePopup = TreeSelectHandler.hasVisibleTreePopup
    TreeSelectHandler.hasVisibleTreePopup = function () { return true }
    Collector.startTreeSelectCandidate(input, action)

    Collector.completeTreeSelect(branch)
    await wait(180)
    assert(window._messages.filter(message => message.type === 'collectActionUpdate').length === 0, '展开节点不应上报 collectActionUpdate')
    assert(Collector._pendingTreeSelect, '展开节点后应保留候选状态')

    input.value = '住宅房屋建筑'
    Collector.completeTreeSelect(leaf)
    await wait(180)
    const updates = window._messages.filter(message => message.type === 'collectActionUpdate')
    assert(updates.length === 1, '叶子节点应只更新一次入口动作')
    assert(updates[0].clientId === 'tree-action', '应按入口动作 clientId 更新')
    assert(updates[0].updates.eventTypeValue === 'select:tree', '应更新为树形选择')
    assert(updates[0].updates.objectValue === '住宅房屋建筑', '应写入最终选中值')
    assert(action.group.length === 2, '入口原有分组必须保持不变')
    TreeSelectHandler.hasVisibleTreePopup = originalHasVisibleTreePopup
    root.remove()
  })

  run('接口直接获取天元相关配置并正确映射所有中文键名', async function () {
    const originalHash = window.location.hash
    const originalFetch = window.fetch
    window.location.hash = '#/rtgMgt/cpctRtg/newCpctRtg/cstmgrIttCpctRtg/FS00005854HostCstmgrIttCpctRtgAply?part=test&newtag=false'

    let requestBody = null
    window.fetch = async function (url, options) {
      if (url.indexOf('/prod-api/tansun-tcp-ipc/ipcFcnScnInf/getPageRelInfo') !== -1) {
        requestBody = JSON.parse(options.body)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 200,
            description: '操作成功',
            data: {
              tskEcd: 'UML00130188PDCP',
              pdCmptEcd: '新增对公客户评级-主办客户经理发起对公客户评级申请组件(ZJJK00109206)',
              tskNm: '客户经理发起对公客户评级',
              fcnScnEcd: 'FS00005854',
              pdTplNm: '新增对公客户评级-主办客户经理发起对公客户评级申请页面',
              fcnScnNm: '新增对公客户评级',
              avyNm: '新增对公客户评级',
              resPath: '/rtgMgt/cpctRtg/newCpctRtg/cstmgrIttCpctRtg/FS00005854HostCstmgrIttCpctRtgAply'
            }
          })
        }
      }
      return originalFetch.apply(this, arguments)
    }

    window._messages.length = 0
    await Collector.reportPageConfig()

    assert(requestBody, '未调用天元配置接口')
    assert(requestBody.resPath === '/rtgMgt/cpctRtg/newCpctRtg/cstmgrIttCpctRtg/FS00005854HostCstmgrIttCpctRtgAply', 'resPath 参数解析不正确')

    const configMessages = window._messages.filter(msg => msg.type === 'collectPageConfig')
    assert(configMessages.length === 1, '应上报一次 collectPageConfig')
    const config = configMessages[0].pageConfig
    assert(config['活动名称'] === '新增对公客户评级', '活动名称映射错误')
    assert(config['页面名称'] === '新增对公客户评级-主办客户经理发起对公客户评级申请页面', '页面名称映射错误')
    assert(config['页面路径'] === '/rtgMgt/cpctRtg/newCpctRtg/cstmgrIttCpctRtg/FS00005854HostCstmgrIttCpctRtgAply', '页面路径映射错误')
    assert(config['场景名称'] === '新增对公客户评级', '场景名称映射错误')
    assert(config['场景编号'] === 'FS00005854', '场景编号映射错误')
    assert(config['任务名称'] === '客户经理发起对公客户评级', '任务名称映射错误')
    assert(config['任务编号'] === 'UML00130188PDCP', '任务编号映射错误')
    assert(config['组件编号'] === '新增对公客户评级-主办客户经理发起对公客户评级申请组件(ZJJK00109206)', '组件编号映射错误')

    window.location.hash = originalHash
    window.fetch = originalFetch
  })

  run('天元配置接口失败时平滑降级回退到 DOM 弹窗扫描', async function () {
    const originalHash = window.location.hash
    const originalFetch = window.fetch
    window.location.hash = '#/test/path'

    // 模拟接口失败（例如 404 或网络报错）
    window.fetch = async function () {
      return { ok: false, status: 404 }
    }

    const dialogElement = document.createElement('div')
    dialogElement.className = 'el-dialog'
    dialogElement.setAttribute('aria-label', '天元相关配置')
    dialogElement.innerHTML = [
      '<div class="el-dialog__body">',
      '  <p><span>组件编号：</span><span>ZJJK_FALLBACK</span></p>',
      '  <p><span>页面名称：</span><span>DOM降级测试</span></p>',
      '</div>'
    ].join('')
    document.body.appendChild(dialogElement)

    window._messages.length = 0
    await Collector.reportPageConfig()

    const configMessages = window._messages.filter(msg => msg.type === 'collectPageConfig')
    assert(configMessages.length === 1, '应上报一次 collectPageConfig')
    const config = configMessages[0].pageConfig
    assert(config['组件编号'] === 'ZJJK_FALLBACK', '未能降级扫描到 DOM 中的组件编号')
    assert(config['页面名称'] === 'DOM降级测试', '未能降级扫描到 DOM 中的页面名称')

    dialogElement.remove()
    window.location.hash = ''
    window.fetch = originalFetch
  })
})()
