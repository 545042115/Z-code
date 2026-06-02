# Z Code

> AI 编程助手集合 — 基于多后端 LLM 的 VS Code 扩展  
> AI Coding Assistant Collection — VS Code Extension with Multi-Backend LLM Support

支持 **SGLang**（本地推理）、**OpenAI**、**Deepseek**、**小米 MiMo** 等多种模型后端，提供类似 Cursor/Trae 的编程体验。  
Supports **SGLang** (local inference), **OpenAI**, **Deepseek**, **Xiaomi MiMo** and more, delivering a Cursor/Trae-like coding experience.

---

## 项目结构 / Project Structure

```
├── extensions/
│   └── coding-agent/               VS Code 扩展（核心项目 / Core project）
│       ├── src/
│       │   ├── agent/
│       │   │   ├── agent-core.ts    三层混合架构 Agent Core
│       │   │   │                    (Planner → ReAct → Verifier → Reflector)
│       │   │   └── verifier.ts      自动化验证（tsc --noEmit / eslint / npm test）
│       │   ├── config/
│       │   │   └── config-manager.ts 多配置管理 / Multi-config management
│       │   ├── llm/
│       │   │   └── llm-provider.ts   统一 LLM 接口 / Unified LLM interface
│       │   ├── context/
│       │   │   ├── context-manager.ts LSP 上下文管理 / Context management
│       │   │   ├── symbolIndex.ts    符号索引 / Symbol index
│       │   │   ├── retrieval.ts      代码检索 / Code retrieval
│       │   │   └── workspaceScanner.ts 工作区扫描 / Workspace scanner
│       │   ├── tools/
│       │   │   └── tool-registry.ts  工具系统（含 LSP 工具链）
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

### 特性 / Features

| 特性 / Feature | 说明 / Description |
|---|---|
| 🤖 **Chat 侧边栏 / Sidebar Chat** | 智能代码问答，流式响应 / Intelligent Q&A with streaming |
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

### v0.3.0 — 2025-06-02

Code Index + Verifier 升级 / Code Index & Verifier Upgrade

#### ✨ 新特性 / New Features
- **Code Index**: LSP 符号索引系统，支持按名称和类型搜索类/函数/接口
- **Verifier**: 子任务完成后自动运行 tsc --noEmit / eslint / npm test，结果反馈给 Reflector
- **LSP 工具链**: 新增 search_symbols / get_workspace_context / get_definition / get_references / find_related_files 工具
- **VERIFIER 状态**: Agent 状态机新增状态，OBSERVE → VERIFIER → REFLECT 流转

#### 🔧 优化 / Improvements
- 状态流转图更新：PLANNING → THINK → ACT → OBSERVE → VERIFIER → REFLECT → (THINK | DONE)
- 工作区上下文信息注入 Agent 上下文
- tool-registry 重构为内聚的私有方法模式

#### 🐛 修复 / Bug Fixes
- search_symbols kind 过滤顺序修复：先 filter 再 slice，确保 kind 过滤不丢失结果

### v0.2.0 — 2025-06-02

三层混合架构升级 / Three-Layer Hybrid Architecture Upgrade

#### ✨ 新特性 / New Features
- **三层混合架构**: 宏观 Planner + 微观 ReAct + 兜底 Reflector
- **Planner**: 将复杂需求拆解为子任务列表，生成高层计划
- **ReAct Executor**: 每个子任务内 THINK → ACT → OBSERVE 循环
- **Reflector**: 子任务完成后自动审查，发现缺陷自动迭代修正
- **计划可视化**: System Prompt 实时展示子任务状态（✅完成 / 🔄进行中）

#### 🔧 优化 / Improvements
- 服务地址和 API Key 分离配置
- 配置切换时不清除已有对话

#### 🐛 修复 / Bug Fixes
- WebviewView provider 重复注册错误处理
- JSON 解析错误修复（提取首个合法 JSON）

### v0.1.0 — 2025-05-30

初始版本 / Initial Release

#### ✨ 新特性 / New Features
- Chat 侧边栏，流式响应
- 多 LLM 后端支持（SGLang / OpenAI / Deepseek / 小米 MiMo）
- 多配置管理（添加 / 切换 / 编辑 / 删除）
- Tab 代码补全（FIM）
- 行内编辑（选中代码直接修改）
- Composer 多文件编辑
- 对话历史持久化保存
- 状态机架构 Agent Core

---

## 许可证 / License

MIT