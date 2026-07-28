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
│   └── service-worker.js      # 后台服务：窗口管理、消息路由、LLM 调用
├── content/
│   ├── content.js             # 内容脚本：录制核心逻辑
│   └── content.css            # 录制相关页面样式
├── popup/
│   ├── index.html             # 弹窗页面
│   ├── index.js               # 弹窗逻辑：录制控制、列表展示、自动填表、提交
│   └── index.css              # 弹窗样式
├── config/
│   └── config.js              # 全局配置（如接口服务器地址）
├── shared/
│   └── utils.js               # 共享工具函数
├── libs/                      # 第三方/业务库
│   ├── jquery.js
│   ├── smartSelector.js       # 智能 XPath 选择器
│   ├── myXPathHelper.js       # XPath 辅助工具
│   ├── autoFormFill.js        # 自动填表核心
│   ├── elementBusinessName.js # 元素业务名称识别
│   └── getLabel.js            # 元素可读标签识别
├── icons/                     # 扩展图标
├── key.pem                    # 扩展私钥（自行生成）
└── manifest.json              # Chrome 扩展配置
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

| 消息类型            | 方向               | 说明              |
| ------------------- | ------------------ | ----------------- |
| `startRecording`    | popup → content    | 开始录制          |
| `stopRecording`     | popup → content    | 停止录制          |
| `pauseRecording`    | popup → content    | 暂停录制          |
| `continueRecording` | popup → content    | 继续录制          |
| `addActionData`     | content → popup    | 添加/更新录制动作 |
| `scanFields`        | popup → content    | 扫描表单字段      |
| `executeActions`    | popup → content    | 执行自动填表动作  |
| `callLLM`           | popup → background | 调用 LLM          |

## 开发注意事项

- 插件基于 **Chrome Manifest V3**，请使用支持 MV3 的 Chrome 版本
- 内容脚本通过 `manifest.json` 注入，顺序不可随意调整
- 弹窗页面通过 `chrome.windows.create` 以 `popup` 类型打开
- 自动填表功能依赖外部 LLM 服务，请确保网络可访问并正确配置 API Key

## 设置key固定 extendsID
1. 通过 openSSL 生成 私钥和公钥 
2. 将公钥写入mainfest.json 的key里面
3. 将私钥重命名成key.pem 放在文件里面
4. 加载扩展程序

## License

MIT
