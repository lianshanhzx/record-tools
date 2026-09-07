(function () {
  'use strict';

  const fixtures = document.getElementById('fixtures');
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  const tests = [];

  function test(name, run) {
    tests.push({ name: name, run: run });
  }

  function mount(html) {
    fixtures.innerHTML = html;
    return fixtures;
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || '断言失败');
  }

  function assertSelector(element, expectedStrategy) {
    const result = new SmartSelector(element).getSelectorResult();
    assert(result.verified, '选择器未通过验证');
    assert(result.xpath, '未生成 XPath');
    const matches = document.evaluate(
      result.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    assert(matches.snapshotLength === 1, `XPath 匹配 ${matches.snapshotLength} 个元素`);
    assert(matches.snapshotItem(0) === element, 'XPath 没有命中目标元素');
    if (expectedStrategy) assert(result.strategy === expectedStrategy, `实际策略为 ${result.strategy}`);
    return result;
  }

  test('优先选择测试契约属性', function () {
    mount('<button data-testid="save-button" name="save">保存</button>');
    const result = assertSelector(fixtures.querySelector('button'), 'test_attr:data-testid');
    assert(result.xpath === "//*[@data-testid='save-button']", '测试属性 XPath 不符合预期');
  });

  test('XPath literal 支持单双引号', function () {
    mount('<button id="quoted">保存</button>');
    const button = fixtures.querySelector('button');
    button.setAttribute('data-testid', 'say\' "hello"');
    assertSelector(button, 'test_attr:data-testid');
  });

  test('重复属性候选不会被误判为唯一', function () {
    mount('<input data-testid="field"><input data-testid="field" name="target">');
    const target = fixtures.querySelector('[name="target"]');
    const result = assertSelector(target, 'business_attr:name');
    assert(!result.candidates.some(item => item.xpath === "//*[@data-testid='field']"), '重复候选不应进入验证结果');
  });

  test('验证结果必须严格等于目标元素', function () {
    mount('<button id="first">一</button><button id="second">二</button>');
    const selector = new SmartSelector(fixtures.querySelector('#second'));
    const validation = selector.evaluateXPathForElement("//*[@id='first']", fixtures.querySelector('#second'));
    assert(validation.status === 'wrong_target', `实际状态为 ${validation.status}`);
  });

  test('Element UI 表单使用精确标签消歧', function () {
    mount(
      '<div class="el-form-item"><label class="el-form-item__label">联系人：</label><div><input></div></div>' +
      '<div class="el-form-item"><label class="el-form-item__label">联系人手机号码：</label><div><input></div></div>'
    );
    const result = assertSelector(fixtures.querySelectorAll('input')[1]);
    assert(result.strategy === 'element_ui_form_label', `实际策略为 ${result.strategy}`);
    assert(result.xpath.indexOf('联系人手机号码') !== -1, 'XPath 未使用完整标签');
    assert(result.xpath.indexOf('el-form-item') === -1, '常规结构不应输出冗长的 form-item class 谓词');
    assert(result.xpath.indexOf(' or ') === -1, '标签后缀不应展开为大量 or 分支');
  });

  test('证件类型表单生成紧凑 XPath', function () {
    mount('<div class="el-form-item"><label class="el-form-item__label">证件类型：</label><div><input type="text"></div></div>');
    const result = assertSelector(fixtures.querySelector('input'), 'element_ui_form_label');
    assert(result.xpath.indexOf("translate(., '：:*', '')") !== -1, '未使用紧凑标签规范化谓词');
    assert(result.xpath.indexOf('el-form-item') === -1, '不应包含 form-item class token');
    assert(result.xpath.indexOf("[@type='text']") === -1, '不应使用低价值 type=text 条件');
    assert(result.xpath.length < 140, `XPath 仍过长，共 ${result.xpath.length} 字符`);
  });

  test('稳定 name 优先于表单文案', function () {
    mount('<div class="el-form-item"><label class="el-form-item__label">客户名称</label><div><input name="customerName"></div></div>');
    const result = assertSelector(fixtures.querySelector('input'), 'business_attr:name');
    assert(result.xpath === "//input[@name='customerName']", '稳定业务属性应优先');
  });

  test('标签尾部星号可规范化', function () {
    mount('<div class="el-form-item"><label class="el-form-item__label">客户名称：*</label><div><input></div></div>');
    const result = assertSelector(fixtures.querySelector('input'));
    assert(result.strategy === 'element_ui_form_label', `实际策略为 ${result.strategy}`);
  });

  test('非直接子级 label 使用 form-item 回退', function () {
    mount('<div class="el-form-item"><div class="label-wrap"><label>客户等级：</label></div><div><input></div></div>');
    const result = assertSelector(fixtures.querySelector('input'), 'element_ui_form_label_fallback');
    assert(result.xpath.indexOf('el-form-item') !== -1, '特殊嵌套结构应保留 form-item 稳健回退');
  });

  test('class 使用完整 token 匹配', function () {
    mount('<button class="btn">目标</button><button class="btn-group">其他</button>');
    const result = assertSelector(fixtures.querySelector('.btn'));
    const classCandidate = result.candidates.find(item => item.strategy === 'class_token');
    assert(classCandidate, '未生成 class token 候选');
    assert(classCandidate.xpath.indexOf("concat(' ', normalize-space(@class), ' ')") !== -1, 'class 仍使用模糊子串匹配');
  });

  test('短按钮文字优先于普通业务属性', function () {
    mount('<button name="saveAction" title="保存当前数据" class="save-button">保存</button>');
    const result = assertSelector(fixtures.querySelector('button'), 'button_text');
    assert(result.xpath === "//button[normalize-space(.)='保存']", `按钮 XPath 不符合预期: ${result.xpath}`);
  });

  test('稳定 id 仍高于短按钮文字', function () {
    mount('<button id="save-button">保存</button>');
    const result = assertSelector(fixtures.querySelector('button'), 'stable_id');
    assert(result.xpath === "//*[@id='save-button']", '稳定 id 不应被按钮文本覆盖');
  });

  test('长按钮文字不压过稳定 name', function () {
    mount('<button name="submitApplication">提交当前客户的完整授信申请资料</button>');
    const result = assertSelector(fixtures.querySelector('button'), 'business_attr:name');
    assert(result.xpath === "//button[@name='submitApplication']", '长文本不应压过稳定业务属性');
  });

  test('重复短按钮文字不导出歧义文本 XPath', function () {
    mount('<div><button>保存</button></div><section><button>保存</button></section>');
    const result = assertSelector(fixtures.querySelectorAll('button')[1]);
    assert(result.strategy !== 'button_text', '重复按钮文本不应通过唯一性验证');
    assert(result.xpath !== "//button[normalize-space(.)='保存']", '不应导出重复按钮文本 XPath');
  });

  test('重复按钮文本使用 name + 文本组合消歧', function () {
    mount(
      '<button name="saveDraft">保存</button>' +
      '<button name="saveAction" title="保存当前数据">保存</button>'
    );
    const result = assertSelector(fixtures.querySelectorAll('button')[1], 'button_attr_text:name');
    assert(result.xpath === "//button[@name='saveAction'][normalize-space(.)='保存']", `组合 XPath 不符合预期: ${result.xpath}`);
    assert(result.xpath.length < 140, '组合 XPath 超过长度限制');
  });

  test('唯一短按钮仍使用最短文本 XPath', function () {
    mount('<button name="saveAction" title="保存当前数据">保存</button>');
    const result = assertSelector(fixtures.querySelector('button'), 'button_text');
    assert(result.xpath === "//button[normalize-space(.)='保存']", '唯一文本不应被更长组合 XPath 覆盖');
    assert(result.candidates.some(item => item.strategy === 'button_attr_text:name'), '应保留组合候选用于诊断和后续消歧');
  });

  test('过长按钮属性不生成组合 XPath', function () {
    const longName = 'saveAction_' + 'x'.repeat(80);
    mount(`<button name="${longName}">保存</button><button name="otherAction">保存</button>`);
    const target = fixtures.querySelectorAll('button')[0];
    const result = assertSelector(target);
    assert(!result.candidates.some(item => item.strategy === 'button_attr_text:name'), '过长属性不应参与组合');
    assert(result.xpath.length <= 140 || result.strategy === 'absolute_xpath', '不应导出过长组合 XPath');
  });

  test('无业务属性的重复按钮可使用 class + 文本组合', function () {
    mount('<button class="save-draft-button">保存</button><button class="save-final-button">保存</button>');
    const result = assertSelector(fixtures.querySelectorAll('button')[1], 'button_class_text');
    assert(result.xpath.indexOf('save-final-button') !== -1, '组合 XPath 未使用稳定 class');
    assert(result.xpath.indexOf("normalize-space(.)='保存'") !== -1, '组合 XPath 未使用按钮文本');
    assert(result.xpath.length < 140, 'class + 文本组合 XPath 超过长度限制');
  });

  test('菜单 li 优先使用自身中文文本', function () {
    mount(
      '<ul class="menu-wrapper">' +
      '<li data-url="/home" class="menu-item">工作台</li>' +
      '<li data-id="RES100000000" class="menu-item">任务事项</li>' +
      '<li data-id="RES000000001" class="menu-item">客户管理</li>' +
      '</ul>'
    );
    const target = fixtures.querySelectorAll('li')[1];
    const result = assertSelector(target, 'menu_item_text');
    assert(result.xpath === "//li[normalize-space(.)='任务事项']", `菜单 XPath 不符合预期: ${result.xpath}`);
    assert(result.xpath.indexOf('following-sibling') === -1, '菜单项不应依赖前一兄弟节点');
    assert(!result.candidates.some(item => item.strategy === 'previous_sibling_text'), '菜单项不应生成兄弟候选');
  });

  test('菜单顺序变化不影响文本 XPath', function () {
    mount(
      '<ul class="menu-wrapper">' +
      '<li class="menu-item">客户管理</li>' +
      '<li class="menu-item">工作台</li>' +
      '<li class="menu-item">任务事项</li>' +
      '</ul>'
    );
    const target = Array.from(fixtures.querySelectorAll('li')).find(item => item.textContent === '任务事项');
    const result = assertSelector(target, 'menu_item_text');
    assert(result.xpath === "//li[normalize-space(.)='任务事项']", '菜单排序后 XPath 不应变化');
  });

  test('重复菜单文本不导出歧义文本 XPath', function () {
    mount(
      '<ul class="menu-wrapper"><li class="menu-item">任务事项</li></ul>' +
      '<ul class="menu-wrapper"><li class="menu-item">任务事项</li></ul>'
    );
    const result = assertSelector(fixtures.querySelectorAll('li')[1]);
    assert(result.strategy !== 'menu_item_text', '重复菜单文本不应被误判为唯一');
    assert(result.xpath !== "//li[normalize-space(.)='任务事项']", '不应导出重复文本 XPath');
  });

  test('同名弹窗按钮使用标题容器消歧', function () {
    mount(
      '<div class="el-dialog"><div class="el-dialog__title">客户信息</div><button>确定</button></div>' +
      '<div class="el-dialog"><div class="el-dialog__title">合同信息</div><button>确定</button></div>'
    );
    const result = assertSelector(fixtures.querySelectorAll('button')[1]);
    assert(result.strategy.indexOf('scoped:container_title') === 0, `实际策略为 ${result.strategy}`);
    assert(result.xpath.indexOf('合同信息') !== -1, 'XPath 未使用所属弹窗标题');
  });

  test('Element UI wrapper 排除隐藏历史弹窗', function () {
    mount(
      '<div class="el-dialog__wrapper" style="display: none"><div class="el-dialog"><div class="el-dialog__title">合同信息</div><button>确定</button></div></div>' +
      '<div class="el-dialog__wrapper"><div class="el-dialog"><div class="el-dialog__title">合同信息</div><button>确定</button></div></div>'
    );
    const result = assertSelector(fixtures.querySelectorAll('button')[1]);
    assert(result.xpath.indexOf('display:none') !== -1, 'wrapper XPath 未排除隐藏实例');
  });

  test('表格重复按钮使用行文本消歧', function () {
    mount(
      '<table><tbody>' +
      '<tr><td>客户A001</td><td><button>编辑</button></td></tr>' +
      '<tr><td>客户B002</td><td><button>编辑</button></td></tr>' +
      '</tbody></table>'
    );
    const result = assertSelector(fixtures.querySelectorAll('button')[1]);
    assert(result.strategy === 'table_row_text', `实际策略为 ${result.strategy}`);
    assert(result.xpath.indexOf('客户B002') !== -1, 'XPath 未使用当前行文本');
  });

  test('表格优先使用编号列并限定表格范围', function () {
    mount(
      '<table data-testid="customer-table"><thead><tr><th>客户编号</th><th>客户名称</th><th>操作</th></tr></thead>' +
      '<tbody><tr><td>C001</td><td>客户甲</td><td><button>编辑</button></td></tr>' +
      '<tr><td>C002</td><td>客户乙</td><td><button>编辑</button></td></tr></tbody></table>'
    );
    const target = fixtures.querySelectorAll('button')[1];
    const result = assertSelector(target, 'table_scoped_row_number');
    assert(result.xpath.indexOf("@data-testid='customer-table'") !== -1, '未限定到目标表格');
    assert(result.xpath.indexOf("客户编号") === -1, '行定位不应把表头写入行谓词');
    assert(result.xpath.indexOf("C002") !== -1, '未使用当前行编号');
  });

  test('表格没有编号时使用名称列', function () {
    mount(
      '<table><thead><tr><th>客户名称</th><th>状态</th><th>操作</th></tr></thead>' +
      '<tbody><tr><td>客户甲</td><td>正常</td><td><button>查看</button></td></tr>' +
      '<tr><td>客户乙</td><td>正常</td><td><button>查看</button></td></tr></tbody></table>'
    );
    const target = fixtures.querySelectorAll('button')[1];
    const result = assertSelector(target, 'table_scoped_row_name');
    assert(result.xpath.indexOf('客户乙') !== -1, '未使用当前行名称');
  });

  test('表格编号和名称不唯一时追加其他列', function () {
    mount(
      '<table><thead><tr><th>编号</th><th>名称</th><th>类型</th><th>操作</th></tr></thead>' +
      '<tbody><tr><td>A01</td><td>合同</td><td>采购</td><td><button>编辑</button></td></tr>' +
      '<tr><td>A01</td><td>合同</td><td>销售</td><td><button>编辑</button></td></tr></tbody></table>'
    );
    const target = fixtures.querySelectorAll('button')[1];
    const result = assertSelector(target, 'table_scoped_row_composite');
    assert(result.xpath.indexOf('A01') !== -1, '组合定位缺少编号');
    assert(result.xpath.indexOf('合同') !== -1, '组合定位缺少名称');
    assert(result.xpath.indexOf('销售') !== -1, '组合定位未追加其他列');
  });

  test('表格行顺序变化后仍按业务列定位', function () {
    mount(
      '<table><thead><tr><th>编号</th><th>名称</th><th>操作</th></tr></thead>' +
      '<tbody><tr><td>A01</td><td>甲</td><td><button>编辑</button></td></tr>' +
      '<tr><td>B02</td><td>乙</td><td><button>编辑</button></td></tr></tbody></table>'
    );
    const target = fixtures.querySelectorAll('button')[1];
    const first = assertSelector(target, 'table_scoped_row_number');
    const oldXpath = first.xpath;
    fixtures.querySelector('tbody').innerHTML =
      '<tr><td>B02</td><td>乙</td><td><button>编辑</button></td></tr>' +
      '<tr><td>A01</td><td>甲</td><td><button>编辑</button></td></tr>';
    const newTarget = fixtures.querySelectorAll('button')[0];
    const matches = document.evaluate(oldXpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    assert(matches.snapshotLength === 1 && matches.snapshotItem(0) === newTarget, '行顺序变化后未命中业务行');
  });

  test('业务 ID 中的长数字不会被直接误杀', function () {
    mount('<input id="customer123456" placeholder="名称">');
    const result = assertSelector(fixtures.querySelector('input'), 'stable_id');
    assert(result.xpath === "//*[@id='customer123456']", '未选择稳定业务 ID');
  });

  test('属性值保留真实空白', function () {
    mount('<input>');
    const input = fixtures.querySelector('input');
    input.setAttribute('data-testid', 'customer  field');
    const result = assertSelector(input, 'test_attr:data-testid');
    assert(result.xpath.indexOf('customer  field') !== -1, '属性空白不应被规范化后写入 XPath');
  });

  test('同一实例在 DOM 变化后重新验证', function () {
    mount('<input data-testid="changing">');
    const input = fixtures.querySelector('input');
    const selector = new SmartSelector(input);
    assert(selector.getSelectorResult().strategy === 'test_attr:data-testid', '初次未选择测试属性');
    fixtures.insertAdjacentHTML('beforeend', '<input data-testid="changing">');
    const result = selector.getSelectorResult();
    assert(result.strategy !== 'test_attr:data-testid', '重复调用使用了过期的唯一性缓存');
    assert(result.verified, 'DOM 变化后应重新选择有效候选');
  });

  test('无语义属性时提供经过验证的绝对 XPath 兜底', function () {
    mount('<section><div><span></span><span id="target"></span></div></section>');
    const target = fixtures.querySelector('#target');
    target.removeAttribute('id');
    const result = assertSelector(target);
    const absolute = result.candidates.find(item => item.strategy === 'absolute_xpath');
    assert(absolute && absolute.verified, '缺少经过验证的绝对 XPath 兜底');
  });

  test('Shadow DOM 目标不会伪装成普通 XPath 成功', function () {
    mount('<div id="host"></div>');
    const shadowRoot = fixtures.querySelector('#host').attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<button>保存</button>';
    const result = new SmartSelector(shadowRoot.querySelector('button')).getSelectorResult();
    assert(!result.verified && result.strategy === 'unsupported', 'Shadow DOM 应明确标记为不支持');
  });

  test('诊断辅助方法不误报 ShadowRoot XPath 支持', function () {
    mount('<div id="shadow-host"></div>');
    const shadowRoot = fixtures.querySelector('#shadow-host').attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<button data-shadow-test="yes">保存</button>';
    const matches = getElementsByXPathWithShadow("//*[@data-shadow-test='yes']");
    assert(matches.length === 0, '普通 XPath 不应被误报为可穿透 ShadowRoot');
  });

  let passed = 0;
  tests.forEach(item => {
    const row = document.createElement('li');
    try {
      item.run();
      passed++;
      row.className = 'pass';
      row.textContent = `PASS: ${item.name}`;
    } catch (error) {
      row.className = 'fail';
      row.textContent = `FAIL: ${item.name} - ${error.message}`;
      console.error(item.name, error);
    }
    results.appendChild(row);
  });
  fixtures.innerHTML = '';
  summary.className = passed === tests.length ? 'pass' : 'fail';
  summary.textContent = `${passed}/${tests.length} 通过`;
  document.title = passed === tests.length ? 'PASS - SmartSelector tests' : 'FAIL - SmartSelector tests';
})();
