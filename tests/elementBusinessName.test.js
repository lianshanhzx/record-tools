(function () {
  'use strict'

  const fixtures = document.getElementById('fixtures')
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

  testResults.push(run('读取 label[for] 关联文本', function () {
    fixtures.innerHTML = '<label for="customer">客户名称</label><input id="customer">'
    assert(getRealLabelByElement(fixtures.querySelector('input')) === '客户名称', '未读取关联 label')
  }))

  testResults.push(run('向上读取包裹 label 文本', function () {
    fixtures.innerHTML = '<label>证件号码<input></label>'
    assert(getRealLabelByElement(fixtures.querySelector('input')) === '证件号码', '未读取包裹 label')
  }))

  testResults.push(run('读取 Element UI 表单项标签', function () {
    fixtures.innerHTML = '<div class="el-form-item"><label>客户等级</label><div><input></div></div>'
    assert(getRealLabelByElement(fixtures.querySelector('input')) === '客户等级', '未向上读取表单项标签')
  }))

  testResults.push(run('真实标签不拼接按钮文本', function () {
    fixtures.innerHTML = '<div class="el-form-item"><label>客户管理</label><div><button>新增</button></div></div>'
    const button = fixtures.querySelector('button')
    assert(getChineseLabelByElement(button) === '客户管理_新增', '业务名称未使用下划线拼接')
    assert(getRealLabelByElement(button) === '客户管理', '真实标签错误拼接了按钮文本')
  }))

  fixtures.innerHTML = ''
  const passedCount = testResults.filter(Boolean).length
  const passed = passedCount === testResults.length
  summary.className = passed ? 'pass' : 'fail'
  summary.textContent = passedCount + '/' + testResults.length + ' 通过'
  document.title = passed ? 'PASS - ElementBusinessName tests' : 'FAIL - ElementBusinessName tests'
})()
