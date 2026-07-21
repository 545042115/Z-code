# Ziner Desktop

V2 独立桌面应用宿主，将 V2 Assistant Runtime 包装成可安装的跨平台程序。  
内置 **AI 自动回复**能力，支持 **微信**（WeChatFerry DLL 注入）和 **QQ**（NapCat + OneBot 协议）。

## 功能总览

| 功能 | 说明 | 状态 |
|------|------|------|
| 💬 **Chat 面板** | 与 AI 对话，支持多会话、流式输出、Markdown 渲染 | ✅ |
| 📊 **Trace 面板** | 查看 AI 运行追踪日志 | ✅ |
| ⚙️ **Settings 面板** | 配置 LLM、微信、QQ 等服务 | ✅ |
| 💚 **微信自动回复** | 通过 WeChatFerry DLL 注入捕获微信消息，AI 自动回复好友私聊和群聊 @消息 | ✅ |
| 💙 **QQ 自动回复** | 通过 NapCat + OneBot v11 WebSocket 接收 QQ 消息，AI 自动回复好友私聊和群聊 @消息 | ✅ |
| 🎭 **聊天风格模仿** | 自动收集对话双方的消息，分析说话风格并让 AI 模仿 | ✅ |
| 🖥️ **System Tray** | 系统托盘，后台运行 | ✅ |
| ⌨️ **Global Hotkey** | 全局快捷键 `Ctrl+Shift+Z` 唤出 | ✅ |
| 🔄 **Auto Update** | electron-updater 自动更新 | ✅ |

## 架构

```text
┌────────────────────────────────────────────────────────────────┐
│ Settings UI                                                     │
│   ┌────────────┐   ┌────────────────┐   ┌─────────────────┐   │
│   │ LLM 配置   │   │ 微信 Hook 配置 │   │ QQ OneBot 配置  │   │
│   │ (模型/Key) │   │ (昵称/连接/断开)│   │ (WS地址/Token)  │   │
│   └─────┬──────┘   └───────┬────────┘   └────────┬────────┘   │
└─────────┼──────────────────┼─────────────────────┼─────────────┘
          │ IPC              │ IPC                  │ IPC
┌─────────▼──────────────────▼─────────────────────▼─────────────┐
│ Main Process (Electron)                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              VSCodeConnector (Bridge)                    │  │
│  │  ┌──────────────────┐  ┌────────────────────────────┐   │  │
│  │  │ WeChatHookService │  │  QQOneBotService           │   │  │
│  │  │ (WeChatFerry)     │  │  (NapCat WebSocket)        │   │  │
│  │  └────────┬─────────┘  └───────────┬────────────────┘   │  │
│  │           │ DLL 注入               │ WebSocket            │  │
│  │           ▼                         ▼                     │  │
│  │  ┌────────────────────────────────────────────┐          │  │
│  │  │         ChatAgent + LLM Provider           │          │  │
│  │  │  (DeepSeek / OpenAI / SGLang / 等)          │          │  │
│  │  └────────────────────────────────────────────┘          │  │
│  │  ┌────────────────────────────────────────────┐          │  │
│  │  │         ChatProfile (风格模仿)              │          │  │
│  │  │  自动收集对话双方消息 → 分析说话风格 → 注入 Prompt  │  │
│  │  └────────────────────────────────────────────┘          │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 消息处理流程

```
好友发消息 → WeChatFerry DLL / NapCat WebSocket
    → Hook Service 接收
    → 群聊检测 @提及（仅 @你时回复）
    → 任务队列（避免并发冲突）
    → ChatAgent.runTask(msg.text)
    → LLM 生成回复
    → Hook Service 发送回复
    → ChatProfile 收集双方对话
```

## 微信自动回复（WeChatFerry Hook）

### 原理
通过 DLL 注入微信 Windows 客户端进程（`WeChat.exe`），由 WeChatFerry 的 `sdk.dll` 拦截微信的内部消息回调，实现：
- 实时捕获收到的消息（好友私聊 + 群聊）
- 调用 AI 生成回复并通过 DLL 发送
- 捕获自己手动发送的消息用于风格分析

### 环境要求

| 条件 | 要求 |
|------|------|
| 操作系统 | Windows 64-bit |
| 微信版本 | **3.9.12.17**（必需，WeChatFerry 针对此版本编译） |
| 微信状态 | 已登录（扫码登录） |

### 使用步骤

1. **安装微信 3.9.12.17**（其他版本 DLL 注入会失败）
2. 打开并登录微信
3. 在 Ziner Settings → 微信卡片 → 点击 **连接微信**
4. 填写**微信昵称**（用于群聊 @检测，选填）
5. 连接成功后，好友发消息会自动回复
6. 可在 Settings 面板查看消息数和状态

### 注意事项

> ⚠️ **封号风险**：WeChatFerry 通过 DLL 注入修改微信进程，违反微信用户协议。建议使用**小号**，大号封禁风险自负。
> 
> WeChatFerry 仅在消息进入微信客户端时触发回复，**不区分是否已读**。

## QQ 自动回复（NapCat + OneBot）

### 原理
通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 注入 QQ 进程，暴露 OneBot v11 WebSocket 接口。Ziner 作为 WebSocket 客户端连接 NapCat：
- 接收 QQ 消息推送（好友私聊 + 群聊）
- 调用 AI 生成回复并通过 WebSocket 发送

### 环境要求

| 条件 | 要求 |
|------|------|
| NapCat | 已启动并配置 OneBot WebSocket 服务 |
| QQ | 已登录（NapCat 自动复用 QQ 登录状态） |

### 使用步骤

1. **下载并启动 [NapCat](https://github.com/NapNeko/NapCatQQ)**
2. 在 NapCat 管理面板（默认 `http://127.0.0.1:6099/webui`）配置 **OneBot WebSocket 服务端**
   - 设置端口（如 `6009` 或 `3001`）
   - 设置 `accessToken`（可选）
   - 保存并重启 NapCat
3. 在 Ziner Settings → QQ 卡片：
   - **WebSocket 地址**：如 `ws://127.0.0.1:6009`
   - **Access Token**：与 NapCat 配置一致（可选）
   - **QQ 昵称**：用于群聊 @检测（选填）
4. 点击 **连接 QQ**
5. 连接成功后，好友发消息会自动回复

### 验证 NapCat 正常运行

NapCat 启动日志应包含类似行：
```
[NapCat] [OneBot] WebSocket Server started on port 6009
```
并在 NapCat WebUI 管理面板中确认 WebSocket 服务状态为「运行中」。

## 聊天风格模仿（ChatProfile）

### 原理
自动收集对话双方（你和好友）的消息文本，分析以下特征生成风格描述：
- 平均句子长度
- 常用表情符号
- 常用开头和收尾用语
- 整体风格描述

风格描述作为系统提示的一部分注入 LLM，让 AI 回复更贴近你的说话习惯。

### 数据收集范围

| 消息方向 | 是否收集 | 用途 |
|---------|---------|------|
| 好友发来的消息 | ✅ | 分析对话上下文 |
| AI 自动回复的内容 | ✅ | 保持 AI 语气一致 |
| 你自己手动发的消息 | ✅（微信） | 直接学习你的风格 |

收集的消息存储在 `chat-profile.json`，最多保留 500 条，每 10 条重新生成风格描述。

## 进程模型

```text
┌─────────────────────────────────────────────────────────────┐
│ Main Process (Node)                                         │
│  - app lifecycle                                            │
│  - system tray / global hotkey                              │
│  - VSCodeConnector (WeChat Hook / QQ OneBot / ChatAgent)    │
└──────────────┬──────────────────────────────────────────────┘
               │ IPC (z:start-wechat-hook, z:start-qq, ...)
┌──────────────▼──────────────────────────────────────────────┐
│ Preload Script (safe bridge)                                │
│  - exposes `window.zApi` to renderer                        │
│  - startWeChatHook / stopWeChatHook / getWeChatHookStatus   │
│  - startQQ / stopQQ / getQQStatus                           │
│  - startTask / stopTask / runTask / getStatus               │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│ Renderer Process (Chromium)                                 │
│  - Chat UI                                                  │
│  - Trace UI                                                 │
│  - Settings UI (LLM / WeChat / QQ 配置)                     │
└─────────────────────────────────────────────────────────────┘
```

## 目录结构

```
apps/desktop/
  src/
    main.ts              # Electron main entry
    preload.ts           # contextBridge API
    runtime-bridge.ts    # spawn VSCodeConnector
    session-manager.ts   # 会话管理
    tray.ts              # system tray
    hotkey.ts            # global shortcut
    constants.ts         # window names, IPC channels
    renderer/
      index.html
      index.ts           # renderer bootstrap
      chat.ts            # chat panel logic
      trace.ts           # trace panel logic
      settings.ts        # settings panel logic (LLM/微信/QQ 配置)
      styles.css
      i18n.ts            # 国际化文本
  build/
    electron-builder.json # electron-builder 配置
  package.json
```

## 可用脚本

- `npm run build` — 编译主进程与预加载脚本（TypeScript）
- `npm run start` — 启动 Electron 开发模式
- `npm run package` — 使用 electron-builder 打包当前平台安装包
- `npm run typecheck` — 类型检查
- `npm run test` — 运行主进程单元测试

## 后端接口

Desktop 通过 `apps/vscode-connector` 的 `VSCodeConnector` 以库方式调用，复用其：
- `startWeChatHook` / `stopWeChatHook` — 微信消息监听与自动回复
- `startQQ` / `stopQQ` — QQ 消息监听与自动回复
- `runTask` / `stopTask` — AI 对话与任务执行
- `ChatProfile` — 聊天风格收集与分析
