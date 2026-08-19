/**
 * 智能选择器 (XPath 版本)
 *
 * 设计目标：
 *   为目标元素生成多条候选 XPath，每条候选都必须通过"唯一且严格命中目标元素"的
 *   硬门槛验证，然后按稳定性评分选择最优项，而不是"首个唯一即返回"。
 *
 * 对外契约（兼容旧调用方）：
 *   - getSelector(): string        返回一条 XPath（主选择器）
 *   - getSelectorResult(): object  结构化结果（策略 / 分数 / 候选集 / 警告），
 *                                  第一轮未写回录制数据，仅用于诊断。
 *   - getCandidates(): array       已通过验证并按评分排序的候选集
 *
 * 数据协议注意事项：
 *   当前 target / anchorTarget / Popup 去重逻辑都依赖单条 XPath 字符串，
 *   因此修改候选内部结构时不应改变 getSelector() 的返回形式。
 */

// 选择器实现版本号：算法行为变化时递增，便于排查历史数据与算法差异。
const SMART_SELECTOR_VERSION = 2;
// 单次生成的候选上限。评分筛选只保留最优的一部分，防止结构路径候选挤占有效候选。
const SMART_SELECTOR_MAX_CANDIDATES = 40;
// 结构路径候选向上搜索的最大祖先深度，限制生成量并避免路径过长。
const SMART_SELECTOR_MAX_DEPTH = 10;
// 多特性组合仅用于消歧；超过该长度时可读性和维护性明显下降，直接放弃。
const SMART_SELECTOR_MAX_COMBINED_XPATH_LENGTH = 140;

/**
 * 生成 XPath 1.0 安全的字符串字面量。
 * XPath 1.0 没有转义机制：字符串内含单引号时改用双引号包裹，两种引号都存在时
 * 用 concat() 拼接多个单引号字面量。这是 XPath 1.0 的标准做法。
 */
function quoteXPathValue(value) {
  const s = String(value);
  if (s.indexOf("'") === -1) return `'${s}'`;
  if (s.indexOf('"') === -1) return `"${s}"`;
  const parts = s.split("'").map(part => `'${part}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

/**
 * 文本规范化：压缩连续空白并裁剪长度。
 * 注意：仅用于评分/判空等 JS 侧比较；写入 XPath 的属性值必须保留真实值，
 * 因为 XPath 的等值比较不会做同样的空白归一化。
 */
function normalizeSelectorText(value, maxLength = 60) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * 表单标签规范化：在 normalizeSelectorText 基础上剥离尾部的中文/英文冒号和必填星号，
 * 用于与 .el-form-item 内的 label 文本做精确匹配。
 */
function normalizeFormLabel(value) {
  return normalizeSelectorText(value, 40).replace(/[：:*]+\s*$/, '').trim();
}

/**
 * class token 精确匹配谓词。
 * 不使用 contains(@class, 'x')，因为那会误匹配 btn-group、icon-btn 等子串。
 * 标准写法：把 class 属性首尾各补一个空格后，用子串查找 " token "。
 */
function classTokenPredicate(className) {
  return `contains(concat(' ', normalize-space(@class), ' '), ${quoteXPathValue(` ${className} `)})`;
}

/**
 * 判断一个 class 是否"稳定"，即是否值得作为定位依据。
 * 过滤原则：框架动态生成 / 状态类 / 通用布局类 / 纯数字 / 随机后缀，均不稳定。
 * 业务页面自定义的语义类（如 customer-search-button）应当保留。
 */
function isStableClassName(className) {
  if (!className || className.length < 2) return false;
  if (/^data-v-/.test(className)) return false;         // Vue scoped
  if (/^(is-|has-|active$|disabled$|selected$|focus$|hover$)/i.test(className)) return false; // 状态类
  if (/[_-]{2}[a-z0-9]{4,}$/i.test(className)) return false; // 随机后缀
  if (/^\d+$/.test(className)) return false;            // 纯数字

  // 常见 Element UI 通用实现类：出现次数过多、无定位价值，即使唯一也不应优先使用。
  const ignoredClasses = [
    'el-row', 'el-col', 'el-scrollbar', 'el-container', 'el-header', 'el-main',
    'el-footer', 'el-aside', 'el-input', 'el-input__inner', 'el-button',
    'el-form-item', 'el-form-item__content', 'el-form-item__label',
    'el-dialog__body', 'el-dialog__footer', 'el-tabs__content', 'el-tab-pane'
  ];
  if (ignoredClasses.includes(className)) return false;
  if (/^el-col-\d+$/.test(className)) return false;     // 栅格类 el-col-12 等
  if (/^el-icon-/.test(className)) return false;        // 图标类（作为装饰无定位价值）
  return true;
}

/**
 * 属性/ID 值的"动态程度"扣分。返回 0 表示无动态特征，越大越不可靠。
 * 设计取舍：
 *   - 不采用旧版 isDynamicValue 的绝对"是/否"判断（含 6 位数字即整体排除），
 *     那样会误杀 customer202401 这类合法业务编号；
 *   - 改为扣分制：高扣分项（el-id-*、UUID、13 位毫秒时间戳）最终会被评分淘汰，
 *     而稳定业务编号最多小幅扣分。
 * 各分支正则含义：
 *   - el-id-* / el-collapse-content-*：Element UI 自动生成的 DOM id
 *   - 标准 UUID 形态
 *   - 13 位数字：常见毫秒时间戳
 *   - 16 位以上字母+数字混合：大概率是随机 hash 或会话 token
 *   - 下划线/连字符+8 位以上字母数字结尾：常见框架随机后缀
 */
function dynamicValuePenalty(value) {
  const text = String(value || '');
  let penalty = 0;
  if (!text) return 100;
  if (/^el-id-/i.test(text) || /^el-collapse-content-\d+$/i.test(text)) penalty += 90;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) penalty += 90;
  if (/\b1\d{12}\b/.test(text)) penalty += 80;
  if (/[a-z0-9]{16,}$/i.test(text) && /[a-z]/i.test(text) && /\d/.test(text)) penalty += 55;
  if (/[_-][a-z0-9]{8,}$/i.test(text)) penalty += 35;
  return penalty;
}

/**
 * 判断按钮/链接文本是否带有动态状态特征（加载中、数量、角标等）。
 * 这类文本会随业务状态变化，命中后选择器稳定性差，应扣分。
 */
function isDynamicText(value) {
  const text = normalizeSelectorText(value);
  return /(?:加载中|处理中|请稍候|已选择\s*\d+|\(\d+\)|（\d+）|\[\d+\])/.test(text);
}

class SmartSelector {
  constructor(element) {
    this.element = element;
    // 统一从元素自身文档取 evaluator，避免主文档 evaluate 去查别的文档的边界问题。
    this.document = element && element.ownerDocument ? element.ownerDocument : document;
    // 属性可信度分级：test 契约属性 > 稳定业务属性 > 通用/可能动态的属性。
    this.testAttributes = ['data-testid', 'data-cy', 'data-test', 'data-qa'];
    this.businessAttributes = ['name', 'data-field', 'aria-label', 'title', 'alt'];
    this.secondaryAttributes = ['placeholder', 'aria-labelledby', 'data-track', 'href', 'role', 'type', 'for'];
    this.candidateMap = new Map();      // xpath -> 候选对象（同一次生成周期内的去重）
    this.evaluationCache = new Map();   // xpath -> 验证结果（同一次生成周期内的缓存）
  }

  /** 主入口：返回一条可验证且稳定分数最高的 XPath；找不到时返回空字符串。 */
  getSelector() {
    return this.getSelectorResult().xpath;
  }

  /**
   * 结构化入口。每次调用都清空内部状态并重新基于当前 DOM 生成/验证，
   * 避免复用旧实例时把上一次的唯一性结论带进新页面状态（如插入同名元素后缓存过期）。
   */
  getSelectorResult() {
    // 明确不支持普通 XPath 表达的场景：iframe/shadow DOM 内目标。
    // 此时返回 unsupported 而不是继续生成可能命中错误的字符串。
    if (!this.isSupportedTarget()) {
      return {
        xpath: '', strategy: 'unsupported', score: 0, verified: false,
        candidates: [], warnings: ['目标不在当前文档的普通 DOM 中'], version: SMART_SELECTOR_VERSION
      };
    }

    // 一个生成周期内：收集 -> 逐一严格验证 -> 只保留 verified -> 评分排序。
    this.candidateMap.clear();
    this.evaluationCache.clear();
    this.collectCandidates();
    const candidates = Array.from(this.candidateMap.values())
      .map(candidate => Object.assign(candidate, this.evaluateCandidate(candidate.xpath)))
      .filter(candidate => candidate.verified)
      .sort((a, b) => this.compareCandidates(a, b))
      .slice(0, SMART_SELECTOR_MAX_CANDIDATES);
    const best = candidates[0];

    return {
      xpath: best ? best.xpath : '',
      strategy: best ? best.strategy : 'not_found',
      score: best ? best.score : 0,
      verified: !!best,
      candidates: candidates,
      warnings: best ? best.warnings.slice() : ['未生成可验证的 XPath'],
      version: SMART_SELECTOR_VERSION
    };
  }

  /** 返回已通过验证、按评分降序排列的候选列表（仅诊断用）。 */
  getCandidates() {
    return this.getSelectorResult().candidates;
  }

  /**
   * 目标是否可被普通 XPath 表达：
   *   必须是文档中的普通元素；getRootNode 必须是该元素自身文档（排除 Shadow DOM 内部元素）；
   *   必须位于当前页面文档（排除同源 iframe 目标 —— 现有执行端没有 frame chain 协议）。
   */
  isSupportedTarget() {
    if (!this.element || this.element.nodeType !== Node.ELEMENT_NODE || !this.element.isConnected) return false;
    if (this.element.getRootNode() !== this.document) return false;
    if (typeof document !== 'undefined' && this.document !== document) return false;
    return true;
  }

  /**
   * 候选来源总入口。各来源各自负责生成"语义候选"或"结构候选"，
   * 最终统一进入 addCandidate 去重，评分阶段再按稳定性择优。
   * 顺序只影响生成先后，不代表最终优先级（评分决定）。
   */
  collectCandidates() {
    this.collectDirectAttributeCandidates();   // 目标自身属性/ID
    this.collectLabelCandidates();             // label[for] / 包裹 label / Element UI form-item
    this.collectTextCandidates();              // 按钮/链接/菜单等精确文本
    this.collectTableRowCandidates();          // 表格行内重复按钮消歧
    this.collectSiblingCandidates();           // 前置 label/文本兄弟
    this.collectScopedCandidates();            // 弹窗/页签/折叠等容器作用域
    this.collectClassCandidates();             // class token
    this.collectRelativePathCandidates();      // 短结构路径
    this.addAbsoluteXPathCandidate();          // 完整层级兜底
  }

  /**
   * 注册一条候选。以 XPath 为 key 去重（同一次生成周期内，同 XPath 保留更高分）。
   * 此处只登记候选，唯一性/命中目标的验证统一在 getSelectorResult 阶段执行，
   * 因此生成阶段不需要（也不应该）对候选做二次 evaluate。
   */
  addCandidate(xpath, strategy, score, options = {}) {
    if (!xpath) return;
    const existing = this.candidateMap.get(xpath);
    const candidate = {
      xpath: xpath,
      strategy: strategy,
      score: score,
      scope: options.scope || 'document',
      usesIndex: !!options.usesIndex,
      depth: options.depth || 0,
      warnings: options.warnings ? options.warnings.slice() : []
    };
    if (!existing || candidate.score > existing.score) this.candidateMap.set(xpath, candidate);
  }

  /**
   * 目标自身属性候选。可信度排序：
   *   test 契约属性 > 稳定 id > 稳定业务属性 > 通用/可能动态属性。
   * 注意：这里的 baseScore 是"相对优劣"的粗分，最终还会叠加 dynamicValuePenalty 扣分
   * 以及作用域/结构路径的加分减分，分值大小本身没有绝对含义。
   */
  collectDirectAttributeCandidates() {
    const tagName = this.element.tagName.toLowerCase();

    // 1. 测试契约属性（data-testid 等）：跨重渲染最稳定，最高分。
    for (const attr of this.testAttributes) {
      this.addAttributeCandidate(this.element, attr, 100, `test_attr:${attr}`, false);
    }

    // 2. 稳定 id：业务上通常唯一，但需过滤框架自动生成的动态 id。
    if (this.element.id) {
      const penalty = dynamicValuePenalty(this.element.id);
      if (penalty < 80) {
        this.addCandidate(`//*[@id=${quoteXPathValue(this.element.id)}]`, 'stable_id', 96 - penalty, {
          warnings: penalty ? ['ID 具有动态值特征'] : []
        });
      }
    }

    // 3. 稳定业务属性：name/data-field 是表单回填的重要契约，aria-label 次之。
    for (const attr of this.businessAttributes) {
      const baseScore = attr === 'name' || attr === 'data-field' ? 92 : 88;
      this.addAttributeCandidate(this.element, attr, baseScore, `business_attr:${attr}`, true);
    }

    // 4. 通用/可能动态的属性：单独出现时定位价值有限，仅作低分候选。
    for (const attr of this.secondaryAttributes) {
      if (attr === 'href' && tagName !== 'a') continue;   // href 只对 <a> 有意义
      if (attr === 'for' && tagName !== 'label') continue; // for 只对 <label> 有意义
      // Element UI Select 内部的 input placeholder 随选中值变化，跳过避免误定位。
      if (attr === 'placeholder' && this.element.closest('.el-select')) continue;
      const scores = { placeholder: 76, 'aria-labelledby': 78, 'data-track': 68, href: 60, role: 48, type: 38, for: 55 };
      this.addAttributeCandidate(this.element, attr, scores[attr] || 50, `secondary_attr:${attr}`, true);
    }
  }

  /**
   * 生成单条"属性等于值"的候选。
   * 关键细节：写入 XPath 的是元素的真实属性值（value），而不是规范化后的文本；
   * 因为 XPath 的 @attr= 做的是精确等值比较。规范化文本只用于长度/判空判断。
   */
  addAttributeCandidate(element, attr, baseScore, strategy, includeTag) {
    if (!element.hasAttribute(attr)) return;
    const value = element.getAttribute(attr);
    const normalizedValue = normalizeSelectorText(value, 200);
    if (!normalizedValue || value.length > 200) return; // 空值或超长值无定位价值
    if ((attr === 'placeholder' || attr === 'title' || attr === 'aria-label') && value.length > 60) return;
    const penalty = dynamicValuePenalty(value);
    // 高动态扣分（如 UUID/时间戳）直接放弃该候选，避免评分阶段误选。
    if (penalty >= 80 && attr !== 'data-track') return;
    const tagName = includeTag ? element.tagName.toLowerCase() : '*';
    const warnings = [];
    if (penalty) warnings.push(`${attr} 具有动态值特征`);
    if (attr === 'href' && /[?#]/.test(value)) warnings.push('href 包含查询参数或片段');
    this.addCandidate(`//${tagName}[@${attr}=${quoteXPathValue(value)}]`, strategy, baseScore - penalty, { warnings: warnings });
  }

  /**
   * 语义化 label 候选。这是 Element UI 表单场景最重要的消歧来源：
   *   - label[for="id"]：标准 ARIA 关联
   *   - 包裹型 <label>
   *   - Element UI .el-form-item 内的 .el-form-item__label
   * label 匹配一律使用"精确文本 + 常见后缀变体"，避免"联系人"误匹配"联系人手机号码"。
   */
  collectLabelCandidates() {
    const labels = [];
    // 1. label[for] 关联（通过元素 id 反查）。
    if (this.element.id) {
      try {
        this.document.querySelectorAll(`label[for=${this.cssQuote(this.element.id)}]`).forEach(label => labels.push(label));
      } catch (e) {} // 特殊字符导致 CSS 选择器无效时静默跳过
    }
    // 2. 直接包裹元素的 <label>。
    const wrappingLabel = this.element.closest('label');
    if (wrappingLabel) labels.push(wrappingLabel);

    labels.forEach(label => {
      const text = normalizeFormLabel(label.innerText || label.textContent);
      if (!text) return;
      const labelXPath = this.exactLabelXPath(text);
      const tagName = this.element.tagName.toLowerCase();
      if (label.getAttribute('for') && label.getAttribute('for') === this.element.id) {
        // 有 for 关联时用 following 轴精确定位带 id 的目标，避免后代中误选同类控件。
        this.addCandidate(`${labelXPath}/following::${tagName}[@id=${quoteXPathValue(this.element.id)}][1]`, 'label_for', 94);
      } else {
        // 包裹型 label 直接用后代轴。
        this.addCandidate(`${labelXPath}//${tagName}`, 'wrapping_label', 91);
      }
    });

    // 3. Element UI .el-form-item：label 在表单项头部，控件在 content 区。
    const formItem = this.element.closest('.el-form-item');
    if (!formItem) return;
    const label = formItem.querySelector('.el-form-item__label, label');
    const text = normalizeFormLabel(label && (label.innerText || label.textContent));
    if (!text) return;

    const labelPredicate = this.formLabelPredicate(text);
    const formItemTag = formItem.tagName.toLowerCase();
    // 常规 Element UI DOM 中 label 是 form-item 的直接子节点。优先使用标签父节点作为
    // 作用域，可省去冗长的 el-form-item class token 谓词；严格验证失败时再使用稳健回退。
    const compactPrefix = `//label[${labelPredicate}]/parent::*`;
    const fallbackPrefix = `//${formItemTag}[${classTokenPredicate('el-form-item')}][.//label[${labelPredicate}]]`;
    for (const leaf of this.getFormLeafCandidates()) {
      this.addCandidate(`${compactPrefix}//${leaf.xpath}`, 'element_ui_form_label', leaf.score + 1, { scope: 'form_item' });
      this.addCandidate(`${fallbackPrefix}//${leaf.xpath}`, 'element_ui_form_label_fallback', leaf.score, { scope: 'form_item' });
    }
  }

  /** 单条精确 label XPath（比较前移除常见标签装饰符）。 */
  exactLabelXPath(text) {
    return `//label[${this.formLabelPredicate(text)}]`;
  }

  /**
   * 紧凑的 label 精确文本谓词。
   * translate() 先移除中英文冒号和必填星号，外层 normalize-space() 再清理遗留空白，
   * 因而一条表达式即可覆盖“名称”“名称：”“名称： *”“名称*：”等常见写法。
   * 最终仍是等值比较，不会把“联系人”误匹配为“联系人手机号码”。
   */
  formLabelPredicate(text) {
    return `normalize-space(translate(., '：:*', ''))=${quoteXPathValue(text)}`;
  }

  /**
   * form-item 内的目标控件叶子候选。
   * 优先使用 name/placeholder/aria-label 等有业务区分度的属性，最后回退到裸标签。
   * type="text" 在表单中几乎处处相同，不具备消歧价值，因此不再让它压过更短的裸 input；
   * radio/checkbox/date 等非 text 类型仅作为低分补充，在裸标签不唯一时才可能胜出。
   */
  getFormLeafCandidates() {
    const tagName = this.element.tagName.toLowerCase();
    const leaves = [];
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'button') {
      let leaf = tagName;
      const attributeScores = { name: 91, placeholder: 90, 'aria-label': 91 };
      for (const attr of Object.keys(attributeScores)) {
        const value = normalizeSelectorText(this.element.getAttribute(attr), 60);
        if (value && dynamicValuePenalty(value) < 80) {
          // 注意：此处写入 XPath 的是真实属性值，不是规范化后的 value。
          leaves.push({ xpath: `${tagName}[@${attr}=${quoteXPathValue(this.element.getAttribute(attr))}]`, score: attributeScores[attr] });
        }
      }
      leaves.push({ xpath: leaf, score: 89 });
      const type = this.element.getAttribute('type');
      if (type && type !== 'text' && dynamicValuePenalty(type) < 80) {
        leaves.push({ xpath: `${tagName}[@type=${quoteXPathValue(type)}]`, score: 88 });
      }
    } else {
      leaves.push({ xpath: this.getSemanticLeaf(this.element), score: 89 });
    }
    // 按 xpath 去重（保留首条）。
    return Array.from(new Map(leaves.map(item => [item.xpath, item])).values());
  }

  /**
   * 按钮/链接/菜单项等交互元素的精确文本候选。
   * 仅针对可交互元素，避免任意短文本容器（span/div）被文本定位，
   * 从而把点击按钮内部 span 的录制误定位到 span 本身。
   */
  collectTextCandidates() {
    const tagName = this.element.tagName.toLowerCase();
    const role = this.element.getAttribute('role');
    const isMenuItem = this.isMenuItemElement(this.element);
    const isButtonLike = tagName === 'button' || role === 'button';
    if (!['button', 'a', 'option', 'label'].includes(tagName) &&
        !['button', 'menuitem', 'tab'].includes(role) && !isMenuItem) return;
    const text = normalizeSelectorText(this.element.innerText || this.element.textContent, 40);
    if (!text) return;
    const penalty = isDynamicText(text) ? 30 : 0;
    const isShortButtonText = isButtonLike && text.length <= 12;
    // 短按钮文字（保存、提交、下一步等）通常是跨 DOM 重构更稳定的业务语义，
    // 分数高于 name/title/class，但仍低于 test 属性和稳定 id。
    const strategy = isMenuItem ? 'menu_item_text' : (isShortButtonText ? 'button_text' : 'exact_text');
    const score = isMenuItem ? 90 : (isShortButtonText ? 94 : 84);
    this.addCandidate(`//${tagName}[normalize-space(.)=${quoteXPathValue(text)}]`, strategy, score - penalty, {
      warnings: penalty ? ['文本具有动态状态特征'] : []
    });
    if (isShortButtonText && penalty === 0) {
      this.collectButtonCombinationCandidates(text);
    }
    if (role) {
      // role + 可访问名称组合比纯文本更精确（文本可能重复，role 进一步收窄）。
      const roleScore = isShortButtonText ? 95 : 88;
      this.addCandidate(`//*[@role=${quoteXPathValue(role)}][normalize-space(.)=${quoteXPathValue(text)}]`, 'role_and_text', roleScore - penalty, {
        warnings: penalty ? ['文本具有动态状态特征'] : []
      });
    }
  }

  /**
   * 为短文本按钮生成受限的“一个稳定特性 + 文本”组合候选。
   * 组合分数略低于唯一短文本（94），因此文本本身唯一时仍优先输出最短 XPath；
   * 文本重复时，组合候选可通过 name/aria-label/title/class 消歧并胜过单一普通属性。
   *
   * 为控制长度和抗变化能力：
   *   - 不组合 data-testid/id：它们单独使用已经更稳定且更短；
   *   - 不组合 type：type="button" 区分度低；
   *   - 每条 XPath 只增加一个属性或一个 class，不生成三特性排列组合；
   *   - 属性值最多 40 字符，完整 XPath 最多 140 字符。
   */
  collectButtonCombinationCandidates(text) {
    const tagName = this.element.tagName.toLowerCase();
    const textPredicate = `[normalize-space(.)=${quoteXPathValue(text)}]`;
    const attributes = [
      { name: 'name', score: 93 },
      { name: 'data-field', score: 93 },
      { name: 'aria-label', score: 92 },
      { name: 'title', score: 89 }
    ];

    for (const attr of attributes) {
      const value = this.element.getAttribute(attr.name);
      if (!normalizeSelectorText(value, 40) || value.length > 40 || dynamicValuePenalty(value) >= 80) continue;
      const xpath = `//${tagName}[@${attr.name}=${quoteXPathValue(value)}]${textPredicate}`;
      if (xpath.length <= SMART_SELECTOR_MAX_COMBINED_XPATH_LENGTH) {
        this.addCandidate(xpath, `button_attr_text:${attr.name}`, attr.score);
      }
    }

    // class 只取第一个稳定 token，作为无稳定业务属性时的低优先级组合回退。
    const stableClass = Array.from(this.element.classList || []).find(isStableClassName);
    if (stableClass) {
      const xpath = `//${tagName}[${classTokenPredicate(stableClass)}]${textPredicate}`;
      if (xpath.length <= SMART_SELECTOR_MAX_COMBINED_XPATH_LENGTH) {
        this.addCandidate(xpath, 'button_class_text', 80);
      }
    }
  }

  /**
   * 判断元素是否为叶子菜单项。
   * 仅凭 <li> 标签不足以判定菜单语义，因此要求至少满足一种明确特征：
   *   role="menuitem"、常见菜单项 class、data-url/data-id，或位于明确的菜单容器中。
   * 含子级 <li> 的节点通常是菜单分组，不使用聚合文本直接定位。
   */
  isMenuItemElement(element) {
    if (!element || element.tagName.toLowerCase() !== 'li') return false;
    if (element.querySelector('li')) return false;
    if (element.getAttribute('role') === 'menuitem') return true;
    if (element.hasAttribute('data-url') || element.hasAttribute('data-id')) return true;

    const classNames = Array.from(element.classList || []);
    if (classNames.some(className => [
      'menu-item', 'el-menu-item', 'ant-menu-item', 'ivu-menu-item', 'nav-item'
    ].includes(className))) return true;

    return !!element.closest(
      'ul.menu-wrapper, ul.el-menu, [role="menu"], nav, .sidebar-menu, .nav-menu'
    );
  }

  /**
   * 表格行内"重复操作按钮"的消歧候选。
   * 典型场景：每行都有"查看/编辑/删除"，按钮文本全局重复，需要借助行内业务文本
   * （如客户编号）作为锚点：//tr[包含"客户A001"]//button[文本="编辑"]。
   * 仅当目标位于 <tr> 内才生成；行锚点文本要求短、稳定、非纯数字/日期/动态状态。
   */
  collectTableRowCandidates() {
    const row = this.element.closest('tr');
    if (!row) return;
    const leaf = this.getSemanticLeaf(this.element);
    const ownText = normalizeSelectorText(this.element.innerText || this.element.textContent, 40);
    const cells = Array.from(row.querySelectorAll('th, td'));
    const anchors = [];
    for (const cell of cells) {
      const text = normalizeSelectorText(cell.innerText || cell.textContent, 40);
      // 过滤：空文本、按钮自身文本、超长文本、动态状态文本、纯数字、日期。
      if (!text || text === ownText || text.length > 30 || isDynamicText(text)) continue;
      if (/^\d+$/.test(text) || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)) continue;
      anchors.push(text);
      if (anchors.length >= 3) break; // 最多取 3 个行锚点，控制候选数量
    }
    anchors.forEach(text => {
      this.addCandidate(`//tr[.//*[normalize-space(.)=${quoteXPathValue(text)}]]//${leaf}`, 'table_row_text', 79, { scope: 'table_row' });
    });
  }

  /**
   * 前置兄弟关系候选：//label[文本]/following-sibling::input[position]。
   * 原实现把"遍历过的兄弟数量"当 XPath 位置号，语义错误；
   * 这里改为统计"目标标签在 sibling 与 target 之间出现的次数"，与 XPath 的
   * following-sibling::tag[n] 一致（n 表示该标签中的第几个）。
   */
  collectSiblingCandidates() {
    // 菜单项是有独立业务名称的集合元素，使用前一项 + following-sibling 会随菜单增删/排序漂移。
    if (this.isMenuItemElement(this.element)) return;
    const targetTag = this.element.tagName.toLowerCase();
    let sibling = this.element.previousElementSibling;
    let inspected = 0;
    while (sibling && inspected < 3) {
      inspected++;
      const text = normalizeFormLabel(sibling.innerText || sibling.textContent);
      if (text && text.length <= 30) {
        const siblingTag = sibling.tagName.toLowerCase();
        // 统计从 sibling 之后到 target 之间、与 target 同标签的节点数。
        const children = Array.from(sibling.parentElement.children);
        const matchingBeforeTarget = children
          .slice(children.indexOf(sibling) + 1, children.indexOf(this.element) + 1)
          .filter(node => node.tagName === this.element.tagName).length;
        if (matchingBeforeTarget > 0) {
          this.addCandidate(
            `//${siblingTag}[normalize-space(.)=${quoteXPathValue(text)}]/following-sibling::${targetTag}[${matchingBeforeTarget}]`,
            'previous_sibling_text', 72, { usesIndex: matchingBeforeTarget > 1 }
          );
        }
      }
      sibling = sibling.previousElementSibling;
    }
  }

  /**
   * 容器作用域候选：弹窗/抽屉/消息框/页签/折叠面板等。
   * 思路：先为目标所在容器生成"容器锚点 XPath"，再拼接目标叶子 XPath，
   * 从而在多个容器中存在同名字段/按钮时仍能唯一定位。
   * 关键约束：容器锚点必须先验证严格命中该容器，未通过则不生成组合候选。
   */
  collectScopedCandidates() {
    // 选择器顺序即优先级；wrapper 在前是因为真实 Element UI 页面中
    // .el-dialog__wrapper 包裹 .el-dialog，取最近容器优先从 wrapper 开始。
    const selectors = [
      '.el-dialog__wrapper', '.el-drawer__wrapper', '.el-dialog', '.el-drawer', '[role="dialog"]',
      '.el-message-box', '.modal', '.dialog', '.drawer',
      '.el-popover', '.el-tab-pane', '.tab-pane', '.el-collapse-item', '.collapse-panel', '.collapse-item'
    ];
    const seen = new Set(); // 同一容器只处理一次（多个选择器可能命中同一个节点）
    for (const selector of selectors) {
      let container = null;
      try { container = this.element.closest(selector); } catch (e) {} // 非法选择器跳过
      if (!container || seen.has(container)) continue;
      seen.add(container);
      const anchors = this.getContainerAnchorCandidates(container);
      const leaves = this.getScopedLeafCandidates();
      anchors.forEach(anchor => {
        const validation = this.evaluateXPathForElement(anchor.xpath, container);
        if (!validation.verified) return; // 容器锚点自身必须唯一命中，否则弃用
        leaves.forEach(leaf => {
          this.addCandidate(`${anchor.xpath}//${leaf.xpath}`, `scoped:${anchor.strategy}+${leaf.strategy}`,
            Math.min(90, anchor.score + leaf.score - 80), { scope: anchor.scope });
        });
      });
    }
  }

  /**
   * 为容器生成稳定锚点候选：
   *   1. 容器的 test 属性 / 稳定 id / aria-label
   *   2. 容器标题（.el-dialog__title / .el-drawer__header / 折叠面板头等）
   *   3. 页签 aria-labelledby 引用
   * 对 Element UI wrapper 额外追加"排除隐藏实例"谓词（style display:none 等），
   * 避免同标题的历史隐藏弹窗干扰唯一性。不做 [last()] —— DOM 最后一个往往是残留弹窗。
   */
  getContainerAnchorCandidates(container) {
    const tagName = container.tagName.toLowerCase();
    const candidates = [];
    const push = (xpath, strategy, score, scope) => candidates.push({ xpath, strategy, score, scope });

    // 1. 属性锚点。
    for (const attr of this.testAttributes.concat(['id', 'aria-label'])) {
      const value = container.getAttribute(attr);
      if (!normalizeSelectorText(value, 60) || value.length > 60 || dynamicValuePenalty(value) >= 80) continue;
      push(`//${tagName}[@${attr}=${quoteXPathValue(value)}]`, `container_${attr}`, attr === 'id' ? 94 : 96, 'container');
    }

    // 2. 标题锚点。
    const titleSelectors = [
      '.el-dialog__title', '.el-drawer__header', '.el-message-box__title', '.modal-title', '.dialog-title',
      '.drawer-title', '.el-collapse-item__header', '.collapse-header', '.collapse-title', '.panel-title'
    ];
    for (const selector of titleSelectors) {
      const titleElement = container.querySelector(selector);
      const title = normalizeSelectorText(titleElement && (titleElement.innerText || titleElement.textContent), 40);
      if (!title) continue;
      // 优先用容器自身的语义类做 token 限定（如 el-dialog__wrapper），
      // 没有时回退到第一个稳定类，避免类名顺序影响结果。
      const classNames = Array.from(container.classList || []);
      const semanticContainerClass = classNames.find(className => [
        'el-dialog__wrapper', 'el-drawer__wrapper', 'el-dialog', 'el-drawer', 'el-message-box',
        'modal', 'dialog', 'drawer', 'el-popover', 'el-tab-pane', 'tab-pane', 'el-collapse-item',
        'collapse-panel', 'collapse-item'
      ].includes(className));
      const stableClasses = classNames.filter(isStableClassName);
      const anchorClass = semanticContainerClass || stableClasses[0];
      let containerPredicate = anchorClass ? `[${classTokenPredicate(anchorClass)}]` : '';
      // 仅当容器当前可见，且属于 Element UI wrapper 时追加隐藏排除谓词。
      if (this.isRendered(container) && /(?:^|\s)(?:el-dialog__wrapper|el-drawer__wrapper)(?:\s|$)/.test(container.className || '')) {
        containerPredicate += "[not(@hidden)][not(@aria-hidden='true')][not(contains(translate(@style, ' ', ''), 'display:none'))]";
      }
      push(`//${tagName}${containerPredicate}[.//*[normalize-space(.)=${quoteXPathValue(title)}]]`, 'container_title', 90, 'titled_container');
      break; // 只取第一个命中的标题选择器，避免同容器生成多条等价标题锚点
    }

    // 3. 页签引用锚点（aria-labelledby 反查页签头文本）。
    const tabId = container.getAttribute('aria-labelledby');
    if (tabId) {
      const tab = this.document.getElementById(tabId);
      const text = normalizeSelectorText(tab && (tab.innerText || tab.textContent), 40);
      if (text) push(`//${tagName}[@aria-labelledby=${quoteXPathValue(tabId)}]`, 'tab_labelledby', 88, 'tab');
    }
    return candidates;
  }

  /**
   * 作用域内的目标叶子候选。同样按属性 > 文本 > class > 裸标签生成，
   * 便于与容器锚点做笛卡尔组合后统一验证。
   */
  getScopedLeafCandidates() {
    const tagName = this.element.tagName.toLowerCase();
    const leaves = [];
    const add = (xpath, strategy, score) => leaves.push({ xpath, strategy, score });
    for (const attr of this.testAttributes.concat(this.businessAttributes, ['placeholder'])) {
      const value = this.element.getAttribute(attr);
      if (!normalizeSelectorText(value, 60) || value.length > 60 || dynamicValuePenalty(value) >= 80) continue;
      add(`${tagName}[@${attr}=${quoteXPathValue(value)}]`, `leaf_${attr}`, attr.startsWith('data-test') ? 98 : 90);
    }
    const text = normalizeSelectorText(this.element.innerText || this.element.textContent, 40);
    if (text && (tagName === 'button' || tagName === 'a' || this.element.getAttribute('role') === 'button')) {
      add(`${tagName}[normalize-space(.)=${quoteXPathValue(text)}]`, 'leaf_text', isDynamicText(text) ? 55 : 84);
    }
    const stableClasses = Array.from(this.element.classList || []).filter(isStableClassName).slice(0, 2);
    stableClasses.forEach(cls => add(`${tagName}[${classTokenPredicate(cls)}]`, 'leaf_class', 62));
    add(tagName, 'leaf_tag', 35);
    return leaves;
  }

  /**
   * class 候选：单 token 与双 token 组合都会生成并参与评分（不再是旧版"只取第一个"）。
   * 注意：class 本身在 Element UI 中常与框架实现类混用，因此整体分数偏低，
   * 仅作为结构/属性候选之外的补充。
   */
  collectClassCandidates() {
    const tagName = this.element.tagName.toLowerCase();
    const stableClasses = Array.from(this.element.classList || []).filter(isStableClassName).slice(0, 5);
    stableClasses.forEach(cls => {
      this.addCandidate(`//${tagName}[${classTokenPredicate(cls)}]`, 'class_token', 58);
    });
    for (let i = 0; i < stableClasses.length; i++) {
      for (let j = i + 1; j < stableClasses.length; j++) {
        this.addCandidate(`//${tagName}[${classTokenPredicate(stableClasses[i])}][${classTokenPredicate(stableClasses[j])}]`, 'class_tokens', 64);
      }
    }
  }

  /**
   * 结构路径候选：从目标向上逐级拼接段，形成 //div/div/button 形式的短路径。
   * 每加一级生成一个候选，越深分越低；同时生成"目标段强制带同级索引"的变体
   * （依赖 DOM 位置，分更低）。深度受 SMART_SELECTOR_MAX_DEPTH 限制。
   */
  collectRelativePathCandidates() {
    const segments = [];
    let current = this.element;
    let depth = 0;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== this.document.body && depth < SMART_SELECTOR_MAX_DEPTH) {
      const segment = this.getStructuralSegment(current, false);
      segments.unshift(segment.xpath);
      depth++;
      this.addCandidate(`//${segments.join('/')}`, 'relative_path', 52 - depth * 2, {
        depth: depth, usesIndex: segments.some(item => /\[\d+\]$/.test(item))
      });

      // 变体：对当前最内层段强制加同级索引，应对同名兄弟造成的多命中。
      const indexedSegments = segments.slice();
      indexedSegments[0] = this.getStructuralSegment(current, true).xpath;
      this.addCandidate(`//${indexedSegments.join('/')}`, 'relative_path_indexed', 35 - depth * 2, {
        depth: depth, usesIndex: true, warnings: ['依赖 DOM 同级位置']
      });
      current = current.parentElement;
    }
  }

  /**
   * 单个结构路径段：tag[稳定class][同级索引]。
   * forceIndex=true 时无条件带索引（用于生成索引变体）；否则仅当同标签且同 class 的
   * 兄弟多于 1 个时才加索引，索引以"同标签+同 class"为范围，减少位置漂移。
   */
  getStructuralSegment(element, forceIndex) {
    const tagName = element.tagName.toLowerCase();
    const stableClasses = Array.from(element.classList || []).filter(isStableClassName);
    let segment = tagName;
    if (stableClasses.length) segment += `[${classTokenPredicate(stableClasses[0])}]`;
    const index = this.getSiblingIndex(element, stableClasses.length ? candidate => candidate.classList.contains(stableClasses[0]) : null);
    if (forceIndex || index.total > 1) segment += `[${index.position}]`;
    return { xpath: segment, usesIndex: forceIndex || index.total > 1 };
  }

  /**
   * 最终兜底：从 html/body 到目标的完整绝对 XPath。
   * 分数最低（5 分），只保证"存在一条可验证的路径"，不作为首选。
   * 由于每段都带同级索引，正常场景下该候选必然通过唯一性验证，保证不会失败返回空串。
   */
  addAbsoluteXPathCandidate() {
    const parts = [];
    let current = this.element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tagName = current.tagName.toLowerCase();
      const index = this.getSiblingIndex(current);
      parts.unshift(`${tagName}[${index.position}]`);
      if (current === this.document.documentElement) break;
      current = current.parentElement;
    }
    if (parts.length) {
      const xpath = `/${parts.join('/')}`;
      this.addCandidate(xpath, 'absolute_xpath', 5, {
        depth: parts.length, usesIndex: true, warnings: ['依赖完整 DOM 层级，仅作为最终兜底']
      });
    }
  }

  /**
   * 生成"单个元素的语义叶子"定位器，供表格行/作用域等组合候选复用。
   * 优先级：按钮文本 > 稳定属性 > 稳定 class > 裸标签。
   */
  getSemanticLeaf(element) {
    const tagName = element.tagName.toLowerCase();
    const text = normalizeSelectorText(element.innerText || element.textContent, 40);
    if (text && (tagName === 'button' || tagName === 'a' || element.getAttribute('role') === 'button')) {
      return `${tagName}[normalize-space(.)=${quoteXPathValue(text)}]`;
    }
    for (const attr of this.testAttributes.concat(this.businessAttributes, ['placeholder'])) {
      const value = element.getAttribute(attr);
      if (normalizeSelectorText(value, 60) && value.length <= 60 && dynamicValuePenalty(value) < 80) {
        return `${tagName}[@${attr}=${quoteXPathValue(value)}]`;
      }
    }
    const stableClass = Array.from(element.classList || []).find(isStableClassName);
    return stableClass ? `${tagName}[${classTokenPredicate(stableClass)}]` : tagName;
  }

  /**
   * 计算元素在同标签兄弟中的 1-based 位置。filter 可进一步限定"同标签+同 class"范围。
   * 返回 { position, total }，total>1 说明该标签存在多个同类兄弟，需要带索引。
   */
  getSiblingIndex(element, filter) {
    const parent = element.parentElement;
    if (!parent) return { position: 1, total: 1 };
    const siblings = Array.from(parent.children).filter(candidate => {
      if (candidate.tagName !== element.tagName) return false;
      return filter ? filter(candidate) : true;
    });
    return { position: Math.max(1, siblings.indexOf(element) + 1), total: siblings.length };
  }

  /**
   * 判断元素（及其祖先链）当前是否可见。仅用于生成"排除隐藏 wrapper"谓词，
   * 不把可见性作为持久定位条件（弹窗开合状态会在下次生成时自然反映）。
   */
  isRendered(element) {
    try {
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      let parent = element.parentElement;
      while (parent) {
        const parentStyle = element.ownerDocument.defaultView.getComputedStyle(parent);
        if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return false;
        parent = parent.parentElement;
      }
      return true;
    } catch (e) {
      return true; // 取样式失败时不阻断，按可见处理
    }
  }

  /** 候选验证（带实例内缓存，同一生成周期内同一 XPath 只 evaluate 一次）。 */
  evaluateCandidate(xpath) {
    if (this.evaluationCache.has(xpath)) return this.evaluationCache.get(xpath);
    const result = this.evaluateXPathForElement(xpath, this.element);
    this.evaluationCache.set(xpath, result);
    return result;
  }

  /**
   * 严格验证：XPath 在当前文档执行后，
   *   必须匹配恰好 1 个元素，且该元素严格等于 target。
   * 任何其他情况（语法错误/未命中/命中多个/唯一但命中错误元素）都视为未通过，
   * 这是"绝不返回命中错误元素的 XPath"这一硬门槛的核心实现。
   */
  evaluateXPathForElement(xpath, target) {
    try {
      const snapshot = this.document.evaluate(xpath, this.document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const count = snapshot.snapshotLength;
      const first = count > 0 ? snapshot.snapshotItem(0) : null;
      let status = 'multiple';
      if (count === 0) status = 'not_found';
      else if (count === 1 && first !== target) status = 'wrong_target';
      else if (count === 1 && first === target) status = 'verified';
      return { verified: status === 'verified', status: status, matchCount: count };
    } catch (e) {
      return { verified: false, status: 'invalid', matchCount: 0 };
    }
  }

  /**
   * 候选排序：分数降序；同分时无索引优先、深度浅优先、XPath 短优先。
   * 分数本身只用于相对比较，不对外承诺绝对含义。
   */
  compareCandidates(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.usesIndex !== b.usesIndex) return a.usesIndex ? 1 : -1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.xpath.length - b.xpath.length;
  }

  /**
   * 把元素 id 转成 CSS 属性选择器安全的值（用于 label[for] 反查）。
   * 优先使用 CSS.escape，避免 id 含特殊字符时选择器解析失败。
   */
  cssQuote(value) {
    if (typeof CSS !== 'undefined' && CSS.escape) return `"${CSS.escape(value)}"`;
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
}

/**
 * 兼容旧辅助方法名（仅诊断用）。
 * 注意：普通 XPath 无法穿透 ShadowRoot，本函数对 ShadowRoot 的"搜索"只是尝试，
 * 实际 evaluate 仍以各文档为边界，命中率不应被当作 Shadow DOM 支持的证明。
 */
function getElementsByXPathWithShadow(xpath, root = document) {
  const results = new Set();
  const visited = new Set();

  function search(searchRoot) {
    if (!searchRoot || visited.has(searchRoot)) return;
    visited.add(searchRoot);
    try {
      const doc = searchRoot.nodeType === Node.DOCUMENT_NODE ? searchRoot : searchRoot.ownerDocument;
      const snapshot = doc.evaluate(xpath, searchRoot, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < snapshot.snapshotLength; i++) results.add(snapshot.snapshotItem(i));
    } catch (e) {}

    if (!searchRoot.querySelectorAll) return;
    // 递归进入开放 ShadowRoot 与同源 iframe 文档，跨域 iframe 访问会抛错并忽略。
    searchRoot.querySelectorAll('*').forEach(element => {
      if (element.shadowRoot) search(element.shadowRoot);
    });
    searchRoot.querySelectorAll('iframe').forEach(iframe => {
      try {
        if (iframe.contentDocument) search(iframe.contentDocument);
      } catch (e) {}
    });
  }

  search(root);
  return Array.from(results);
}
