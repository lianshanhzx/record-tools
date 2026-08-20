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

  const passedCount = testResults.filter(Boolean).length
  const passed = passedCount === testResults.length
  summary.className = passed ? 'pass' : 'fail'
  summary.textContent = passedCount + '/' + testResults.length + ' 通过'
  document.title = passed ? 'PASS - Utils tests' : 'FAIL - Utils tests'
})()
