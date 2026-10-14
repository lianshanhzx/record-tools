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
})()
