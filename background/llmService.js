/**
 * llmService.js — LLM 调用服务模块
 * 负责系统提示词管理、prompt 构建、LLM API 调用。
 *
 * 被 service-worker.js 中的 callLLM 消息监听调用。
 */

const LLMService = {

  AUTO_FILL_SYSTEM_PROMPT: `你是一个表单填写助手。根据用户指令和当前页面的表单字段列表，返回 JSON 动作数组。

可用动作（只使用这几种，不要使用其他名称）：
1. fill_form_field — 填写输入框，参数 { "action": "fill_form_field", "label": "字段标签", "value": "要填的值" }
2. fill_date_field — 填写日期类型，参数 { "action": "fill_date_field", "label": "字段标签", "value": "要填的值" }
3. click_element_by_index — 点击元素旁边的按钮（仅用于用户未提供值、需要通过弹窗/选择器选择的情况），参数 { "action": "click_element_by_index", "label": "字段标签" }
4. select_option — 选中下拉框，参数 { "action": "select_option", "label": "字段标签", "option": "要选的选项" }
【核心规则 — 必须严格遵守】
1. 对每个字段都必须返回一个动作，动作数量必须等于字段数量（除非 options 为空或已有值或 disabled，见下方规则）
2. 如果字段已经有值（currentValue 非空），则跳过该字段（不生成动作）
3. 如果字段 disabled 为 true，则跳过该字段（不生成动作）
4. ★★★ 如果用户指令中明确提供了某个字段的值，无论该字段是否有按钮(hasButton)，都必须使用 fill_form_field 直接填写输入框，绝对不要使用 click_element_by_index ★★★
5. 只有当用户没有提供某个字段的值，且该字段 hasButton 为 true 时，才使用 click_element_by_index 去点击按钮打开选择器
6. 用户指定了值的字段，必须使用用户指定的值
7. 用户未指定的字段，你自主决定
8. selected 为 true 的字段表示下拉框已有选中值，跳过
9. kind 为 'radio' 或 'checkbox' 的字段，从 options 中选一个合理的选项

【下拉框规则 (Element UI el-select)】
- select_option 的 option 必须从该字段的 options 列表中选取
- options 列表是通过 Vue 组件实例读取到的真实选项，不是通过打开下拉框获取的
- 若 options 列表为空（[]），但用户指令中明确提供了该字段的值，仍然生成 select_option 动作，option 使用用户提供的值（系统会尝试打开下拉框并匹配）
- 若 options 列表为空且用户也未提供值，则跳过该字段（不生成动作）

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
返回：[{"action":"fill_form_field","label":"客户名称","value":"北京测试科技有限公司"},{"action":"select_option","label":"客户状态","option":"潜在"},{"action":"select_option","label":"证件类型","option":"身份证"}]`,

  /**
   * 构建用户提示词，将字段列表和指令格式化为 prompt。
   * 调用位置：llmService.js → callLLM
   */
  buildUserPrompt(fields, instruction) {
    let fieldLines = fields.map((f, i) => {
      let line = `${i + 1}. label: "${f.label}", kind: ${f.kind}`
      if (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkbox') {
        line += `, options: [${(f.options || []).map(o => `"${o}"`).join(', ')}]`
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
