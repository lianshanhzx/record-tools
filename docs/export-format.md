# 导出字段与数据格式

> [返回项目首页](../README.md)

本文档说明元素扫描、人工录制与下载 JSON 使用的对接字段，以及录制与采集两种扁平层级结构的差异。

- 总体架构与共用机制见 [architecture.md](./architecture.md)
- 录制功能见 [recording.md](./recording.md)
- 采集功能见 [collect.md](./collect.md)

---

## 场景 F：元素扫描与下载

扫描、人工录制以及下载 JSON 使用同一套对接字段：

| 字段 | 说明 |
| --- | --- |
| `propertiesID` | 元素或分组的 UUID |
| `propertiesPID` | 父分组的 `propertiesID`，顶层为 `null` |
| `type` | 分组为 `page` / `dialog` / `tab` / `collapse`；操作元素固定为 `ele` |
| `propertiesName` | 元素业务名称或分组实际名称 |
| `eventTypeValue` | `click` / `input` / `select:click` / `select:tree` / `radio` / `date` |
| `eventTypeName` | 点击 / 输入 / 下拉框选择 / 树形选择 / 单选 / 日期 |
| `elementType` | 元素记录取 `target`，分组固定为空字符串 |
| `mothed` | 元素固定为 `By.XPATH`，分组固定为空字符串 |
| `target` | 元素定位路径（XPath），仅操作元素有 |
| `objectValue` | 原元素 `value` 字段 |
| `options` | 下拉框选项列表，分组固定为空字符串 |
| `transcationType` | 固定为 `playwright` |
| `realLabel` | 按关联 label、上层表单项、ARIA、属性等页面原始信息提取，不追加识别后缀；分组固定为空字符串 |
| `rect` | 元素位置，序列化后的 JSON 字符串；分组固定为 `"{}"` |
| `attr` | 元素属性集合（`attributes`），仅操作元素有 |
| `positionStatus` | 截图位置状态，如 `captured` / `not-captured` |
| `key` | 分组稳定标识（元素 XPath），仅分组节点有 |
| `url` | 页面分组的 URL，仅 `page` 分组有 |
| `screenCapture` | 分组截图地址数组，仅分组节点有 |

`propertiesName` 用于业务识别，允许追加按钮文本或人工去重后缀；`realLabel` 只保留页面标签查找链路得到的原始文本，不追加这些识别内容。

下载结果中的分组节点使用随机 UUID，并通过 `propertiesPID` 关联父分组。内部用于 XPath、截图和折叠状态的分组 `key` 不作为分组 ID（但会作为独立字段导出）。录制导出的分组节点固定包含以下对接字段：

```json
{
  "propertiesID": "<uuid>",
  "propertiesPID": null,
  "type": "page",
  "key": "__page__:https%3A%2F%2Fexample.test%2Fpage",
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
  "rect": "{}",
  "url": "https://example.test/page",
  "screenCapture": []
}
```

元素的 `rect` 是 `JSON.stringify` 后的字符串，其中 `x1/y1` 表示左上角位置，`x2/y2` 表示右下角位置：

```json
{ "rect": "{\"x1\":100,\"y1\":200,\"x2\":300,\"y2\":240}" }
```

### F1. 获取已扫描元素

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

## 录制与采集的层级结构对比

两种导出都用“扁平数组 + `propertiesID`/`propertiesPID`”表达层级，区别在于节点字段：

| 方面 | 录制导出 | 采集导出 |
| --- | --- | --- |
| 顶层容器 | `transcationProperties`（含 `id` / `name` / `pageId` / `url`） | `transcationProperties`（含 `sessionId` / `result` / `targetTab` / `pageConfig` 等会话信息） |
| 分组节点字段 | 完整对接字段（含 `eventTypeValue`、`elementType`、`rect`、`key`、`screenCapture` 等占位字段） | 精简字段：`propertiesID` / `propertiesPID` / `type` / `propertiesName` / `key` / `url` |
| 操作节点身份 | `type: "ele"` | `type: "ele"` |
| 操作定位字段 | `target` | `xpath` |
| 采集调试信息 | 无 | `clientId` / `seq` / `timestamp` / `frameId` / `networkCalls` |
| 分组去重 | 全局追加 `_1`、`_2` | 全局追加 `_1`、`_2` |

> 采集分组的详细结构和示例见 [collect.md](./collect.md)。
