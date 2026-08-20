(function () {
  'use strict';

  const fixtures = document.getElementById('fixtures');
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');

  function assert(condition, message) {
    if (!condition) throw new Error(message || '断言失败');
  }

  function run(name, test) {
    const row = document.createElement('li');
    try {
      test();
      row.className = 'pass';
      row.textContent = `PASS: ${name}`;
      return true;
    } catch (error) {
      row.className = 'fail';
      row.textContent = `FAIL: ${name} - ${error.message}`;
      console.error(name, error);
      return false;
    } finally {
      results.appendChild(row);
    }
  }

  const testResults = [];

  testResults.push(run('分组路径始终以页面为根，且容器从外到内排列', function () {
    fixtures.innerHTML =
      '<div class="el-dialog">' +
      '  <div class="el-tabs"><div class="el-tab-pane">' +
      '    <div class="el-collapse-item"><div class="el-collapse-item__header">详情</div><button id="target">保存</button></div>' +
      '  </div></div>' +
      '</div>';
    const path = ElementGrouper.getGroupPath(fixtures.querySelector('#target'));
    assert(path.map(item => item.type).join(',') === 'page,dialog,tab,collapse', `实际顺序为 ${path.map(item => item.type).join(',')}`);
    assert(path[0].key.indexOf(ElementGrouper.PAGE_GROUP_KEY + ':') === 0, '首层不是当前页面');
    assert(path.every(item => typeof item.propertiesName === 'string' && !Object.prototype.hasOwnProperty.call(item, 'name')), '分组未统一使用 propertiesName');
  }));

  testResults.push(run('分组树使用 propertiesName 保存显示名称', function () {
    const tree = ElementGrouper.buildTree([{
      group: [{ type: 'page', key: '__page__:test', propertiesName: '页面1' }]
    }]);
    assert(tree.length === 1, '未生成页面分组');
    assert(tree[0].propertiesName === '页面1', '分组名称未写入 propertiesName');
    assert(!Object.prototype.hasOwnProperty.call(tree[0], 'name'), '分组仍包含旧 name 字段');
  }));

  fixtures.innerHTML = '';
  const passedCount = testResults.filter(Boolean).length;
  const passed = passedCount === testResults.length;
  summary.className = passed ? 'pass' : 'fail';
  summary.textContent = `${passedCount}/${testResults.length} 通过`;
  document.title = passed ? 'PASS - ElementGrouper tests' : 'FAIL - ElementGrouper tests';
})();
