# 录制功能

> [返回项目首页](../README.md)

本文档说明录制工具的使用方式，以及录制流程、页面刷新恢复和外部系统通信的实现。

- 总体架构与共用机制见 [architecture.md](./architecture.md)
- 导出字段与数据格式见 [export-format.md](./export-format.md)
- 智能自动填表见 [录制方向 · 智能自动填表](./auto-fill.md)
- 分组截图见 [录制方向 · 分组截图](./screenshot.md)

---

## 使用说明

### 录制操作

1. 点击扩展图标或从外部系统触发，打开录制弹窗
2. 点击「开始录制」按钮
3. 在目标网页上执行需要录制的操作
4. 操作会自动显示在弹窗的录制记录列表中
5. 录制完成后点击「终止录制」或「暂停录制」

录制期间发生页面跳转时：

- `pushState`、`replaceState`、浏览器前进后退和 Hash Router 跳转会在新页面渲染稳定后自动重新扫描
- 页面识别忽略查询参数；再次进入同一路由会复用并刷新原有“主页面”分组
- 每个路由拥有独立的“主页面”顶层分组，页面内继续按照弹窗、页签、折叠面板规则分组
- 历史路由分组保留在录制列表中，但只有当前路由允许执行截图

### 编辑操作

- 点击列表中的某一行可选中该操作
- 在下方编辑区修改 `Command`、`业务对象名称` 或 `Value`
- 点击「删除」可移除当前选中的操作

### 导出与提交

- **下载**：点击「下载」按钮，将录制结果保存为 JSON 文件
- **提交**：点击「提交」按钮，将录制结果上传到天阳自动化平台

> 下载/提交的 JSON 结构及对接字段见 [export-format.md](./export-format.md)。

---

## 场景 A：录制流程

### A1. 开始录制

```
Popup (index.js)
  │  chrome.tabs.sendMessage(tab.id, { type: 'startRecording' })
  ▼
Content (messageHandler.js)
  │  匹配 'startRecording' → 调用 startRecordEvent()
  │    ├─ sendBackMessage('startRecord', startUrl)
  │    │    ├─→ Background: monitorStates[tabId] = true  (标记正在录制)
  │    │    └─→ Popup: recordDataUrl = startUrl          (保存录制页面 URL)
  │    │
  │    ├─ PageElementScanner.scan(document)              (扫描页面元素)
  │    └─ EventMonitor.listener(document)                (注册 change/click 监听)
  │
  │  sendResponse({ status: 'started' })
  ▼
Popup
  收到响应 → setRecordingUI('recording')
```

### A2. 录制中 — 用户操作产生动作数据

```
用户操作页面
  │  EventMonitor 捕获 change/click 事件
  │  → Recorder.setAttributeAction(element)
  │    → Recorder.setAction(element, attributes)
  │      → sendBackMessage('addActionData', action)
  │           ├─→ Background: SKIP_IN_BG 短路返回，不处理
  │           └─→ Popup (RecordManager.handleMessage):
  │                 更新 recordActionList → 过滤 → 渲染列表 → 更新计数
```

> **特殊子流程**：
> - **下拉框合并**：连续触发 `select` + `selectOption` 时，延迟 100ms 合并为一条动作再发送
> - **日期选择器轮询**：每 200ms 检查输入值变化，检测到变化后发送 `addActionData`
> - **树形选择器更新**：延迟 150ms 后更新已有动作并重新发送 `addActionData`

### A3. 暂停 / 停止录制

```
Popup (index.js)
  │  chrome.tabs.sendMessage(tab.id, { type: 'pauseRecording' | 'stopRecording' })
  ▼
Content (messageHandler.js)
  │  调用 pauseRecordEvent() / stopRecordEvent()
  │    ├─ Recorder.getActions() → 附加 nameMap 中的业务名称
  │    ├─ Recorder.destroy() → 清理录制状态
  │    └─ sendBackMessage('stopRecord', actions)
  │         └─→ Background: delete monitorStates[tabId]  (清除录制标记)
  │
  │  sendResponse({ status: 'paused' | 'stopped' })
  ▼
Popup
  收到响应 → setRecordingUI('paused' | 'idle')
```

### A4. 继续录制

```
Popup (index.js)
  │  chrome.tabs.sendMessage(tab.id, { type: 'continueRecording' })
  ▼
Content (messageHandler.js)
  │  调用 continueRecordEvent()
  │    └─ EventMonitor.listener(document)   (重新注册事件监听)
  │
  │  sendResponse({ status: 'continued' })
  ▼
Popup
  收到响应 → setRecordingUI('recording')
```

---

## 场景 B：页面刷新恢复

### B1. Content Script 初始化时查询录制状态

```
Content (content.js) — 页面加载时立即执行
  │  chrome.runtime.sendMessage({ type: 'initMonitor' })
  ▼
Background (service-worker.js)
  │  读取 monitorStates[sender.tab.id]
  │  sendResponse({ monitorStates: true/false })
  ▼
Content
  │  若 monitorStates === true:
  │    调用 startRecordEvent() → 同 A1 后续流程
```

> 此机制确保用户刷新页面后，若之前正在录制，则自动恢复录制状态。

---

## 场景 E：外部系统通信

### E1. 外部扩展发送数据并打开弹窗

```
外部扩展/应用
  │  chrome.runtime.sendMessage(EXTENSION_ID, requestData)
  ▼
Background (service-worker.js)
  │  onMessageExternal 触发
  │  JSON.stringify(request) → 存入 chrome.storage.sync({ tyAtpData: ... })
  │  PopupManager.openOpertePopup()  → 打开/聚焦操作弹窗
  ▼
Popup (uploadService.js)
  │  用户点击"提交"时:
  │  chrome.storage.sync.get('tyAtpData') → 读取外部数据
  │  使用 hostOrigin / transcationId / zdh_token 上传录制结果到自动化平台
```

> 此通道用于与天阳自动化平台对接：外部系统传入认证信息和事务 ID，
> 扩展完成录制后通过"提交"按钮将结果上传。
