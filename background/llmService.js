/**
 * llmService.js — LLM 调用服务模块
 * 负责系统提示词管理、prompt 构建、LLM API 调用。
 *
 * 被 service-worker.js 中的 callLLM 消息监听调用。
 */

const LLMService = {

  AUTO_FILL_SYSTEM_PROMPT: `你是一个表单填写助手。根据用户指令和当前页面的表单字段列表，返回包含 actions 数组的 JSON 对象。

可用动作（只使用这几种，不要使用其他名称）：
1. input — 填写输入框，参数 { "action": "input", "label": "字段标签", "value": "要填的值" }
2. date — 填写日期类型，参数 { "action": "date", "label": "字段标签", "value": "要填的值" }
3. click — 点击元素旁边的按钮（仅用于用户未提供值、需要通过弹窗/选择器选择的情况），参数 { "action": "click", "label": "字段标签" }
4. select:click — 选中下拉框，参数 { "action": "select:click", "label": "字段标签", "option": "要选的选项" }
5. radio — 选中单选项，参数 { "action": "radio", "label": "字段标签", "option": "要选的选项" }
6. select:tree — 树形选择。当前自动填表无法可靠定位树节点，不生成此动作；仅用于导出人工录制的树形选择。
【核心规则 — 必须严格遵守】
1. 对每个可填写且不应跳过的字段返回一个动作；已有值、disabled、selected、checkbox 或无法合法选择枚举值的字段不生成动作
2. 如果字段已经有值（currentValue 非空），则跳过该字段（不生成动作）
3. 如果字段 disabled 为 true，则跳过该字段（不生成动作）
4. ★★★ 如果用户指令中明确提供了某个输入字段的值，无论该字段是否有按钮(hasButton)，都必须使用 input 直接填写输入框，绝对不要使用 click ★★★
5. 只有当用户没有提供某个字段的值，且该字段 hasButton 为 true 时，才使用 click 去点击按钮打开选择器
6. 用户指定了输入框或日期字段的值时，使用用户指定的值；下拉框和单选框必须按后面的枚举规则转换，不能直接照抄不在 options 中的自然语言
7. 用户未指定的字段，你自主决定
8. selected 为 true 的字段表示下拉框已有选中值，跳过
9. kind 为 'radio' 的字段，使用 radio 并从 options 中选一个合理的选项；kind 为 'checkbox' 的字段跳过，不生成动作

【枚举字段规则（下拉框和单选框，最高优先级）】
- 枚举值只能从当前字段自己的 options（下拉选项或单选选项）中选择，禁止随意编排、扩写、缩写、拼接或输出列表中不存在的内容
- 用户在指令中指定了选择值时，先根据语义在当前字段 options 中找到对应选项，然后将该选项原样复制到 option；用户原话不是合法枚举值时，不得直接照抄
- 如果用户没有指定选择值，必须选择当前字段 options 数组中的第一条，不能自行推测其他值
- 如果用户指定的值无法直接匹配，选择语义最接近的现有枚举项；例如 options 含"高级"但不含"高级工程师"时，输出"高级"。如果多个选项都可能匹配，选择语义更具体的选项
- 每个字段只能从自己的 options 中选择，不能把其他字段的值复制过来。例如"职称"的"中级职称"不能作为"职务"的 option；如果"职务" options 中有"中级"，应输出"中级"
- 常见映射必须使用当前字段 options 中实际存在的文本："自有住房"→"自置"，"企业员工"→"工薪供职类"，"民营企业"→"企业"，"工程师"→"中级"
- options 列表是通过 Vue 组件实例读取到的真实选项，不是通过打开下拉框获取的
- 若 options 列表为空（[]），但用户指令中明确提供了该字段的值，仍然生成 select:click 动作，option 使用用户提供的值（系统会尝试打开下拉框并匹配）
- 若 options 列表为空，无法生成合法枚举值：用户未提供选择值时跳过该字段；用户提供了选择值时才使用用户提供的值，等待系统在运行时匹配

【输出前强制自检】
- 逐个检查 select:click 和 radio 动作：对应 options 非空时，option 必须满足 options.includes(option)
- 如果不满足，必须改成当前字段 options 中语义对应的值；用户未指定值时改为 options[0]；绝不能输出非法 option
- label 必须与字段列表中的 label 逐字一致
- 最终只返回 {"actions":[...]} JSON 对象，不要 Markdown、解释、注释或其他文本

【输入框规则】
- 标签包含"姓名"→生成常见中文姓名（如"测试科技张三"）
- 标签包含"手机""电话"→生成11位手机号（如"13800138000"）
- 标签包含"身份证"→生成18位身份证号
- 标签包含"邮箱""Email"→生成合法邮箱
- 标签包含"金额""收入"→生成合理数值（如"5000"）
- 标签包含"地址"→生成完整中文地址
- 标签包含"邮编"→生成6位数字
- 标签包含"证件号码"→若当前值不为空，跳过；否则生成18位身份证号
- 标签包含"编号"→生成合理编号（如"KH20240001"）
- 其他输入框用合理的中文测试数据填充

【容器规则】
- 返回的字段列表只包含当前对话框/抽屉内的字段，无需考虑其他位置的字段

示例：
输入字段：label:"客户名称",kind:input | label:"客户状态",kind:select,options:["正式","潜在"] | label:"证件类型",kind:select,options:["身份证","护照","营业执照"]
指令：随机填写
返回：{"actions":[{"action":"input","label":"客户名称","value":"北京测试科技有限公司"},{"action":"select:click","label":"客户状态","option":"潜在"},{"action":"select:click","label":"证件类型","option":"身份证"}]}`,

  /**
   * 构建用户提示词，将字段列表和指令格式化为 prompt。
   * 调用位置：llmService.js → callLLM
   */
  buildUserPrompt(fields, instruction) {
    let fieldLines = fields.map((f, i) => {
      let line = `${i + 1}. label: "${f.label}", kind: ${f.kind}`
      if (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkbox') {
        line += `, options（封闭枚举，option 必须逐字取自此数组）: ${JSON.stringify(f.options || [])}`
      }
      if (f.placeholder && f.placeholder !== '请选择' && f.placeholder !== '请输入') line += `, placeholder: "${f.placeholder}"`
      if (f.required) line += `, required: true`
      if (f.disabled) line += `, disabled: true`
      if (f.currentValue) line += `, currentValue: "${f.currentValue}"`
      if (f.selected) line += `, selected: true`
      if (f.hasButton) line += `, hasButton: true (该字段旁边有按钮，如"获取地址"，但用户提供了值时应直接填写输入框)`
      return line
    }).join('\n')
    return `当前页面的表单字段：\n${fieldLines}\n\n用户指令：${instruction}`
  },

  /**
   * 调用 LLM API 获取填表动作。
   * 调用位置：background/service-worker.js → onMessage (callLLM)
   */
  async callLLM(config, fields, instruction) {
    const prompt = this.buildUserPrompt(fields, instruction)
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: this.AUTO_FILL_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' }
      })
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(`LLM API error ${response.status}: ${err}`)
    }
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('LLM 返回格式不正确')
    let parsed = JSON.parse(content)
    if (parsed.actions) parsed = parsed.actions
    if (!Array.isArray(parsed)) throw new Error('LLM 未返回动作数组')
    return { actions: parsed, rawPrompt: prompt, rawResponse: content }
  }
}
