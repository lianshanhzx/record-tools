# 录制方向 · 分组截图

> [返回项目首页](../README.md)

本文档说明录制方向下分组截图（全页滚动长图）的使用方式与实现机制。该功能依赖录制分组列表，仅在录制 popup 中可用，采集模式不提供。

- 总体架构与共用机制见 [architecture.md](./architecture.md)
- 录制功能见 [recording.md](./recording.md)

---

## 使用说明

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

---

## 场景 G：分组截图（全页滚动长图）

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
  预估最终图片尺寸，超过截图像素上限（config.screenshot.maxPixels）直接报错

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
