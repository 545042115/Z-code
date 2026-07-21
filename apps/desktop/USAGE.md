# Ziner Desktop — 使用说明

## 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 (x64) |
| Node.js | ≥ 18.x |
| npm | ≥ 9.x |
| 网络 | 首次运行需下载 Electron 二进制 (~150MB) |

---

## 快速启动

```powershell
# 1. 在仓库根目录安装依赖
cd F:\Z-code
npm install

# 2. 构建所有 workspace 依赖（contracts → vscode-connector → desktop）
npm run build -w apps\vscode-connector
npm run build -w apps\desktop

# 3. 启动 Desktop 桌面应用
node node_modules\electron\cli.js apps\desktop
```

> **注意**：`node_modules\electron\cli.js` 需要 Electron 二进制文件就位。
> 如果报错 `Electron failed to install correctly`，执行：
> ```powershell
> $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
> node node_modules\electron\install.js
> ```

---

## 首次启动设置

应用默认使用 **中文界面** 和 **SGLang** 提供商。启动后在 **Settings** 面板中：

### 1. 切换语言

- 打开 Settings → **语言/Language** 下拉框
- 选择 **中文** 或 **English**
- 切换后立即生效，无需重启

### 2. 配置模型

Settings → **模型/Model** 面板：

| 字段 | 说明 |
|---|---|
| **提供商** | SGLang / OpenAI / Anthropic / **DeepSeek** / **Google Gemini** / Ollama / 自定义(兼容 OpenAI) |
| **模型名称** | 模型 ID，例如 `deepseek-chat`、`gpt-4`、`claude-3-5-sonnet` |
| **API 密钥** | 对应提供商的 API Key（保存后不会明文显示） |
| **API 端点** | 自定义 API 地址（仅自定义提供商需要修改） |

### 3. 保存设置

点击 **"保存/Save"** 按钮，状态栏会显示 `Settings saved.` 或中文 `设置已保存。`

---

## 界面功能

### 面板说明

| 面板 | 导航按钮 | 功能 |
|---|---|---|
| **主页** | Main / 主页 | 欢迎页，导航入口 |
| **对话** | Chat / 对话 | 输入任务 → 发送 → 查看 AI 回复 |
| **追踪** | Trace / 追踪 | 查看历史运行记录、Span 调用树 |
| **设置** | Settings / 设置 | 语言、模型、记忆、存储目录配置 |

### Chat 面板

1. 在文本框中输入请求
2. 按 **Enter** 发送（**Shift+Enter** 换行）
3. 系统返回任务 ID（`Task submitted. Run ID: xxx`）
4. 切换到 **Trace** 面板查看执行详情

### Trace 面板

- 顶部显示最近的运行记录列表（最多 50 条）
- 点击任意记录 → 下方展开详细 **Span 树**（每个步骤的名称、耗时、输入输出）
- 点击 **Refresh / 刷新** 按钮重新加载

### Settings 面板

| 设置项 | 说明 |
|---|---|
| **语言** | 中文 / English，立即生效 |
| **模型** | 提供商 + 模型名称 + API Key + 端点 |
| **记忆** | ✅ 启用长期记忆（默认开启，需要 V2 Runtime 支持） |
| **存储** | 数据目录（只读显示） |

---

## 全局快捷键

| 快捷键 | 功能 |
|---|---|
| **Ctrl+Shift+Z** | 显示/隐藏 Ziner 窗口 |

---

## 打包为安装包

生成可分发的 Windows 安装程序：

```powershell
.\tools\package-desktop.ps1
```

产物：`apps\desktop\dist\Ziner-*-win-x64.exe`

---

## 常见问题

### Q: 启动后看不到窗口？

```powershell
# 检查是否有残留进程
taskkill /f /im electron.exe 2>$null
# 重新启动
node node_modules\electron\cli.js apps\desktop
```

### Q: Electron 下载失败 / 网络慢？

设置国内镜像后重新安装：
```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
node node_modules\electron\install.js
```

### Q: 点关闭按钮应用退出了？

`window-all-closed` 事件配置为 Windows/macOS 上保持系统托盘运行。
如需改为关闭即退出，修改 `main.ts` 中的 `window-all-closed` 回调。

---

## 开发命令速查

| 命令 | 说明 |
|---|---|
| `npm run build -w apps\desktop` | 构建 Desktop（含 renderer 打包） |
| `npm run start -w apps\desktop` | 构建 + 启动 |
| `npm run test -w apps\desktop` | 运行单元测试 |
| `npm run package -w apps\desktop` | 打包为安装包 |
| `node node_modules\electron\cli.js apps\desktop` | 直接启动（不重新构建） |

---

## 目录结构

```
apps/desktop/
├── src/
│   ├── main.ts              # 主进程入口
│   ├── preload.ts           # contextBridge 预加载
│   ├── runtime-bridge.ts    # V2 Runtime 桥接
│   ├── tray.ts              # 系统托盘
│   ├── hotkey.ts            # 全局快捷键
│   ├── updater.ts           # 自动更新
│   ├── license.ts           # 许可管理
│   ├── constants.ts         # 常量定义
│   └── renderer/
│       ├── index.html       # HTML 模板
│       ├── styles.css       # 全局样式（深色主题）
│       ├── index.ts         # Renderer 入口
│       ├── chat.ts          # 对话面板
│       ├── trace.ts         # 追踪面板
│       ├── settings.ts      # 设置面板（含语言/模型配置）
│       └── i18n.ts          # 国际化（中文/English）
├── build/
│   └── electron-builder.json # 打包配置
└── package.json
```
