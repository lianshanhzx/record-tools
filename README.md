# TY Record Tools

天阳录制工具 — 一款基于 Chrome Manifest V3 的浏览器扩展，用于在网页上**录制操作并生成自动化脚本**，或**静默采集测试人员的真实操作数据**供 Agent 知识库使用。

## 功能特性

- **网页操作录制**：录制点击、输入、下拉选择、日期选择、树形选择等操作，生成可回放验证的自动化脚本，详见 [录制功能](docs/recording.md)
- **操作数据采集**：以静默方式采集真实操作，生成原始 JSON 供 Agent 知识库使用；支持 iframe、页面跳转续采、接口调用监听，详见 [采集功能](docs/collect.md)
- **智能 XPath 选择器**：自动生成稳定、可读的定位路径
- **路由页面扫描**：录制过程中检测 SPA 路由和整页跳转，新页面自动扫描并形成独立的“主页面”顶层分组
- **智能自动填表**（录制方向）：基于 LLM 一句话自动填写 Element UI 表单，详见 [录制方向 · 智能自动填表](docs/auto-fill.md)
- **分组截图**（录制方向）：对录制的每个分组生成全页长截图，详见 [录制方向 · 分组截图](docs/screenshot.md)
- **录制记录列表管理**：查看、编辑、删除已录制的操作
- **回放验证**：勾选操作记录或默认回放全部记录，在当前页面验证定位器和动作执行结果
- **导出/提交**：支持下载 JSON 文件或直接提交到天阳自动化平台，字段说明见 [导出字段与数据格式](docs/export-format.md)

## 运行模式

扩展通过 `config/config.js` 中的 `APP_MODE` 控制行为：

| 模式 | 说明 |
| --- | --- |
| `record` | 仅启用录制工具，点击扩展图标打开原有录制 popup |
| `collect` | 仅启用采集工具，点击扩展图标直接开始采集 |
| `both` | 点击扩展图标先弹出选择页，可切换“录制工具”或“采集工具” |

当前仓库默认值为 `'collect'`。修改 `APP_MODE` 后需要在 `chrome://extensions` 中重新加载扩展。

## 项目结构

```
record-tools/
├── background/
│   ├── service-worker.js       # 后台入口：消息路由、模式分发、全局状态
│   ├── popupManager.js         # 弹窗窗口管理（创建/聚焦 popup）
│   ├── llmService.js           # LLM 调用服务（prompt 构建、API 调用）
│   └── collectService.js       # 采集服务：会话管理、网络监听、JSON 下载
├── content/
│   ├── content.js              # 内容脚本入口：初始化、录制生命周期管理
│   ├── recorder.js             # 录制核心：状态管理、动作解析、元素值获取
│   ├── treeSelectHandler.js    # 树形选择器处理（节点识别、弹窗检测）
│   ├── eventMonitor.js         # 事件监听（change/click 事件注册与分发）
│   ├── messageHandler.js       # 消息通信 + 截图滚动目标识别与坐标回报（content 侧消息收发）
│   ├── replayer.js             # 回放验证：定位器校验与动作执行
│   └── pageElementScannerController.js  # 页面元素扫描与页面上下文管理
├── collect/
│   ├── collector.js            # 采集内容脚本：监听用户操作并上报
│   ├── overlay.js              # 采集中悬浮标记（含计时与结束三选一）
│   ├── downloader.html         # Offscreen 下载页面
│   └── downloader.js           # Offscreen 下载逻辑
├── popup/
│   ├── index.html              # 录制弹窗页面（含分组截图弹窗列表与预览）
│   ├── index.js                # 弹窗入口：录制控制、通信工具、消息分发
│   ├── mode.html               # 双模式选择页（录制工具 / 采集工具）
│   ├── mode.js                 # 模式选择页交互
│   ├── autoFill.js             # 自动填表 UI（面板交互、日志、配置管理）
│   ├── recordManager.js        # 录制数据管理（列表渲染、过滤、编辑、分组截图入口）
│   ├── replayService.js        # 回放验证服务
│   ├── settings.js             # 设置弹窗（LLM 等配置）
│   ├── screenshotService.js    # 全页滚动截图：驱动滚动、逐屏捕获、裁切拼接、下载
│   ├── uploadService.js        # 上传/下载服务（导出 JSON、提交到平台）
│   └── index.css               # 弹窗样式
├── config/
│   ├── config.js               # 全局配置（运行模式、接口地址、截图/采集保存目录）
│   └── scannerExclude.js       # 页面扫描排除规则
├── libs/                       # 第三方/业务库
│   ├── jquery.js               # jQuery 库
│   ├── utils.js                # 通用工具函数（uuid、actionTree2Json、下载等）
│   ├── smartSelector.js        # 智能 XPath 选择器
│   ├── myXPathHelper.js        # XPath 辅助工具
│   ├── autoFormFill.js         # 自动填表核心（字段扫描、动作执行）
│   ├── elementBusinessName.js  # 元素业务名称识别
│   ├── elementGrouper.js       # 元素分组（弹窗/页签/折叠面板树形分组）
│   └── pageElementScanner.js   # 页面元素扫描器
├── icons/                      # 扩展图标
├── docs/                       # 分册文档（见下方文档导航）
└── manifest.json               # Chrome 扩展配置（Manifest V3）
```

## 文档导航

### 共用

| 文档 | 内容 |
| --- | --- |
| [总体架构与共用机制](docs/architecture.md) | 三端通信架构、消息协议、弹窗管理、自动注入、开发注意事项 |
| [导出字段与数据格式](docs/export-format.md) | 对接字段、元素扫描下载、录制/采集 id/pid 层级对比 |

### 录制方向

| 文档 | 内容 |
| --- | --- |
| [录制功能](docs/recording.md) | 录制/编辑/导出操作、录制流程、页面刷新恢复、外部系统通信 |
| [录制方向 · 智能自动填表](docs/auto-fill.md) | 自动填表与 LLM 配置、完整执行流程 |
| [录制方向 · 分组截图](docs/screenshot.md) | 全页滚动长图、滚动与拼接机制 |

### 采集方向

| 文档 | 内容 |
| --- | --- |
| [采集功能](docs/collect.md) | 采集使用说明、采集流程、采集下载 JSON 结构 |

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

## 设置 key 固定 extensionId

1. 通过 OpenSSL 生成私钥和公钥
2. 将公钥写入 `manifest.json` 的 `key` 字段
3. 将私钥保存在项目目录之外，禁止提交到 Git
4. 加载扩展程序

## License

MIT
