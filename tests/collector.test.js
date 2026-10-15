(function () {
  'use strict'

  const results = document.getElementById('results')
  const summary = document.getElementById('summary')
  let passed = 0
  let total = 0

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  async function run(name, test) {
    total++
    const row = document.createElement('li')
    results.appendChild(row)
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

  run('无天元弹窗时主动触发 floatingAction 打开并记录配置，随后自动关闭', async function () {
    const root = document.createElement('div')
    root.innerHTML = [
      '<div class="floatingAction" id="trigger-btn"><i class="el-icon-question"></i></div>'
    ].join('')
    document.body.appendChild(root)

    const triggerBtn = root.querySelector('#trigger-btn')
    let dialogElement = null
    let closed = false

    // 模拟点击 floatingAction 后在 DOM 中挂载天元配置弹窗
    triggerBtn.addEventListener('click', function () {
      dialogElement = document.createElement('div')
      dialogElement.className = 'el-dialog'
      dialogElement.setAttribute('aria-label', '天元相关配置')
      dialogElement.innerHTML = [
        '<div class="el-dialog__header"><button class="el-dialog__headerbtn">close</button></div>',
        '<div class="el-dialog__body">',
        '  <p><span>组件编号：</span><span>ZJJK00012345</span></p>',
        '  <p><span>页面名称：</span><span>测试对公客户</span></p>',
        '</div>'
      ].join('')
      dialogElement.querySelector('.el-dialog__headerbtn').addEventListener('click', function () {
        closed = true
        dialogElement.remove()
      })
      document.body.appendChild(dialogElement)
    })

    window._messages.length = 0
    Collector.reportPageConfig()

    // 等待两次轮询（约 600ms）后触发 floatingAction，以及随后获取配置（约 300ms）
    await wait(1200)

    const configMessages = window._messages.filter(msg => msg.type === 'collectPageConfig')
    assert(configMessages.length === 1, '应上报一次 collectPageConfig')
    const config = configMessages[0].pageConfig
    assert(config['组件编号'] === 'ZJJK00012345', '未能正确读取主动触发的天元配置组件编号')
    assert(config['页面名称'] === '测试对公客户', '未能正确读取主动触发的天元配置页面名称')
    assert(closed, '采集天元配置后应自动关闭弹窗')

    root.remove()
    if (dialogElement && dialogElement.parentNode) dialogElement.remove()
  })
})()
