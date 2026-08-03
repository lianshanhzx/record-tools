# TY Record Tools

天阳录制工具 — 一款基于 Chrome Manifest V3 的浏览器录制插件，用于录制用户在网页上的操作并生成自动化脚本。

## 功能特性

- **网页操作录制**：录制点击、输入、下拉选择、日期选择、树形选择等操作
- **智能 XPath 选择器**：自动生成稳定、可读的定位路径
- **智能自动填表**：基于 LLM 一句话自动填写 Element UI 表单
- **操作列表管理**：查看、编辑、删除已录制的操作
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
│   └── messageHandler.js       # 消息通信（content 侧消息收发）
├── popup/
│   ├── index.html              # 弹窗页面
│   ├── index.js                # 弹窗入口：录制控制、通信工具、消息分发
│   ├── autoFill.js             # 自动填表 UI（面板交互、日志、配置管理）
│   ├── recordManager.js        # 录制数据管理（列表渲染、过滤、编辑）
│   ├── uploadService.js        # 上传/下载服务（导出 JSON、提交到平台）
│   └── index.css               # 弹窗样式
├── config/
│   └── config.js               # 全局配置（如接口服务器地址）
├── libs/                       # 第三方/业务库
│   ├── jquery.js               # jQuery 库
│   ├── utils.js                # 通用工具函数（uuid、action2Json、下载等）
│   ├── smartSelector.js        # 智能 XPath 选择器
│   ├── myXPathHelper.js        # XPath 辅助工具
│   ├── autoFormFill.js         # 自动填表核心（字段扫描、动作执行）
│   ├── elementBusinessName.js  # 元素业务名称识别
│   └── pageElementScanner.js   # 页面元素扫描器
├── icons/                      # 扩展图标
├── key.pem                     # 扩展私钥（自行生成）
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
3. 将 `private.pem` 重命名为 `key.pem` 并放到项目根目录

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
4. 操作会自动显示在弹窗的操作列表中
5. 录制完成后点击「终止录制」或「暂停录制」

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

## 主要消息类型

| 消息类型            | 方向                 | 说明                          |
| ------------------- | -------------------- | ----------------------------- |
| `initMonitor`       | content → background | 查询当前标签页录制状态        |
| `startRecord`       | content → background | 通知开始录制，标记标签页状态  |
| `stopRecord`        | content → background | 通知停止录制，清除标签页标记  |
| `startRecording`    | popup → content      | 开始录制                      |
| `stopRecording`     | popup → content      | 停止录制                      |
| `pauseRecording`    | popup → content      | 暂停录制                      |
| `continueRecording` | popup → content      | 继续录制                      |
| `addActionData`     | content → popup      | 添加/更新录制动作             |
| `getScannedElements`| popup → content      | 获取开始录制时扫描的页面元素  |
| `rescanElements`    | popup → content      | 重新扫描页面元素              |
| `scanFields`        | popup → content      | 扫描表单字段（自动填表）      |
| `executeActions`    | popup → content      | 执行自动填表动作              |
| `actionProgress`    | content → popup      | 自动填表单步进度通知          |
| `actionComplete`    | content → popup      | 自动填表全部完成通知          |
| `callLLM`           | popup → background   | 调用 LLM 生成填表动作         |
| `openPopup`         | content → background | 打开录制弹窗                  |
| `refresh`           | content → background | 页面加载完成后通知恢复状态    |

## 开发注意事项

- 插件基于 **Chrome Manifest V3**，请使用支持 MV3 的 Chrome 版本
- **content 脚本加载顺序**：`libs/utils.js` → `libs/autoFormFill.js` → `libs/smartSelector.js` → `libs/elementBusinessName.js` → `libs/myXPathHelper.js` → `libs/pageElementScanner.js` → `content/recorder.js` → `content/treeSelectHandler.js` → `content/eventMonitor.js` → `content/messageHandler.js` → `content/content.js`，顺序不可随意调整
- **background 脚本**：`service-worker.js` 通过 `importScripts()` 加载 `popupManager.js` 和 `llmService.js`
- **popup 脚本加载顺序**：`config.js` → `jquery.js` → `utils.js` → `recordManager.js` → `autoFill.js` → `uploadService.js` → `index.js`
- 弹窗页面通过 `chrome.windows.create` 以 `popup` 类型打开
- 自动填表功能依赖外部 LLM 服务，请确保网络可访问并正确配置 API Key
- 模块间通过全局对象通信（`Recorder`、`TreeSelectHandler`、`EventMonitor`、`MessageHandler`、`RecordManager`、`AutoFillUI`、`UploadService`、`PopupManager`、`LLMService`），每个函数注释中标注了调用位置

## 设置 key 固定 extensionId

1. 通过 OpenSSL 生成私钥和公钥
2. 将公钥写入 `manifest.json` 的 `key` 字段
3. 将私钥重命名为 `key.pem` 放在项目根目录
4. 加载扩展程序

## License

MIT
