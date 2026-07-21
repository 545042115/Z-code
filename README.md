# Ziner

> 一个跨平台的 AI 助手，支持桌面端（Windows）和移动端（Android），提供流式对话、长期记忆、Agent 工具调用、MCP 协议集成等能力。

---

## ✨ 核心功能

### 💬 流式对话
- 支持 OpenAI 兼容 API，自动适配端点路径（`/v1/chat/completions` 等）
- 实时流式输出，支持中断/停止
- Markdown 渲染 + 代码高亮
- 消息点击复制
- 多会话管理：新建、切换、删除、历史记录持久化
- 会话导出：支持 JSON / Markdown 格式
- 运行中任务取消（AbortController 全链路传播）
- 斜杠命令：`/new` `/clear` `/simple` `/plan` `/auto` `/forget all` `/help`

### 🧠 长期记忆
- 6 种记忆类型：短期 / 长期 / 情景 / 语义 / 程序性 / 偏好
- 自动从对话中提取用户事实（位置、偏好、约束等）
- 向量检索 + 关键词混合召回
- 支持 JSONL / SQLite 双后端（桌面端）
- 记忆面板：按类型过滤、搜索、删除、导出
- 分类统计卡片（事实/偏好/情景实时计数）
- 记忆详情展开（查看 scope、metadata、更新时间）

### 🤖 多 Agent Plan
- 三种执行模式：直接对话 / 多步 Plan / 自动选择
- 层级化任务分解 + 顺序执行
- Checkpoint 断点续跑（移动端 localStorage）
- 检查点管理面板：列表、恢复、删除
- 全链路取消信号传播

### 🔍 Trace 追踪
- 记录每次对话的完整执行链路
- Span 层级树展示（桌面端）
- 工具调用详情、Token 消耗、耗时分析
- 支持导出和审计日志
- 移动端：状态过滤（全部/成功/失败/运行中）+ 全文搜索

### 🛠️ 工具与 MCP
- 内置工具：文件操作、网页搜索（DuckDuckGo）、网页抓取
- MCP (Model Context Protocol) 外部工具集成：
  - **高德地图**：位置搜索、路线规划、周边查询
  - **麦当劳中国**：菜单查询、下单
- 工具策略管理：allow / deny / requireConfirm

### ⚙️ 完整设置
- 多 LLM Provider 配置（OpenAI / Azure / Deepseek / 小米 MiMo / 自定义）
- 模型选择 + API Key + 端点配置
- MCP 服务 Token 管理
- 工具策略（allow / deny / requireConfirm）
- 记忆系统开关 + 存储后端切换
- 配置导出/导入（移动端），实现手机与电脑同步

### 🎨 Warm Minimal 主题
- 温暖极简浅色主题，桌面端与移动端统一
- 自定义 CSS 变量设计系统（颜色、字体、阴影、过渡）

---

## 📱 平台支持

| 平台 | 技术栈 | 状态 |
|------|--------|------|
| 🪟 **Windows 桌面** | Electron 30 + TypeScript | ✅ 可用 |
| 📱 **Android** | Capacitor 6 + Vite 5 + TypeScript | ✅ 可用 |
| 🧩 **VSCode 扩展** | VS Code Extension API + TypeScript | ✅ 可用 |

---

## 📥 下载

| 平台 | 格式 | 说明 |
|------|------|------|
| 🪟 Windows | `Ziner-v2.0.0-windows-x64.zip` | 解压后直接运行 `Ziner.exe`，无需安装 |
| 📱 Android | `Ziner-v2.0.0-android.apk` | Android 8.0+，支持 ARM64 |

> 二进制文件通过 Git LFS 存储，clone 后需执行 `git lfs pull`。

---

## 🏗️ 项目结构

```
Ziner/
├── apps/
│   ├── desktop/          Electron 桌面应用（Chat / Trace / Settings / Memory 四面板）
│   ├── mobile/           Android 移动端应用（Capacitor 6 + Vite 5）
│   └── vscode-connector/ V2 运行时核心 + VSCode 桥接
├── packages/
│   ├── contracts/        跨包接口定义（IAgent / ILLMProvider / IToolRegistry …）
│   ├── runtime/          运行时框架（orchestrator / planning / memory / skills …）
│   ├── trace/            Span 生命周期 / RunTracker / TraceManager
│   ├── infra/            基础设施（config / cost / errors / permission / storage）
│   └── agents/           Agent 包（browser / coding / office / research）
├── extensions/
│   └── coding-agent/     V1 VSCode Coding Agent 扩展（v1.2.0）
├── tools/                构建脚本（package-desktop.ps1 等）
└── package.json          Monorepo 根（npm workspaces）
```

### 架构说明

- **桌面端**运行在 Electron 中，有 Node.js 主进程，可直接使用 `@ziner/runtime`、`@ziner/trace` 等完整运行时包，支持文件系统、SQLite、多 Agent 编排
- **移动端**运行在 Capacitor WebView 中，受浏览器沙箱限制，使用 IndexedDB 替代文件系统，运行时为轻量级实现
- 两端共享 `@ziner/contracts` 接口定义和 MCP SDK

---

## 🚀 快速开始

### 桌面端

1. 下载 `Ziner-v2.0.0-windows-x64.zip`，解压后运行 `Ziner.exe`
2. 打开设置面板，配置 LLM API（API Key + Endpoint + Model）
3. 如需 MCP 工具，配置高德 API Key 或麦当劳 MCP Token
4. 开始对话

### 移动端

1. 下载 `Ziner-v2.0.0-android.apk`，安装到 Android 设备
2. 打开设置，配置 LLM API（与桌面端相同格式）
3. 可通过导出/导入配置功能，从电脑同步设置到手机
4. 开始对话

### VSCode 扩展

```powershell
cd extensions/coding-agent
npm install
npm run compile
# 按 F5 启动调试，或用 .vsix 安装
```

---

## 🔧 构建方式

### 桌面端打包

```powershell
# TypeScript 编译
npm run build --workspace=@ziner/app-desktop

# 打包 EXE
.\tools\package-desktop.ps1
# 产物：apps/desktop/dist/win-unpacked/Ziner.exe
```

### 移动端打包

```powershell
cd apps/mobile
npm run build              # 构建 Web 资源
npx cap sync android       # 同步到 Android 项目
# 在 Android Studio 中编译 Release APK
# 或使用 release-build.ps1
```

### 从源码构建

```bash
# 安装依赖
npm install

# 全包类型检查
npm run typecheck

# 全包构建
npm run build --workspaces --if-present
```

---

## 📋 环境要求

- Node.js 18+
- TypeScript 5.3+
- Android Studio（移动端打包）
- Python 3.11+（桌面端感知层 sidecar，可选）

---

## 📖 MCP 配置

### 高德地图

1. 设置面板 → 高德地图 API Key
2. 保存后自动注入为 `AMAP_MAPS_API_KEY`，连接高德 MCP Server

### 麦当劳中国

1. 设置面板 → 麦当劳 MCP Token
2. 保存后自动注入为 `MCD_MCP_TOKEN`
3. 文档：`https://open.mcd.cn/mcp/doc`

---

## 📜 更新日志

### v2.0.0 — 2026-07-10

**移动端重大更新**
- 多 Agent Plan 模式（直接对话 / 多步 Plan / 自动选择）
- Checkpoint 断点续跑 + 检查点管理面板
- 运行中任务取消（AbortController 全链路传播）
- 会话导出（JSON / Markdown 格式）
- 记忆导出 JSON + 记忆详情展开面板
- 记忆分类统计卡片（事实/偏好/情景实时计数）
- Trace 状态过滤 + 全文搜索
- 斜杠命令（`/new` `/clear` `/simple` `/plan` `/auto` `/forget all` `/help`）
- 设置页数据管理快捷入口（查看/导出/清空记忆）
- 会话列表导出按钮

### v2.0.0-alpha.6 — 2026-07-02

- Android 移动端正式发布
- Warm Minimal Light 主题统一
- 流式对话界面 + 多会话管理
- 长期记忆面板 + Trace 追踪面板
- 完整设置中心 + 配置导出/导入
- API 端点智能适配

### v2.0.0-alpha.5 — 2026-06-22

- 记忆智能提取（规则+LLM 混合事实提取器）
- 多层级规划（simple/hierarchical/auto）
- 安全沙箱（路径隔离 + 注入扫描）
- 多模态附件预处理
- 工作流编排 + 在线学习自动调度

### v1.2.0 — 2026-06-15

- AgentPipeline（8 阶段前置分析流水线）
- EditTransaction（编辑事务化）

> 完整历史日志见 [README-old.md](README-old.md)

---

## 📄 许可证

MIT
