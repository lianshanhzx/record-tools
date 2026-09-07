# TY Record Tools

天阳录制工具 — 一款基于 Chrome Manifest V3 的浏览器录制插件，用于录制用户在网页上的操作并生成自动化脚本。

## 功能特性

- **网页操作录制**：录制点击、输入、下拉选择、日期选择、树形选择等操作
- **智能 XPath 选择器**：自动生成稳定、可读的定位路径
- **路由页面扫描**：录制过程中检测 SPA 路由和整页跳转，新页面自动扫描并形成独立的“主页面”顶层分组
- **智能自动填表**：基于 LLM 一句话自动填写 Element UI 表单
- **分组截图**：对录制的每个分组生成全页长截图，自动识别内部滚动容器（适配 Vue + Element UI），自动去除吸顶表头/固定工具栏造成的重复区域
- **录制记录列表管理**：查看、编辑、删除已录制的操作
- **回放验证**：勾选操作记录或默认回放全部记录，在当前页面验证定位器和动作执行结果
- **导出/提交**：支持下载 JSON 文件或直接提交到天阳自动化平台

## 项目结构

```
record-tools/
├── background/
│   ├── service-worker.js       # 后台入口：消息路由、全局录制状态标记
│   ├── popupManager.js         # 弹窗窗口管理（创建/聚焦 popup）
│   └── llmService.js           # LLM 调用服务（prompt 构建、API 调用）
├── content/
│   ├── content.js              # 内容脚本入口：初始化、录制生命周期管理
│   ├── recorder.js             # 录制核心：状态管理、动作解析、元素值获取
│   ├── treeSelectHandler.js    # 树形选择器处理（节点识别、弹窗检测）
│   ├── eventMonitor.js         # 事件监听（change/click 事件注册与分发）
│   └── messageHandler.js       # 消息通信 + 截图滚动目标识别与坐标回报（content 侧消息收发）
├── popup/
│   ├── index.html              # 弹窗页面（含分组截图弹窗列表与预览）
│   ├── index.js                # 弹窗入口：录制控制、通信工具、消息分发
│   ├── autoFill.js             # 自动填表 UI（面板交互、日志、配置管理）
│   ├── recordManager.js        # 录制数据管理（列表渲染、过滤、编辑、分组截图入口）
│   ├── screenshotService.js    # 全页滚动截图：驱动滚动、逐屏捕获、裁切拼接、下载
│   ├── uploadService.js        # 上传/下载服务（导出 JSON、提交到平台）
│   └── index.css               # 弹窗样式
├── config/
│   └── config.js               # 全局配置（接口地址、截图保存目录、截图像素上限）
├── libs/                       # 第三方/业务库
│   ├── jquery.js               # jQuery 库
│   ├── utils.js                # 通用工具函数（uuid、action2Json、下载等）
│   ├── smartSelector.js        # 智能 XPath 选择器
│   ├── myXPathHelper.js        # XPath 辅助工具
│   ├── autoFormFill.js         # 自动填表核心（字段扫描、动作执行）
│   ├── elementBusinessName.js  # 元素业务名称识别
│   └── pageElementScanner.js   # 页面元素扫描器
├── icons/                      # 扩展图标
└── manifest.json               # Chrome 扩展配置（Manifest V3）
```

## 安装与加载

### 1. 生成扩展私钥和公钥（如需固定 extensionId）

```bash
# 生成私钥
openssl genrsa -out private.pem 2048

# 根据私钥提取公钥
openssl rsa -in private.pem -pubout -out public.pem
```

### 2. 配置公钥

1. 打开 `manifest.json`
2. 将 `public.pem` 中的公钥内容替换到 `key` 字段中
3. 私钥仅用于签名发布包，必须保存在项目目录之外，禁止提交到 Git

### 3. 加载扩展

1. 打开 Chrome 浏览器，进入 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目根目录 `record-tools`

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

### 智能自动填表

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

### 导出与提交

- **下载**：点击「下载」按钮，将录制结果保存为 JSON 文件
- **提交**：点击「提交」按钮，将录制结果上传到天阳自动化平台

### 分组截图

录制过程中，录制列表会按页面结构（主页面 / 页签 / 弹窗 / 折叠面板等）分组展示，每个分组标题右侧有「截图」按钮：

1. 点击某个分组标题上的「截图」按钮，对该分组对应的页面区域生成全页长截图
2. 截图过程中：
   - 其他分组的「截图」按钮自动变为不可用状态
   - 当前分组按钮显示「正在截图中 x/y」实时进度
   - 任务结束（成功或失败）后全部按钮自动恢复
3. 截图自动下载到浏览器默认下载目录下的 `TY-record-tools/screenshots` 子目录，文件名格式为 `{分组名}-full-page-{yyyyMMdd-HHmmss-mmm}.png`
4. 分组标题右侧的「截图 n」按钮可打开该分组的截图列表，支持「预览」和「删除」操作

> **滚动与拼接说明**：
> - 支持两种滚动场景：普通文档整体滚动，以及 Vue + Element UI 常见的内部滚动容器（如 `el-scrollbar` 外层布局、表格区域等），会被自动识别并正确滚动
> - 相邻截图保留一段重叠区用于拼接去重，吸顶表头、固定工具栏等元素在长图中只保留一次，不会重复出现
> - `captureVisibleTab` 只能捕获可见视口，页面高度过长或截图总像素超过上限时会被拦截并提示

## 消息通信架构

本扩展采用 Chrome Extension 三端通信模型（Content Script / Popup / Background），通过 `chrome.runtime.sendMessage`、`chrome.tabs.sendMessage`、`chrome.runtime.onMessage`、`chrome.runtime.onMessageExternal` 实现消息传递。

### 通信总览图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Chrome Extension 三端通信架构                        │
├──────────────────┬──────────────────────┬───────────────────────────────────┤
│   Content Script │       Popup          │         Background                │
│   (页面注入)      │   (弹窗页面)          │      (Service Worker)            │
├──────────────────┼──────────────────────┼───────────────────────────────────┤
│                  │                      │                                   │
│  ┌────────────┐  │  ┌───────────────┐   │  ┌────────────────────────────┐  │
│  │ Recorder   │  │  │ RecordManager │   │  │ monitorStates (录制标记)    │  │
│  │ EventMon.  │  │  │ AutoFillUI    │   │  │                            │  │
│  │ TreeSelect │  │  │ UploadService │   │  │ PopupManager (弹窗管理)    │  │
│  │ MsgHandler │  │  │               │   │  │ LLMService  (LLM调用)     │  │
│  └────────────┘  │  └───────────────┘   │  └────────────────────────────┘  │
│                  │                      │                                   │
└──────────────────┴──────────────────────┴───────────────────────────────────┘
         │                    │                          │
         │  chrome.runtime    │  chrome.tabs             │
         │  .sendMessage ◄───►│  .sendMessage            │
         │                    │                          │
         │  chrome.runtime    │  chrome.runtime          │
         │  .sendMessage ◄──────────────────────────────►│
         │                    │  chrome.runtime          │
         │                    │  .sendMessage ──────────►│
         │                    │                          │
         │                    │        外部扩展           │
         │                    │  onMessageExternal ─────►│
```

### 消息类型速查表

| 消息类型 | 方向 | 通信 API | 响应方式 | 说明 |
|---|---|---|---|---|
| `initMonitor` | Content → Background | `runtime.sendMessage` | 同步响应 | 查询标签页录制状态 |
| `startRecord` | Content → Background/Popup | `runtime.sendMessage` | 无响应(广播) | 通知开始录制，Background 标记状态，Popup 存 URL |
| `stopRecord` | Content → Background | `runtime.sendMessage` | 无响应(广播) | 通知停止录制，Background 清除标记 |
| `startRecording` | Popup → Content | `tabs.sendMessage` | 同步响应 | 开始录制 |
| `stopRecording` | Popup → Content | `tabs.sendMessage` | 同步响应 | 停止录制 |
| `pauseRecording` | Popup → Content | `tabs.sendMessage` | 同步响应 | 暂停录制 |
| `continueRecording` | Popup → Content | `tabs.sendMessage` | 同步响应 | 继续录制 |
| `addActionData` | Content → Popup | `runtime.sendMessage` | 无响应(广播) | 添加/更新单条录制动作 |
| `scanFields` | Popup → Content | `tabs.sendMessage` | 同步响应 | 扫描表单字段 |
| `executeActions` | Popup → Content | `tabs.sendMessage` | 立即响应+异步回传 | 执行自动填表动作 |
| `actionProgress` | Content → Popup | `runtime.sendMessage` | 无响应(广播) | 填表单步进度通知 |
| `actionComplete` | Content → Popup | `runtime.sendMessage` | 无响应(广播) | 填表全部完成通知 |
| `callLLM` | Popup → Background | `runtime.sendMessage` | 真正异步响应 | 调用 LLM 生成填表动作 |
| `getScannedElements` | Popup → Content | `tabs.sendMessage` | 同步响应 | 获取已扫描的页面元素 |
| `prepareFullPageScreenshot` | Popup → Content | `tabs.sendMessage` | 同步响应 | 截图准备：识别滚动目标、保存原始滚动位置、返回页面几何 |
| `scrollForScreenshot` | Popup → Content | `tabs.sendMessage` | 异步响应 | 截图滚动：滚动到指定位置并回报实际位置/容器几何（延迟响应等待布局稳定） |
| `restoreScrollAfterScreenshot` | Popup → Content | `tabs.sendMessage` | 同步响应 | 恢复页面原始滚动位置与 scrollBehavior |
| `captureVisibleTabForScreenshot` | Popup → Background | `runtime.sendMessage` | 真正异步响应 | 捕获当前可视区截图并返回 dataUrl |
| `trackScreenshotDownload` | Popup → Background | `runtime.sendMessage` | 异步响应 | 记录截图下载 ID，用于后续清理 |
| `untrackScreenshotDownload` | Popup → Background | `runtime.sendMessage` | 异步响应 | 移除已清理截图对应的下载 ID |
| 外部消息 | 外部扩展 → Background | `onMessageExternal` | 无响应 | 接收外部数据并打开弹窗 |

> **注**：`addActionData`、`actionProgress`、`actionComplete` 为高频广播消息，Background 端做了短路返回优化（`SKIP_IN_BG`），避免无效分支遍历。

> **响应方式说明**：
> - **同步响应**：监听器 `return true` 但 `sendResponse` 在同步逻辑后立即调用，等效于同步
> - **真正异步响应**：`sendResponse` 在 Promise resolve 后调用（如 `callLLM` 等待网络请求）
> - **无响应(广播)**：发送方不等待响应（fire-and-forget），消息会被所有 `onMessage` 监听器接收

---

### 场景 A：录制流程

#### A1. 开始录制

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

#### A2. 录制中 — 用户操作产生动作数据

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

#### A3. 暂停 / 停止录制

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

#### A4. 继续录制

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

### 场景 B：页面刷新恢复

#### B1. Content Script 初始化时查询录制状态

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

### 场景 C：智能自动填表

#### C1. 完整自动填表流程（4 步）

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
  │  chrome.storage.sync.get('atpFormConfig') → 读取 LLM 配置
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

---

### 场景 D：弹窗管理

#### D1. 扩展图标点击 / 外部消息触发

```
用户点击扩展图标 或 外部系统触发
  │  chrome.action.onClicked / chrome.runtime.onMessageExternal
  ▼
Background
  │  PopupManager.openOpertePopup()
  │    ├─ chrome.windows.getAll() → 检查是否已有 popup 窗口
  │    ├─ 若无 → chrome.windows.create({ url: 'popup/index.html', type: 'popup' })
  │    └─ 若有 → chrome.windows.update(popup.id, { focused: true })
```

---

### 场景 E：外部系统通信

#### E1. 外部扩展发送数据并打开弹窗

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

---

### 场景 F：元素扫描与下载

扫描、人工录制以及下载 JSON 使用同一套对接字段：

| 字段 | 说明 |
| --- | --- |
| `propertiesID` | 元素或分组的 UUID |
| `propertiesPID` | 父分组的 `propertiesID` |
| `propertiesName` | 元素业务名称或分组实际名称 |
| `eventTypeValue` | `click` / `input` / `select:click` / `select:tree` / `radio` / `date` |
| `eventTypeName` | 点击 / 输入 / 下拉框选择 / 树形选择 / 单选 / 日期 |
| `elementType` | 元素记录取 `target`，分组固定为空字符串 |
| `mothed` | 元素固定为 `By.XPATH`，分组固定为空字符串 |
| `objectValue` | 原元素 `value` 字段 |
| `transcationType` | 固定为 `playwright` |
| `realLabel` | 按关联 label、上层表单项、ARIA、属性等页面原始信息提取，不追加识别后缀；分组固定为空字符串 |
| `rect` | 元素位置，格式为 `{ x1, y1, x2, y2 }`；分组固定为空对象 |

`propertiesName` 用于业务识别，允许追加按钮文本或人工去重后缀；`realLabel` 只保留页面标签查找链路得到的原始文本，不追加这些识别内容。

下载结果中的分组节点使用随机 UUID，并通过 `propertiesPID` 关联父分组。内部用于 XPath、截图和折叠状态的分组 `key` 不作为分组 ID。分组节点固定包含以下对接字段：

```json
{
  "propertiesID": "<uuid>",
  "propertiesPID": null,
  "propertiesName": "主页面",
  "eventTypeValue": "click",
  "eventTypeName": "点击",
  "elementType": "",
  "mothed": "",
  "options": "",
  "objectValue": "",
  "transcationType": "playwright",
  "realLabel": "",
  "regionId": "",
  "regionLabel": "",
  "rect": {}
}
```

元素的 `rect` 中，`x1/y1` 表示左上角位置，`x2/y2` 表示右下角位置：

```json
{
  "rect": {
    "x1": 100,
    "y1": 200,
    "x2": 300,
    "y2": 240
  }
}
```

#### F1. 获取已扫描元素

```
Popup (uploadService.js)
  │  sendToContent(tab.id, { type: 'getScannedElements' })
  ▼
Content (messageHandler.js)
  │  sendResponse({ elements: Recorder.scannedPageElements || [] })
  ▼
Popup
  按显示区域构建树形结构 → 下载 scanned-elements-tree-{timestamp}.json
```

---

### 场景 G：分组截图（全页滚动长图）

截图由三方协作完成：Popup 控制滚动步进与拼接下载，Content 负责识别滚动目标并执行滚动/回报坐标，Background 负责调用 `captureVisibleTab` 抓取视口。

```
[步骤1: 准备工作]
Popup (screenshotService.js)
  │  sendToContent(tab.id, { type: 'prepareFullPageScreenshot' })
  ▼
Content (messageHandler.js)
  │  getScreenshotScrollTarget()  → 识别实际滚动目标
  │    ├─ 普通页面：document / window 整体滚动
  │    └─ Vue + Element UI：内部滚动容器（overflow 容器，页面外壳固定）
  │  保存原始滚动位置与 scrollBehavior → 返回最大滚动距离 / 可视区几何
  ▼
Popup
  预估最终图片尺寸，超过截图像素上限（config.screenshotMaxPixels）直接报错

[步骤2: 滚动捕获循环]
Popup (screenshotService.js)
  │  反复调用 sendToContent(scrollForScreenshot, y) 逐屏往下滚动
  │    每次滚动后 Content 延迟约 180ms 回报实际 scrollTop / maxScrollY / captureRect
  │  相邻屏之间保留重叠区（约视口高度 25%~40%，见 getCaptureOverlap），
  │    用于拼接时丢弃吸顶表头等固定内容，避免重复区域
  │  每屏间隔 550ms 节流（Chrome 对 captureVisibleTab 有每秒调用次数限制）
  │  chrome.runtime.sendMessage({ type: 'captureVisibleTabForScreenshot' })
  ▼
Background (service-worker.js)
  │  chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  │  sendResponse({ dataUrl })
  ▼
Content → Popup
  连续两次到达底部（actualY >= maxScrollY）才判定滚动结束

[步骤3: 拼接与下载]
Popup (screenshotService.js)
  │  stitch(captures, pageInfo)
  │    ├─ 文档滚动：按每屏实际内容位置依次贴入，高度 = 文档高度 × scale
  │    └─ 内部滚动容器：
  │         ├─ 保留页头/两侧固定外壳
  │         ├─ 滚动内容按"新进入视口"区域裁切后插入（去重重叠区）
  │         └─ 页脚搬到滚动内容末尾，避免被覆盖
  │  生成 PNG Blob → URL.createObjectURL
  │  chrome.downloads.download 下载到 TY-record-tools/screenshots 目录
  │  → trackScreenshotDownload 记录下载 ID（供删除时清理）
  ▼
Popup (recordManager.js)
  更新分组截图列表 → 重新渲染 → 恢复所有截图按钮

[步骤4: 收尾（无论成败）]
Popup (screenshotService.js finally)
  │  sendToContent(restoreScrollAfterScreenshot)
  ▼
Content
  恢复容器/窗口原始滚动位置，还原 scrollBehavior
```

> **去重原理**：Element UI 页面常带吸顶表头与固定工具栏，每个滚动位置它们都出现在视口同一处。截图采用“相邻屏重叠 + 拼接时只取新进入视口内容”策略，仅在首屏保留固定元素一次；内部滚动容器场景还会额外处理页头、侧边与页脚。

---

### 场景 H：已清理的无效通道

以下消息类型在代码中存在监听处理但从未被发送，已在重构中清理：`ping`、`logToConsole`、`rescanElements`、`openPopup`、`checkFlag`、`execute`、`start`、`refresh`（Background 侧 handler）。

> 清理后的 Background 仅处理少量消息：`stopRecord` / `startRecord` / `initMonitor` / `getPopupTargetTab` / `callLLM` / `captureVisibleTabForScreenshot` / `trackScreenshotDownload` / `untrackScreenshotDownload`。

---

### sendToContent 自动注入机制

`popup/index.js` 中的 `sendToContent` 函数封装了消息发送与自动注入逻辑：

```
sendToContent(tabId, message)
  │
  ├─ 尝试 chrome.tabs.sendMessage(tabId, message)
  │    ├─ 成功 → 返回响应
  │    └─ 失败 (Receiving end does not exist)
  │         │
  │         ├─ 检查是否为扩展自身页面 → 提示"请先点击用户页面激活标签页"
  │         │
  │         └─ 自动注入脚本:
  │              chrome.scripting.executeScript({
  │                target: { tabId },
  │                files: [utils.js, autoFormFill.js, smartSelector.js,
  │                        elementBusinessName.js, myXPathHelper.js,
  │                        pageElementScanner.js, recorder.js,
  │                        treeSelectHandler.js, eventMonitor.js,
  │                        messageHandler.js, content.js]
  │              })
  │              等待 500ms → 重试 sendMessage
  │
  └─ 其他错误 → 记录"通信错误"日志
```

> 此机制确保即使用户在扩展安装后才打开的页面（content script 未自动注入），
> 也能通过手动触发自动注入后正常通信。

---

### 通信设计要点

1. **广播消息的短路优化**：`addActionData`、`actionProgress`、`actionComplete` 采用 fire-and-forget 广播模式。Background 端通过 `SKIP_IN_BG` 数组在 listener 入口处短路返回，避免高频消息穿透所有分支后无效丢弃。

2. **`return true` 的普遍使用**：Content Script 和 Background 的所有 `onMessage` 监听器都返回 `true`，保持消息通道为异步模式。但大多数情况下 `sendResponse` 是立即调用的（等效同步），只有 `callLLM` 是真正的异步等待（等待网络请求）。

3. **消息命名约定**：录制控制消息使用 `xxxRecording`（如 `startRecording`），由 Popup 通过 `tabs.sendMessage` 发送给 Content；录制状态通知使用 `xxxRecord`（如 `startRecord`、`stopRecord`），由 Content 通过 `runtime.sendMessage` 广播给 Background 和 Popup。

## 开发注意事项

- 插件基于 **Chrome Manifest V3**，请使用支持 MV3 的 Chrome 版本
- **content 脚本加载顺序**：`libs/utils.js` → `libs/autoFormFill.js` → `libs/smartSelector.js` → `libs/elementBusinessName.js` → `libs/myXPathHelper.js` → `libs/pageElementScanner.js` → `content/recorder.js` → `content/treeSelectHandler.js` → `content/eventMonitor.js` → `content/messageHandler.js` → `content/content.js`，顺序不可随意调整
- **background 脚本**：`service-worker.js` 通过 `importScripts()` 加载 `popupManager.js` 和 `llmService.js`
- **popup 脚本加载顺序**：`config.js` → `jquery.js` → `utils.js` → `elementGrouper.js` → `recordManager.js` → `autoFill.js` → `uploadService.js` → `screenshotService.js` → `index.js`
- 弹窗页面通过 `chrome.windows.create` 以 `popup` 类型打开
- **截图相关配置**：`config/config.js` 中 `screenshotDownloadDirectory` 为下载子目录（只能配置相对路径），`screenshotMaxPixels` 为最终长图的像素上限
- **截图滚动与拼接**：
  - 滚动目标由 content 侧自动识别：优先普通文档滚动；当文档自身不可滚动且存在满足条件的内部滚动容器（常见于 Vue + Element UI）时，选择该容器并按其可视区域裁切拼图
  - 截图期间会禁用其它分组截图按钮，当前分组按钮显示「正在截图中 x/y」进度，并使用 `finally` 保证任务结束后恢复按钮
  - 截图完成后记得恢复页面原始滚动位置与 `scrollBehavior`
- 自动填表功能依赖外部 LLM 服务，请确保网络可访问并正确配置 API Key
- 模块间通过全局对象通信（`Recorder`、`TreeSelectHandler`、`EventMonitor`、`MessageHandler`、`RecordManager`、`AutoFillUI`、`UploadService`、`PopupManager`、`LLMService`），每个函数注释中标注了调用位置

## 设置 key 固定 extensionId

1. 通过 OpenSSL 生成私钥和公钥
2. 将公钥写入 `manifest.json` 的 `key` 字段
3. 将私钥保存在项目目录之外，禁止提交到 Git
4. 加载扩展程序

## License

MIT
