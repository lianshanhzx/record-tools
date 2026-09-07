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

  run('异步先到的弹窗分组仍紧跟触发按钮', function () {
    const page = { type: 'page', key: '__page__:test', propertiesName: '主页面', fixedKey: true }
    const dialog = { type: 'dialog', key: 'dialog-detail', propertiesName: '详情弹窗' }
    const trigger = { target: 'button-open', propertiesName: '打开详情', eventTypeValue: 'click', eventTypeName: '点击', group: [page] }
    const dialogField = {
      target: 'dialog-field', propertiesName: '名称', eventTypeValue: 'input', eventTypeName: '输入',
      group: [page, dialog], anchorTarget: 'button-open', anchorPropertiesName: '打开详情'
    }

    RecordManager.renderRecordList([dialogField, trigger])
    const content = document.getElementById('listBody').textContent
    assert(content.indexOf('打开详情') < content.indexOf('详情弹窗'), '弹窗分组没有挂在触发按钮之后')
  })

  run('没有新增分组的确认按钮也紧跟其触发记录', function () {
    const page = { type: 'page', key: '__page__:test-2', propertiesName: '主页面', fixedKey: true }
    const trigger = { target: 'button-delete', propertiesName: '删除', eventTypeValue: 'click', eventTypeName: '点击', group: [page] }
    const confirm = { target: 'button-confirm', propertiesName: '确认删除', eventTypeValue: 'click', eventTypeName: '点击', group: [page], anchorTarget: 'button-delete' }

    RecordManager.renderRecordList([confirm, trigger])
    const content = document.getElementById('listBody').textContent
    assert(content.indexOf('删除') < content.indexOf('确认删除'), '确认按钮没有挂在删除记录之后')
  })

  run('同一按钮的两次人工点击保留两条记录', function () {
    RecordManager.clearAll()
    const first = {
      target: 'button-delete', propertiesName: '删除', eventTypeValue: 'click', eventTypeName: '点击',
      pageKey: '__page__:test-3', manualRecord: true, recorded: true, propertiesID: 'action-1'
    }
    const second = Object.assign({}, first, { propertiesID: 'action-2', timestamp: Date.now() + 1 })
    RecordManager.handleMessage({ type: 'addActionData', data: first })
    RecordManager.handleMessage({ type: 'addActionData', data: second })
    assert(RecordManager.recordActionList.filter(item => item.target === 'button-delete').length === 2, '重复按钮点击被合并了')
  })

  run('同标题弹窗按两次不同点击分别挂载', function () {
    RecordManager.clearAll()
    const page = { type: 'page', key: '__page__:test-4', propertiesName: '主页面', fixedKey: true }
    const firstAction = {
      target: 'button-add-root', propertiesName: '新增一级分类', eventTypeValue: 'click', eventTypeName: '点击',
      pageKey: '__page__:test-4', group: [page], manualRecord: true, recorded: true, propertiesID: 'click-1'
    }
    const secondAction = {
      target: 'button-add-child', propertiesName: '新增分类', eventTypeValue: 'click', eventTypeName: '点击',
      pageKey: '__page__:test-4', group: [page], manualRecord: true, recorded: true, propertiesID: 'click-2'
    }
    const firstDialogField = {
      target: 'dialog-name', propertiesName: '分类名称', eventTypeValue: 'input', eventTypeName: '输入',
      pageKey: '__page__:test-4', group: [page, { type: 'dialog', key: 'same-dialog', propertiesName: '弹窗' }],
      anchorTarget: 'button-add-root', anchorRecordKey: 'click-1'
    }
    const secondDialogField = Object.assign({}, firstDialogField, {
      anchorTarget: 'button-add-child', anchorRecordKey: 'click-2'
    })

    RecordManager.renderRecordList([firstDialogField, secondAction, secondDialogField, firstAction])
    const headers = Array.from(document.querySelectorAll('#listBody .list-group-header .group-name'))
      .map(node => node.textContent)
    const firstButtonIndex = document.getElementById('listBody').textContent.indexOf('新增一级分类')
    const firstDialogIndex = document.getElementById('listBody').textContent.indexOf('分类名称')
    const secondButtonIndex = document.getElementById('listBody').textContent.indexOf('新增分类')
    assert(headers.filter(name => name === '弹窗').length === 2, '同标题弹窗没有生成两个独立分组')
    assert(firstButtonIndex < firstDialogIndex, '第一个弹窗没有挂在新增一级分类之后')
    assert(secondButtonIndex < document.getElementById('listBody').textContent.lastIndexOf('分类名称'), '第二个弹窗没有挂在新增分类之后')
  })

  run('同一按钮两次触发的同标题弹窗保持独立实例', function () {
    RecordManager.clearAll()
    const page = { type: 'page', key: '__page__:test-5', propertiesName: '主页面', fixedKey: true }
    const trigger = target => ({
      target: target, propertiesName: '新增分类', eventTypeValue: 'click', eventTypeName: '点击',
      pageKey: '__page__:test-5', group: [page], manualRecord: true, recorded: true
    })
    const first = Object.assign(trigger('button-add'), { propertiesID: 'click-1' })
    const second = Object.assign(trigger('button-add'), { propertiesID: 'click-2' })
    const dialog = key => ({
      target: 'dialog-name', propertiesName: '分类名称', eventTypeValue: 'input', eventTypeName: '输入',
      pageKey: '__page__:test-5', group: [page, { type: 'dialog', key: 'same-dialog', propertiesName: '弹窗' }],
      anchorTarget: 'button-add', anchorRecordKey: key
    })

    RecordManager.renderRecordList([dialog('click-1'), second, dialog('click-2'), first])
    const listText = document.getElementById('listBody').textContent
    assert(Array.from(document.querySelectorAll('#listBody .group-name')).filter(node => node.textContent === '弹窗').length === 2, '同一按钮的两个弹窗实例被合并')
    assert(listText.indexOf('新增分类') < listText.indexOf('分类名称'), '第一个弹窗未挂到第一次点击')
    assert(listText.lastIndexOf('新增分类') < listText.lastIndexOf('分类名称'), '第二个弹窗未挂到第二次点击')
  })

  summary.textContent = passed + '/5 通过'
  summary.className = passed === 5 ? 'pass' : 'fail'
  document.title = passed === 5 ? 'PASS - RecordManager tests' : 'FAIL - RecordManager tests'
})()
