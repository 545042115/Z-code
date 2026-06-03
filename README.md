# Z Code

> AI 编程助手集合 — 基于多后端 LLM 的 VS Code 扩展，三层混合架构 + Repo-Level Agent  
> AI Coding Assistant Collection — VS Code Extension with Multi-Backend LLM, Hybrid Architecture & Repo-Level Agent

支持 **SGLang**（本地推理）、**OpenAI**、**Deepseek**、**小米 MiMo** 等多种模型后端，提供类似 Cursor/Trae 的编程体验。  
Supports **SGLang** (local inference), **OpenAI**, **Deepseek**, **Xiaomi MiMo** and more, delivering a Cursor/Trae-like coding experience.

---

## 项目结构 / Project Structure

```
├── extensions/
│   └── coding-agent/               VS Code 扩展（核心项目 / Core project）
│       ├── src/
│       │   ├── agent/
│       │   │   ├── agent-core.ts    三层混合架构 + Repo-Level Agent Core
│       │   │   │                    (Pipeline: Plan → Memory → Embedding → RepoGraph → Context → LLM)
│       │   │   │                    (ReAct Loop: THINK → ACT → OBSERVE → VERIFIER → REFLECT)
│       │   │   └── verifier.ts      自动化验证（tsc --noEmit / eslint / npm test）
│       │   ├── memory/
│       │   │   └── memoryManager.ts 多轮记忆系统（按 repo+session+intent 维度存储）
│       │   ├── embedding/
│       │   │   └── embeddingManager.ts TF-IDF 语义检索
│       │   ├── planner/
│       │   │   └── planner.ts       Pipeline Planner（6 步管道）
│       │   ├── config/
│       │   │   └── config-manager.ts 多配置管理 / Multi-config management
│       │   ├── llm/
│       │   │   └── llm-provider.ts   统一 LLM 接口 / Unified LLM interface
│       │   ├── context/
│       │   │   ├── context-manager.ts LSP 上下文管理（集成所有子模块）
│       │   │   ├── contextBuilder.ts  增量/全量上下文构建
│       │   │   ├── repoGraph.ts       模块层级 + 数据流图
│       │   │   ├── repoMap.ts         仓库结构地图
│       │   │   ├── symbolIndex.ts     符号索引
│       │   │   ├── retrieval.ts       代码检索
│       │   │   ├── dependencyGraph.ts 文件依赖关系图
│       │   │   ├── impactAnalyzer.ts  变更影响分析
│       │   │   └── workspaceScanner.ts 工作区扫描
│       │   ├── tools/
│       │   │   └── tool-registry.ts  工具系统（含 LSP + 上下文 + 记忆/embedding/Repograph 工具）
│       │   ├── panels/
│       │   │   ├── chat-view-provider.ts 侧边栏 Chat（WebviewView）
│       │   │   ├── chat-panel.ts     输出面板 Chat
│       │   │   └── composer-panel.ts Composer 面板
│       │   ├── inline/
│       │   │   └── inline-completion.ts Tab 补全和行内编辑
│       │   ├── utils/
│       │   │   └── diff-engine.ts    工具库 / Utilities
│       │   └── extension.ts          扩展入口
│       └── package.json
├── tools/                           开发工具脚本 / Dev scripts
│   ├── update.ps1                   更新/打包脚本 / Update & package
│   ├── compile.ps1                  编译脚本 / Compile
│   └── package.ps1                  打包脚本 / Package
├── AGENT_SPEC.md                    三层混合架构设计规范 / Architecture spec
└── .gitignore
```

---

## Coding Agent — VS Code Extension

三层混合架构 / Three-Layer Hybrid Architecture: **宏观 Plan-and-Execute + 微观 ReAct + 自动化 Verifier + 兜底 Reflection**

> 说明 / Note  
> 根目录 `README.md` 用于仓库总览。扩展本体的安装、配置、使用说明、更新日志与发布信息，请以 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md) 为准。

### 特性 / Features

| 特性 / Feature | 说明 / Description |
|---|---|
| 🧠 **Repo-Level Agent** | 多轮记忆 + Embedding 检索 + RepoGraph + Planner 管道 |
| 💬 **多轮记忆系统** | 按 repo/session/intent 维度存储对话，LLM 可访问历史 |
| 🔍 **语义 Embedding 检索** | TF-IDF 向量索引，Top-K 语义搜索 |
| 🗺️ **RepoGraph** | 模块分层 + 数据流图 + 跨模块依赖 |
| 📋 **Planner 管道** | 6 步自动分解：intent → memory → embedding → repograph → context → answer |
| 📦 **增量上下文** | 只加载相关文件，禁止全量扫描 |
| 🤖 **Chat 侧边栏 / Sidebar Chat** | 多会话持久化、流式响应、Markdown 渲染、自动应用修改 + Diff / 回退 |
| 🎼 **Composer** | 多文件批量编辑 / Multi-file batch editing |
| ⚡ **Tab 补全 / Tab Completion** | 基于 FIM 的智能代码补全 / FIM-based code completion |
| ✏️ **行内编辑 / Inline Editing** | 选中代码直接修改 / Edit selected code inline |
| 🔧 **多配置管理 / Multi-Config** | 保存多个 LLM 配置，一键切换 / Save & switch LLM configs |
| 🌐 **多后端支持 / Multi-Backend** | SGLang / OpenAI / Deepseek / Xiaomi MiMo |
| 📚 **Code Index** | LSP 符号索引，支持按名称和类型搜索类/函数/接口 |
| ✅ **Verifier** | 子任务完成后自动运行 tsc --noEmit / eslint / npm test |
| 🔍 **LSP 工具链** | 跳转定义、查找引用、关联文件发现 |

### 支持的后端 / Supported Backends

| Provider | 说明 / Description | API Key |
|---|---|---|
| **SGLang** | 本地高性能推理 / Local high-performance inference | ❌ |
| **OpenAI** | GPT-4 / GPT-3.5 | ✅ |
| **Deepseek** | 国产大模型 | ✅ |
| **小米 MiMo** | 小米大模型 / Xiaomi LLM | ✅ |

### 安装 / Installation

#### 方式 1：.vsix 安装（推荐 / Recommended）

```powershell
.\tools\update.ps1
```

然后在 VS Code 中：`Ctrl+Shift+X` → `...` → `Install from VSIX` → 选择生成的 `.vsix` 文件

#### 方式 2：开发者模式 / Dev Mode

```bash
cd extensions/coding-agent
npm install
npm run compile
# 按 F5 启动调试 / Press F5 to start debugging
```

### 快速开始 / Quick Start

1. `Ctrl+Shift+P` → `Coding Agent: 添加配置`，按照向导配置 LLM
2. 点击左侧活动栏的 **Coding Agent 图标** 打开侧边聊天栏
3. 在底部输入框输入你的问题

### 扩展详细文档 / Extension Docs

- 安装、配置、使用说明： [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)
- 扩展更新日志与发布说明： [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)
- 扩展源码目录： [extensions/coding-agent](file:///d:/mycode/Z%20Code/extensions/coding-agent)

### 配置管理 / Configuration

| 命令 / Command | 功能 / Function |
|---|---|
| `Coding Agent: 添加配置` | 添加新 LLM 配置 / Add new config |
| `Coding Agent: 切换配置` | 切换当前配置 / Switch config |
| `Coding Agent: 编辑配置` | 编辑已有配置 / Edit config |
| `Coding Agent: 删除配置` | 删除配置 / Delete config |

### 快捷键 / Shortcuts

| Shortcut | 功能 / Function |
|---|---|
| `Ctrl+Shift+L` | 打开 Chat 输出面板 / Open Chat output panel |
| `Ctrl+Shift+I` | 弹出输入框发送消息 / Quick input popup |
| `Ctrl+Shift+O` | 打开 Composer 面板 / Open Composer |
| `Ctrl+K Ctrl+I` | 行内编辑（需选中代码）/ Inline edit (select code first) |
| `Tab` | 接受代码补全 / Accept completion |

### 添加新的模型提供商 / Adding New Providers

详见 / See: [extensions/coding-agent/README.md](extensions/coding-agent/README.md)

---

## 开发 / Development

### 环境要求 / Requirements

- Node.js 18+
- VS Code 1.85+
- TypeScript 5.3+

### 构建与打包 / Build & Package

```bash
# 构建 / Build
cd extensions/coding-agent
npm install
npm run compile

# 打包 / Package
# 或使用 / Or use: .\tools\update.ps1
```

---

## 更新日志 / Changelog

### v0.3.0 — 2026-06-03

Chat 工作流升级 / Chat Workflow Upgrade

#### ✨ 版本摘要 / Highlights
- Chat 侧边栏支持项目内多会话、历史恢复与更接近 Trae 的交互体验
- Assistant 回复支持 Markdown 渲染、流式展示与更自然的状态文案
- 代码修改默认自动应用，并支持单条 Diff、整文件 Diff、单文件回退与整批回退
- 轻量任务默认启用 Compact Mode，减少内部 Planning / ReAct 噪音
- Webview、Diff 预览与回退链路做了稳定性修复

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### 历史版本 / Previous Versions

- 旧版本的详细更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

---

## 许可证 / License

MIT
