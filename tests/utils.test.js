(function () {
  'use strict'

  const results = document.getElementById('results')
  const summary = document.getElementById('summary')
  const testResults = []

  function assert(condition, message) {
    if (!condition) throw new Error(message || '断言失败')
  }

  function run(name, test) {
    const row = document.createElement('li')
    try {
      test()
      row.className = 'pass'
      row.textContent = 'PASS: ' + name
      return true
    } catch (error) {
      row.className = 'fail'
      row.textContent = 'FAIL: ' + name + ' - ' + error.message
      console.error(name, error)
      return false
    } finally {
      results.appendChild(row)
    }
  }

  const cases = [
    ['点击', 'click', 'click'],
    ['输入', 'fill_form_field', 'input'],
    ['下拉框选择', 'selectOption', 'select:click'],
    ['树形选择', 'select_tree_option', 'select:tree'],
    ['单选', 'select_radio', 'radio'],
    ['日期', 'fill_date_field', 'date']
  ]

  cases.forEach(function ([name, input, expected]) {
    testResults.push(run(name + '映射', function () {
      assert(Utils.normalizeEventType(input) === expected, input + ' 未映射为 ' + expected)
    }))
  })

  testResults.push(run('中文事件名称映射', function () {
    assert(Utils.getEventTypeName('select:click') === '下拉框选择', '下拉框名称错误')
    assert(Utils.getEventTypeName('select:tree') === '树形选择', '树形选择名称错误')
    assert(Utils.getEventTypeName('radio') === '单选', '单选名称错误')
  }))

  testResults.push(run('读取隐藏天元配置弹窗的组件编号', function () {
    const root = document.createElement('div')
    root.innerHTML = '<div role="dialog" aria-label="天元相关配置" style="display:none"><p><span>组件编号：</span><span>ZJJK00066153</span></p></div>'
    assert(Utils.getTianyuanComponentId(root) === 'ZJJK00066153', '未读取到组件编号')
  }))

  testResults.push(run('天元配置弹窗缺少组件编号时返回空值', function () {
    const root = document.createElement('div')
    root.innerHTML = '<div role="dialog" aria-label="天元相关配置"><p><span>页面名称：</span><span>对公客户管理页</span></p></div>'
    assert(Utils.getTianyuanComponentId(root) === '', '不应返回组件编号')
  }))

  testResults.push(run('天元配置弹窗不存在时返回空值', function () {
    const root = document.createElement('div')
    assert(Utils.getTianyuanComponentId(root) === '', '不应返回组件编号')
  }))

  testResults.push(run('pageId 回退格式', function () {
    assert(Utils.generatePageId(1725091234567) === 'CJLZ1725091234567', 'pageId 格式错误')
  }))

  testResults.push(run('导出包含 pageId', function () {
    const data = JSON.parse(Utils.actionTree2Json([], 'https://example.test', 'ZJJK00066153'))
    assert(data.pageId === 'ZJJK00066153', '导出缺少 pageId')
  }))

  testResults.push(run('导出名称写入顶层 name', function () {
    const data = JSON.parse(Utils.actionTree2Json([], 'https://example.test', 'page-1', '业务流程'))
    assert(data.name === '业务流程', '导出名称错误')
  }))

  const passedCount = testResults.filter(Boolean).length
  const passed = passedCount === testResults.length
  summary.className = passed ? 'pass' : 'fail'
  summary.textContent = passedCount + '/' + testResults.length + ' 通过'
  document.title = passed ? 'PASS - Utils tests' : 'FAIL - Utils tests'
})()
