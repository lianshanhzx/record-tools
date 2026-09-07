(function () {
  'use strict'

  const results = document.getElementById('results')
  const summary = document.getElementById('summary')
  let passed = 0

  function run(name, test) {
    const row = document.createElement('li')
    try {
      test()
      row.className = 'pass'
      row.textContent = 'PASS: ' + name
      passed++
    } catch (error) {
      row.className = 'fail'
      row.textContent = 'FAIL: ' + name + ' - ' + error.message
      console.error(name, error)
    }
    results.appendChild(row)
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  run('表格图标点击提升到可点击操作元素', function () {
    const root = document.createElement('table')
    root.innerHTML = '<tbody><tr><td><span class="row-action" role="button"><i class="edit-icon"></i></span></td></tr></tbody>'
    document.body.appendChild(root)
    const icon = root.querySelector('i')
    const action = EventMonitor.getTableActionElement(icon)
    assert(action && action.className === 'row-action', '未找到表格操作元素')
    root.remove()
  })

  run('表格普通文字点击不识别为操作', function () {
    const root = document.createElement('table')
    root.innerHTML = '<tbody><tr><td>客户名称</td></tr></tbody>'
    document.body.appendChild(root)
    assert(EventMonitor.getTableActionElement(root.querySelector('td')) === null, '普通单元格不应被识别为操作')
    root.remove()
  })

  run('表格带 aria-label 的图标点击识别为操作', function () {
    const root = document.createElement('table')
    root.innerHTML = '<tbody><tr><td><span class="icon" aria-label="编辑"><i></i></span></td></tr></tbody>'
    document.body.appendChild(root)
    const action = EventMonitor.getTableActionElement(root.querySelector('i'))
    assert(action && action.getAttribute('aria-label') === '编辑', '未识别 aria-label 操作元素')
    root.remove()
  })

  run('表格 cursor:pointer 自定义元素识别为操作', function () {
    const root = document.createElement('table')
    root.innerHTML = '<tbody><tr><td><span class="custom-control"><i></i></span></td></tr></tbody>'
    root.querySelector('.custom-control').style.cursor = 'pointer'
    document.body.appendChild(root)
    const action = EventMonitor.getTableActionElement(root.querySelector('i'))
    assert(action && action.className === 'custom-control', '未识别 cursor:pointer 操作元素')
    root.remove()
  })

  run('表格 Element UI 单选框找到原生 input', function () {
    const root = document.createElement('table')
    root.innerHTML = '<tbody><tr><td><div class="cell"><label role="radio" class="el-radio"><span class="el-radio__input"><span class="el-radio__inner"></span><input type="radio" aria-hidden="true" class="el-radio__original" value="[object Object]"></span><span class="el-radio__label"><i></i></span></label></div></td></tr></tbody>'
    document.body.appendChild(root)
    const radio = root.querySelector('.el-radio')
    const input = radio.querySelector('input[type="radio"]')
    const action = EventMonitor.getTableActionElement(input)
    assert(input && action === radio, 'Element UI 单选框未识别为表格操作')
    root.remove()
  })

  run('表格按钮图标提升到按钮元素', function () {
    const root = document.createElement('table')
    root.innerHTML = '<tbody><tr><td><button type="button" class="row-edit"><span class="icon"></span></button></td></tr></tbody>'
    document.body.appendChild(root)
    const action = EventMonitor.getTableActionElement(root.querySelector('.icon'))
    assert(action && action.tagName === 'BUTTON', '未找到表格按钮元素')
    root.remove()
  })

  run('表格 Element UI 多选框识别为表单控件', function () {
    const root = document.createElement('table')
    root.innerHTML = '<tbody><tr><td><label class="el-checkbox"><span class="el-checkbox__input"><input type="checkbox" checked></span><span class="el-checkbox__label"><i></i></span></label></td></tr></tbody>'
    document.body.appendChild(root)
    const input = root.querySelector('input[type="checkbox"]')
    const action = EventMonitor.getTableActionElement(input)
    assert(action && action.classList.contains('el-checkbox'), '未识别 Element UI 多选框')
    root.remove()
  })

  run('表单内按钮的内部文字归一到按钮点击操作', function () {
    const root = document.createElement('form')
    root.innerHTML = '<label><button type="button" class="el-button" command="click"><span>保存</span></button></label>'
    document.body.appendChild(root)
    const action = EventMonitor.getClickActionElement(root.querySelector('span'))
    assert(action && action.tagName === 'BUTTON', '未归一到表单内按钮元素')
    root.remove()
  })

  summary.textContent = passed + '/8 通过'
  summary.className = passed === 8 ? 'pass' : 'fail'
  document.title = passed === 8 ? 'PASS - EventMonitor tests' : 'FAIL - EventMonitor tests'
})()
