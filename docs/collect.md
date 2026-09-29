# 采集功能

> [返回项目首页](../README.md)

本文档说明采集工具的使用方式、采集流程与采集下载 JSON 的数据结构。

- 总体架构与共用机制见 [architecture.md](./architecture.md)
- 导出字段与数据格式见 [export-format.md](./export-format.md)

---

## 使用说明

1. 确保 `APP_MODE` 为 `'collect'` 或 `'both'`
2. 在目标网页点击扩展图标（`both` 模式下选择“采集工具”）
3. 页面右上角出现红色“采集中”悬浮标记，即可开始正常操作被测系统
4. 操作结束后点击标记上的“结束”，选择：
   - **通过**：保存本次采集数据到 `collect/<时间戳>_<sessionId>.json`，`result` 为 `pass`
   - **不通过**：同样保存数据，`result` 为 `fail`
   - **废弃**：丢弃本次数据，不生成文件

悬浮标记说明：

- 默认只显示“结束”，鼠标悬停时展开 通过 / 不通过 / 废弃
- 整个悬浮区可拖动，避免遮挡被测页面
- 使用 Shadow DOM 隔离样式，不污染被测页面

采集特性：

- 页面跳转（包括 SPA 路由变化）后会自动恢复采集
- 支持 iframe 内操作采集
- 自动记录用户点击、输入、下拉选择、单选、日期选择、树形选择等有效操作
- 自动记录操作触发后短时间内的接口调用（`url`、`method`、`statusCode`）
- 保留元素业务名称，分组信息以扁平 `id/pid` 层级结构输出到 `transcationProperties`，不保留录制模式的自动扫描、表单助手、截图、回放功能

---

## 场景 H：采集流程

### H1. 开始采集

```
用户点击扩展图标（或模式选择页选择“采集工具”）
  │  chrome.action.onClicked（collect 模式）
  │  或 startCollectTool（both 模式）
  ▼
Background (collectService.js)
  │  CollectService.startCollect(tabId)
  │    ├─ 创建会话（sessionId、startTime、actions[]、networkRequests[]）
  │    ├─ chrome.tabs.sendMessage(tabId, { type: 'collectStarted' })
  │    └─ 持久化到 chrome.storage.session
  ▼
Content (collect/collector.js) — 所有 frame
  │  收到 collectStarted → 注册 change/click 监听
  │  顶层 frame 调用 CollectOverlay.show() 显示红色标记
```

### H2. 采集动作上报

```
用户操作页面
  │  collect/collector.js 捕获 change/click
  │    → 生成动作（XPath、业务名称、分组、objectValue、timestamp）
  │    → chrome.runtime.sendMessage({ type: 'collectAction', action })
  ▼
Background (collectService.js)
  │  CollectService.addAction(tabId, frameId, action)
  │    ├─ 分配全局 seq
  │    ├─ 关联时间窗口内的网络请求
  │    └─ 追加到 session.actions
```

### H3. 接口调用监听

```
页面发起 xhr/fetch 请求
  │  chrome.webRequest.onCompleted
  ▼
Background (collectService.js)
  │  CollectService.addNetworkRequest(details)
  │    ├─ 过滤非目标标签页和扩展自身请求
  │    └─ 保留 { requestId, url, method, statusCode, timestamp, frameId }
```

### H4. 结束采集并下载

```
用户点击悬浮标记“结束”
  │  选择 通过 / 不通过 / 废弃
  ▼
Content (collect/overlay.js)
  │  chrome.runtime.sendMessage({ type: 'collectEnd', result })
  ▼
Background (collectService.js)
  │  CollectService.endCollect(tabId, result)
  │    ├─ pass/fail：组装 JSON（`transcationProperties` 为扁平分组 + 操作节点，通过 `propertiesID`/`propertiesPID` 表达层级）→ 通过 offscreen document 下载到 collect/ 目录
  │    └─ discard：清空会话，不下载
  │  chrome.tabs.sendMessage(tabId, { type: 'collectStopped' })
  ▼
Content
  │  停止监听并隐藏标记
```

> **页面跳转续采**：会话状态保存在 Background + `chrome.storage.session`，新页面加载后各 frame 发送 `collectInit` 查询，若会话仍在采集中则自动恢复监听和标记。

> **标签页关闭**：会话未结束时标签页被关闭，数据会以 `result: "interrupted"` 下载保存。

---

## 采集数据格式

下载文件的顶层结构：

```json
{
  "id": "<uuid>",
  "name": "collect",
  "url": "<采集起始页 URL>",
  "sessionId": "<uuid>",
  "extensionVersion": "1.1",
  "mode": "collect",
  "result": "pass",
  "startedAt": 1699999999999,
  "endedAt": 1700000000000,
  "targetTab": { "tabId": 123, "url": "https://example.test/page", "title": "示例页面" },
  "pageConfig": { "组件编号": "ZJJK00066153" },
  "transcationProperties": [ /* 分组节点 + 操作节点，扁平列表 */ ]
}
```

### 层级结构

`transcationProperties` 是一个扁平数组，分组节点与操作节点混排，通过 `propertiesID` / `propertiesPID` 表达父子关系（与录制导出的层级表达方式一致）。

- **分组节点**：`type` 为 `page` / `dialog` / `tab` / `collapse`。
- **操作节点**：`type` 为 `ele`。
- 顶层分组的 `propertiesPID` 为 `null`；其余节点指向父分组的 `propertiesID`。

分组节点示例：

```json
{
  "propertiesID": "<uuid>",
  "propertiesPID": null,
  "type": "page",
  "propertiesName": "主页面",
  "key": "__page__:https%3A%2F%2Fexample.test%2Fpage",
  "url": "https://example.test/page"
}
```

操作节点示例：

```json
{
  "propertiesID": "<uuid>",
  "propertiesPID": "<父分组 propertiesID>",
  "type": "ele",
  "clientId": "<采集端唯一 id>",
  "seq": 1,
  "timestamp": 1699999999999,
  "eventTypeValue": "click",
  "eventTypeName": "点击",
  "xpath": "//button[normalize-space()='查询']",
  "mothed": "By.XPATH",
  "transcationType": "playwright",
  "tagName": "button",
  "propertiesName": "查询",
  "realLabel": "查询",
  "objectValue": "",
  "options": [],
  "attributes": { "id": "search", "class": "el-button" },
  "frameId": 0,
  "networkCalls": [
    {
      "requestId": "12345.67",
      "timestamp": 1699999999999,
      "frameId": 0,
      "method": "POST",
      "url": "https://example.test/api/query",
      "statusCode": 200,
      "type": "xmlhttprequest",
      "fromCache": false
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `propertiesID` | 本次下载结果内的节点唯一 ID（UUID） |
| `propertiesPID` | 父分组的 `propertiesID`，顶层为 `null` |
| `type` | 分组类型 `page` / `dialog` / `tab` / `collapse`，操作节点固定为 `ele` |
| `propertiesName` | 分组显示名或元素业务名称；同名分组会追加 `_1`、`_2` 后缀去重 |
| `key` | 分组的稳定标识（由 `ElementGrouper` 生成，如分组容器 XPath），仅分组节点有 |
| `url` | 页面分组的 URL，仅 `page` 分组有；其他分组为空字符串 |
| `eventTypeValue` / `eventTypeName` | 操作类型值 / 中文名 |
| `xpath` | 元素定位路径 |
| `objectValue` | 操作后的取值（下拉框多选时为逗号拼接） |
| `options` | 下拉框选项列表（仅下拉类操作，且只取当前可见面板） |
| `attributes` | 元素属性白名单内的属性（见 `config/config.js` 的 `attributesAllowlist`） |
| `frameId` | 动作所在 frame；`0` 表示顶层页面 |
| `networkCalls` | 该动作触发后时间窗口内关联到的接口调用 |

### 分组命名与去重

- `propertiesName` 在采集时由 `ElementGrouper.getGroupPath(element)` 依据 DOM 计算：
  - `page`：应用面包屑名称，取不到时用 `主页面`
  - `dialog`：弹窗标题（`aria-labelledby` / `.el-dialog__title` 等），取不到时用 `弹窗`
  - `tab`：页签名称，取不到时用 `页签`
  - `collapse`：折叠面板标题，取不到时用 `折叠面板`
- 下载时全局去重：名称中的 `/` 替换为 `或`，重复名称追加 `_1`、`_2`…
- `propertiesID` 为随机 UUID，与名称无关；分组身份判断使用 `key`。

### 其他说明

- `pageConfig` 在采集开始页扫描「天元相关配置」弹窗得到，只在会话首次写入时记录（以开始页为准）。
- `networkCalls` 的关联时间窗口由 `config/config.js` 的 `collect.networkAssociateMs` 控制（默认 1000ms）。
- 采集字段与录制导出的对比见 [export-format.md](./export-format.md)。
