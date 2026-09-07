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

  testResults.push(run('读取按钮关联的简短 tooltip', function () {
    fixtures.innerHTML = '<button aria-describedby="tip"><i id="icon"></i></button><span id="tip" role="tooltip">刷新列表</span>'
    assert(getChineseLabelByElement(fixtures.querySelector('#icon')) === '刷新列表', '未读取关联 tooltip')
  }))

  testResults.push(run('过长 tooltip 不作为业务名称', function () {
    fixtures.innerHTML = '<button aria-describedby="tip" title="打开设置"><i id="icon"></i></button><span id="tip" role="tooltip">这是一个非常长的提示文本，超过三十个字后不应作为业务名称</span>'
    assert(getChineseLabelByElement(fixtures.querySelector('#icon')) === '打开设置', '过长 tooltip 未回退到 title')
  }))

  testResults.push(run('无 label 的单选框和勾选框使用默认名称', function () {
    fixtures.innerHTML = '<input type="radio"><input type="checkbox">'
    assert(getChineseLabelByElement(fixtures.querySelector('input[type="radio"]')) === '单选', '单选框默认名称错误')
    assert(getChineseLabelByElement(fixtures.querySelector('input[type="checkbox"]')) === '勾选', '勾选框默认名称错误')
  }))

  testResults.push(run('组件包装器无 label 时使用默认名称', function () {
    fixtures.innerHTML = '<label class="el-radio"><input type="radio"></label><label class="el-checkbox"><input type="checkbox"></label>'
    assert(getChineseLabelByElement(fixtures.querySelector('.el-radio')) === '单选', '组件单选框默认名称错误')
    assert(getChineseLabelByElement(fixtures.querySelector('.el-checkbox')) === '勾选', '组件勾选框默认名称错误')
  }))

  fixtures.innerHTML = ''
  const passedCount = testResults.filter(Boolean).length
  const passed = passedCount === testResults.length
  summary.className = passed ? 'pass' : 'fail'
  summary.textContent = passedCount + '/' + testResults.length + ' 通过'
  document.title = passed ? 'PASS - ElementBusinessName tests' : 'FAIL - ElementBusinessName tests'
})()
