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

  test('class 使用完整 token 匹配', function () {
    mount('<button class="btn">目标</button><button class="btn-group">其他</button>');
    const result = assertSelector(fixtures.querySelector('.btn'));
    const classCandidate = result.candidates.find(item => item.strategy === 'class_token');
    assert(classCandidate, '未生成 class token 候选');
    assert(classCandidate.xpath.indexOf("concat(' ', normalize-space(@class), ' ')") !== -1, 'class 仍使用模糊子串匹配');
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
