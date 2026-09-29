# 总体架构与共用机制

> [返回项目首页](../README.md)

本文档说明录制与采集共用的三端通信架构、消息协议、弹窗管理、自动注入机制与开发注意事项。

- 录制功能见 [recording.md](./recording.md)
- 采集功能见 [collect.md](./collect.md)
- 导出数据格式见 [export-format.md](./export-format.md)

---

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
         └────────────────────┴──────────────────────────┘
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
| `getPopupTargetTab` | Popup → Background | `runtime.sendMessage` | 异步响应 | 获取录制来源标签页 |
| `prepareFullPageScreenshot` | Popup → Content | `tabs.sendMessage` | 同步响应 | 截图准备：识别滚动目标、保存原始滚动位置、返回页面几何 |
| `scrollForScreenshot` | Popup → Content | `tabs.sendMessage` | 异步响应 | 截图滚动：滚动到指定位置并回报实际位置/容器几何（延迟响应等待布局稳定） |
| `restoreScrollAfterScreenshot` | Popup → Content | `tabs.sendMessage` | 同步响应 | 恢复页面原始滚动位置与 scrollBehavior |
| `captureVisibleTabForScreenshot` | Popup → Background | `runtime.sendMessage` | 真正异步响应 | 捕获当前可视区截图并返回 dataUrl |
| `trackScreenshotDownload` | Popup → Background | `runtime.sendMessage` | 异步响应 | 记录截图下载 ID，用于后续清理 |
| `untrackScreenshotDownload` | Popup → Background | `runtime.sendMessage` | 异步响应 | 移除已清理截图对应的下载 ID |
| `startRecordTool` / `startCollectTool` | 模式选择页 → Background | `runtime.sendMessage` | 异步响应 | 双模式下由选择页启动对应工具 |
| 外部消息 | 外部扩展 → Background | `onMessageExternal` | 无响应 | 接收外部数据并打开弹窗 |

采集相关消息：

| 消息类型 | 方向 | 通信 API | 响应方式 | 说明 |
|---|---|---|---|---|
| `collectInit` | Content → Background | `runtime.sendMessage` | 异步响应 | 页面加载时查询当前标签是否处于采集会话 |
| `collectAction` | Content → Background | `runtime.sendMessage` | 异步响应 | 上报一条采集动作 |
| `collectActionUpdate` | Content → Background | `runtime.sendMessage` | 异步响应 | 合并更新已有动作（如下拉框选项、实际取值） |
| `collectPageConfig` | Content → Background | `runtime.sendMessage` | 异步响应 | 上报开始页的「天元相关配置」弹窗内容 |
| `collectEnd` | Content → Background | `runtime.sendMessage` | 异步响应 | 结束采集并选择结果（pass/fail/discard） |
| `collectStarted` | Background → Content | `tabs.sendMessage` | 无响应(广播) | 通知所有 frame 开始采集 |
| `collectStopped` | Background → Content | `tabs.sendMessage` | 无响应(广播) | 通知所有 frame 停止采集 |
| `collectPing` | Background → Content | `tabs.sendMessage` | 无响应 | 会话已存在时的提示（可选） |
| `collectDownloadJson` | Background → Offscreen | `runtime.sendMessage` | 异步响应 | 通过 offscreen document 下载 JSON |

> **注**：`addActionData`、`actionProgress`、`actionComplete` 为高频广播消息，Background 端做了短路返回优化（`SKIP_IN_BG`），避免无效分支遍历。

> **响应方式说明**：
> - **同步响应**：监听器 `return true` 但 `sendResponse` 在同步逻辑后立即调用，等效于同步
> - **真正异步响应**：`sendResponse` 在 Promise resolve 后调用（如 `callLLM` 等待网络请求）
> - **无响应(广播)**：发送方不等待响应（fire-and-forget），消息会被所有 `onMessage` 监听器接收

---

## 场景 D：弹窗管理

扩展图标点击与外部消息都会经过 Background 分发，具体行为取决于 `APP_MODE`：

- `record`：打开录制 popup。
- `collect`：直接在当前标签页开始采集（不打开 popup）。
- `both`：打开模式选择页 `popup/mode.html`，由用户选择后通过 `startRecordTool` / `startCollectTool` 启动。

```
用户点击扩展图标 或 外部系统触发
  │  chrome.action.onClicked / chrome.runtime.onMessageExternal
  ▼
Background (service-worker.js)
  │  读取 APP_MODE 分发：
  │    ├─ record  → PopupManager.openOpertePopup()
  │    ├─ collect → CollectService.startCollect(tabId)
  │    └─ both    → openModeChooser(tabId) → 打开 popup/mode.html
  ▼
PopupManager.openOpertePopup()
  │    ├─ chrome.windows.getAll() → 检查是否已有 popup 窗口
  │    ├─ 若无 → chrome.windows.create({ url: 'popup/index.html', type: 'popup' })
  │    └─ 若有 → chrome.windows.update(popup.id, { focused: true })
```

---

## 场景 I：已清理的无效通道

以下消息类型在代码中存在监听处理但从未被发送，已在重构中清理：`ping`、`logToConsole`、`rescanElements`、`openPopup`、`checkFlag`、`execute`、`start`、`refresh`（Background 侧 handler）。

> 清理后的 Background 除录制相关消息外，还处理采集消息：`collectInit` / `collectAction` / `collectActionUpdate` / `collectPageConfig` / `collectEnd` / `collectDownloadJson`，以及录制消息 `stopRecord` / `startRecord` / `initMonitor` / `getPopupTargetTab` / `callLLM` / `captureVisibleTabForScreenshot` / `trackScreenshotDownload` / `untrackScreenshotDownload`。
>
> 另外 `collectService.js` 仍保留 `collectStart` 消息处理，但当前启动采集统一走 `chrome.action.onClicked` 或 `startCollectTool`，该分支未被使用。

---

## sendToContent 自动注入机制

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

> **采集侧**：`background/service-worker.js` 的 `ensureContentScriptsInjected()` 会注入完整脚本列表（含 `/collect/collector.js`、`/collect/overlay.js`），用于扩展加载前已打开的页面。

---

## 通信设计要点

1. **广播消息的短路优化**：`addActionData`、`actionProgress`、`actionComplete` 采用 fire-and-forget 广播模式。Background 端通过 `SKIP_IN_BG` 数组在 listener 入口处短路返回，避免高频消息穿透所有分支后无效丢弃。

2. **`return true` 的普遍使用**：Content Script 和 Background 的所有 `onMessage` 监听器都返回 `true`，保持消息通道为异步模式。但大多数情况下 `sendResponse` 是立即调用的（等效同步），只有 `callLLM` 是真正的异步等待（等待网络请求）。

3. **消息命名约定**：录制控制消息使用 `xxxRecording`（如 `startRecording`），由 Popup 通过 `tabs.sendMessage` 发送给 Content；录制状态通知使用 `xxxRecord`（如 `startRecord`、`stopRecord`），由 Content 通过 `runtime.sendMessage` 广播给 Background 和 Popup。

---

## 开发注意事项

- 插件基于 **Chrome Manifest V3**，请使用支持 MV3 的 Chrome 版本
- **content 脚本加载顺序**：`config/config.js` → `libs/utils.js` → `libs/autoFormFill.js` → `libs/smartSelector.js` → `libs/elementBusinessName.js` → `libs/myXPathHelper.js` → `config/scannerExclude.js` → `libs/elementGrouper.js` → `libs/pageElementScanner.js` → `content/recorder.js` → `content/treeSelectHandler.js` → `content/eventMonitor.js` → `content/messageHandler.js` → `content/replayer.js` → `content/pageElementScannerController.js` → `content/content.js` → `collect/collector.js` → `collect/overlay.js`，顺序不可随意调整
- **background 脚本**：`service-worker.js` 通过 `importScripts()` 加载 `config/config.js`、`popupManager.js`、`llmService.js` 和 `collectService.js`
- **popup 脚本加载顺序**：`config.js` → `jquery.js` → `utils.js` → `elementGrouper.js` → `recordManager.js` → `replayService.js` → `settings.js` → `autoFill.js` → `uploadService.js` → `screenshotService.js` → `index.js`
- 弹窗页面通过 `chrome.windows.create` 以 `popup` 类型打开
- **权限说明**：采集功能依赖 `webRequest`（接口监听）和 `offscreen`（MV3 下生成下载 blob）；`host_permissions` 保持 `<all_urls>` 以支持跨域页面和 iframe
- **截图相关配置**：`config/config.js` 中 `screenshot.downloadDirectory` 为下载子目录（只能配置相对路径），`screenshot.maxPixels` 为最终长图的像素上限
- **采集相关配置**：`config/config.js` 中 `collect.downloadDirectory` 固定为 `collect`，`attributesAllowlist` 控制元素属性白名单，`networkAssociateMs` 控制动作与网络请求的时间关联窗口，`captureIframes` 控制是否采集 iframe 内操作
- **截图滚动与拼接**：
  - 滚动目标由 content 侧自动识别：优先普通文档滚动；当文档自身不可滚动且存在满足条件的内部滚动容器（常见于 Vue + Element UI）时，选择该容器并按其可视区域裁切拼图
  - 截图期间会禁用其它分组截图按钮，当前分组按钮显示「正在截图中 x/y」进度，并使用 `finally` 保证任务结束后恢复按钮
  - 截图完成后记得恢复页面原始滚动位置与 `scrollBehavior`
- 自动填表功能依赖外部 LLM 服务，请确保网络可访问并正确配置 API Key
- 模块间通过全局对象通信（`Recorder`、`TreeSelectHandler`、`EventMonitor`、`MessageHandler`、`RecordManager`、`AutoFillUI`、`UploadService`、`PopupManager`、`LLMService`、`Collector`、`CollectService`），每个函数注释中标注了调用位置
