# 录制方向 · 智能自动填表

> [返回项目首页](../README.md)

本文档说明录制方向下智能自动填表的使用方式与实现流程。该功能仅在录制 popup 中可用，采集模式不提供。

- 总体架构与共用机制见 [architecture.md](./architecture.md)
- 录制功能见 [recording.md](./recording.md)

---

## 使用说明

1. 在弹窗中展开「智能自动填表」面板
2. 在输入框中填写指令，例如：
   - `随机填写个人信息`
   - `姓名填张三，手机号自动生成`
3. 点击「执行」或按 `Ctrl + Enter`
4. 系统会自动扫描当前页面表单字段并调用 LLM 完成填写

### 配置 LLM

1. 展开「智能自动填表」→「LLM 配置」
2. 填写 API Key、API 地址和模型名称
3. 点击「保存」

> 自动填表功能依赖外部 LLM 服务，请确保网络可访问并正确配置 API Key。

---

## 场景 C：智能自动填表

### C1. 完整自动填表流程（4 步）

```
[步骤1: 扫描表单字段]
Popup (autoFill.js)
  │  sendToContent(tabId, { type: 'scanFields' })
  ▼
Content (messageHandler.js)
  │  AutoFormFill.scanFields() → 返回字段列表
  │  sendResponse({ fields })
  ▼
Popup
  显示字段摘要（如"检测到 8 个字段（输入框 5 个，下拉框 3 个）"）

[步骤2: 调用 LLM]
Popup (autoFill.js)
  │  chrome.runtime.sendMessage({ type: 'callLLM', fields, instruction })
  ▼
Background (service-worker.js)
  │  chrome.storage.sync.get(['appConfig', 'atpFormConfig']) → 读取 LLM 配置
  │  LLMService.callLLM(config, fields, instruction)
  │    ├─ buildUserPrompt(fields, instruction)       (构建 prompt)
  │    └─ fetch(`${baseUrl}/chat/completions`)        (调用 LLM API)
  │  sendResponse({ actions, rawPrompt, rawResponse })
  ▼
Popup
  检查返回的 actions 数组

[步骤3: 注册进度监听]
Popup (autoFill.js)
  │  chrome.runtime.onMessage.addListener(listener)
  │  临时监听 'actionProgress' 和 'actionComplete'

[步骤4: 执行填表动作]
Popup (autoFill.js)
  │  sendToContent(tabId, { type: 'executeActions', actions })
  ▼
Content (messageHandler.js)
  │  sendResponse({ started: true })  ← 立即响应确认启动
  │
  │  AutoFormFill.executeActions(actions)  ← 异步逐个执行
  │    对每个动作循环:
  │    ├─ 执行填表操作 (fillFormField / selectOption / clickButtonForField)
  │    ├─ sendMessage({ type: 'actionProgress', data: entry })
  │    │    └─→ Popup (autoFill.js 临时 listener): 更新进度日志
  │    └─ 等待 400ms
  │
  │  全部完成后:
  │    ├─ 对每个成功的动作:
  │    │    sendMessage({ type: 'addActionData', data: {...} })
  │    │    └─→ Popup (RecordManager.handleMessage): 追加到录制列表
  │    │
  │    └─ sendMessage({ type: 'actionComplete', data: results })
  │         └─→ Popup (autoFill.js 临时 listener):
  │               removeListener → 显示"完成" → 恢复按钮状态
```

> **双重通道设计**：`executeActions` 先用 `sendResponse` 返回 `{ started: true }` 确认启动，
> 然后通过 `actionProgress`（逐条进度）和 `actionComplete`（最终完成）两个独立消息通道异步回传结果。
> Popup 端通过临时 `addListener` + `removeListener` 管理监听生命周期。
