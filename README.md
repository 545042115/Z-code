# Z Code

> AI 编程助手集合，当前核心项目为 VS Code 扩展 `coding-agent`，支持多后端 LLM、Repo 级上下文与结构化执行流。  
> AI coding assistant collection, currently centered on the `coding-agent` VS Code extension with multi-backend LLM support, repo-aware context, and a structured execution flow.

支持 **SGLang**（本地推理）、**OpenAI**、**Azure OpenAI**、**Deepseek**、**小米 MiMo** 等多种模型后端，提供接近 Cursor / Trae / Claude Code 风格的编程体验。  
Supports **SGLang** (local inference), **OpenAI**, **Azure OpenAI**, **Deepseek**, **Xiaomi MiMo**, and more, delivering a workflow inspired by Cursor / Trae / Claude Code.

---

## 项目结构 / Project Structure

```
├── extensions/
│   └── coding-agent/               VS Code 扩展（核心项目 / Core project）
│       ├── src/
│       │   ├── agent/
│   ├── agent/
│   │   ├── agent-core.ts    知识驱动 + 自我验证闭环架构 + LLM Query Rewrite
│   │   │                    (Pipeline: Discovery → Plan → Memory → [Embedding → RepoGraph] → Context)
│   │   │                    (ReAct Loop: THINK → ACT → OBSERVE → VERIFIER → REFLECT → REPLAN)
│   │   ├── agent-loop.ts    Agent 执行循环（Discovery → Plan → Execute → Verify → Reflect → Replan）
│   │   └── verifier.ts      自动化验证（tsc --noEmit / eslint / npm test）
│       │   ├── discovery/
│       │   │   └── discovery.ts      Discovery Phase：深度发现引擎（模块/文件/符号/风险/范围）
│       │   ├── reflection/
│       │   │   └── reflectionEngine.ts Reflection Loop：自我验证闭环（FailureAnalysis + RepairAction）
│       │   ├── memory/
│       │   │   ├── memoryManager.ts  多轮记忆系统（按 repo+session+intent 维度存储）
│       │   │   └── repoKnowledgeBase.ts Repo Knowledge Base：长期代码库知识库
│       │   ├── embedding/
│       │   │   └── embeddingManager.ts TF-IDF 语义检索
│       │   ├── planner/
│       │   │   └── planner.ts       Pipeline Planner（基于 Discovery Report 动态调整步骤）
│       │   ├── config/
│       │   │   └── config-manager.ts 多配置管理 / Multi-config management
│       │   ├── llm/
│       │   │   └── llm-provider.ts   统一 LLM 接口 / Unified LLM interface
│   │   ├── context/
│   │   │   ├── context-manager.ts LSP 上下文管理（集成所有子模块）
│   │   │   ├── contextBuilder.ts  增量/全量上下文构建
│   │   │   ├── contextExpansion.ts Context Expansion Engine：7 种关系静态扩展，预算驱动
│   │   │   ├── symbolRetrieval.ts Symbol Retrieval：全局符号空间检索
│   │   │   ├── hybrid-retrieval.ts 混合检索（BM25 + Embedding + Graph + CodeRel + FileType）
│   │   │   ├── repoGraph.ts       模块层级 + 数据流图
│   │   │   ├── repoMap.ts         仓库结构地图
│   │   │   ├── reranker.ts        Intent-Aware Reranker（动态权重调整）
│   │   │   ├── symbolIndex.ts     符号索引
│   │   │   ├── retrieval.ts       代码检索
│   │   │   ├── dependencyGraph.ts 文件依赖关系图
│   │   │   ├── impactAnalyzer.ts  变更影响分析
│   │   │   └── workspaceScanner.ts 工作区扫描
│   │   ├── tools/
│   │   │   └── tool-registry.ts  工具系统（含 LSP + 上下文 + 记忆/embedding/Repograph + 局部编辑工具）
│   │   ├── git/
│   │   │   └── git-analyzer.ts   Git 分析器（commit log / blame / diff / file history）
│   │   ├── verifier/
│   │   │   └── runtime-verifier.ts 运行时验证器（tsc / eslint / npm test）
│   │   ├── debug/
│   │   │   ├── tool-usage-analyzer.ts 工具使用率分析器
│   │   │   ├── agent-loop-debugger.ts Agent Loop 调试器
│   │   │   └── retrieval-debugger.ts  检索质量调试器
│   │   ├── panels/
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

知识驱动 + 自我验证闭环架构 / Knowledge-Driven + Self-Verification Loop: **Discovery → Plan → Execute → Verify → Reflect → Replan**

> 说明 / Note  
> 根目录 `README.md` 用于仓库总览。扩展本体的安装、配置、使用说明、更新日志与发布信息，请以 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md) 为准。

### 特性 / Features

| 特性 / Feature | 说明 / Description |
|---|---|
| 🧠 **Repo-Level Agent** | 多轮记忆 + Embedding 检索 + RepoGraph + Planner 管道 |
| 🔭 **Discovery Phase** | Planner 之前运行深度发现：Symbol Retrieval → Context Expansion → Module/Risk/Scope 分析 |
| 🧭 **执行模式路由** | 由 LLM 判断走轻量流程还是完整规划流程，代码侧做安全兜底 |
| 📋 **结构化计划清单** | `PLANNING` 阶段输出 JSON To-Do List，并在侧边栏渲染为 Checklist；完成项打勾、进行中项高亮 |
| 🗜️ **Auto-Compact** | 长对话接近上下文上限时在内部自动压缩旧历史，保留当前计划、关键证据和未完成事项 |
| 🧱 **缓存友好的 Prompt 布局优化** | 静态上下文前置、动态上下文后置，提升前缀复用率并降低重复 Token 成本 |
| 🧠 **上下文窗口 128K** | 默认支持 128K 上下文，并为模型生成回复预留输出空间 |
| 💬 **多轮记忆系统** | 按 repo/session/intent 维度存储对话，LLM 可访问历史 |
| 🔄 **LLM Query Rewrite** | 中文查询自动改写为英文 Search Terms，提升跨语言检索召回率 |
| 🔍 **Intent-Aware 混合检索** | BM25 + Embedding + Graph + CodeRel + FileType 五路融合，按意图动态调整权重 |
| 🗺️ **RepoGraph** | 模块分层 + 数据流图 + 跨模块依赖 |
| 📋 **Planner 管道** | 基于 Discovery Report 动态调整步骤，有知识库时简化探索步骤、追加关键文件引用 |
| 📦 **增量上下文** | 只加载相关文件，禁止全量扫描 |
| 🤖 **Chat 侧边栏 / Sidebar Chat** | 多会话持久化、流式响应、Markdown 渲染、自动应用修改 + Diff / 回退 |
| 🎼 **Composer** | 多文件批量编辑 / Multi-file batch editing |
| ⚡ **Tab 补全 / Tab Completion** | 基于 FIM 的智能代码补全 / FIM-based code completion |
| ✏️ **行内编辑 / Inline Editing** | 选中代码直接修改 / Edit selected code inline |
| 🔧 **多配置管理 / Multi-Config** | 保存多个 LLM 配置，一键切换 / Save & switch LLM configs |
| 🌐 **多后端支持 / Multi-Backend** | SGLang / OpenAI / Azure OpenAI / Deepseek / Xiaomi MiMo |
| 📚 **Code Index** | LSP 符号索引，支持按名称和类型搜索类/函数/接口 |
| ✅ **Verifier** | 在项目具备相应配置与命令时自动执行 `tsc --noEmit`、`eslint`、`npm test` 校验 |
| 🔧 **局部编辑工具** | `replace_text` / `insert_before` / `insert_after` / `append_text` 优先于 `write_file`，避免重写整个文件 |
| 📊 **工具使用率分析** | 自动统计 Agent 调用工具的频率和覆盖率，发现死工具 |
| 📈 **Git 分析器** | 自动检索 `git log`、`git blame`、`git diff`，为回归定位提供上下文 |
| 🛡️ **幻觉约束** | OBSERVE 阶段检测工具返回空数据/错误，自动注入警告阻止模型编造内容 |
| 🚫 **危险命令拦截** | `run_terminal` 内置危险命令检测（`rm -rf`、`git push --force` 等），弹窗确认后执行 |
| 🔄 **Diff 引擎** | 编辑操作幂等去重 + 模糊匹配兜底，支持查看单条/整文件 Diff 与一键回退 |
| ↻ **对话重试** | 每条 assistant/error 消息右下角显示重试按钮，点击后截断后续历史并重新发送对应 user 消息 |
| 🛡️ **防跳过机制** | 工具调用失败后强制禁止标记子任务完成，LLM 必须修正参数并重试，杜绝幻觉导致的 Plan 突然终止 |
| 🔧 **工具参数兼容** | `read_file` / `write_file` 同时兼容 `path` 和 `filePath` 参数名，避免 LLM 因参数名不一致导致调用失败 |
| ✂️ **THINK/OBSERVE 简洁约束** | 系统提示强制要求 LLM 的思考与观察内容控制在 1-2 句话，禁止重复整体任务背景，减少冗余输出 |
| 🗑️ **文件删除感知** | 文件系统监听 + 索引同步 + 防御性 `fs.existsSync` 过滤三重保障，确保已删除文件不会残留于上下文 |
| 🌐 **Web 搜索** | `web_search` / `web_fetch` 工具，通过 DuckDuckGo 搜索和抓取网页内容，扩展 Agent 信息边界 |
| 📤 **会话导出** | 支持将 Chat 会话导出为 Markdown 或 JSON 格式，含完整对话、计划清单与编辑记录 |
| 🧭 **直接项目回答** | `project_understanding` 意图下直接生成项目介绍，跳过不必要的 ReAct 循环 |
| ⏹️ **中断会话** | Chat 侧边栏支持停止按钮，可随时中断当前运行中的 Agent |
| 💭 **思考过程可视化** | Compact 模式下显示 Trae 风格的可折叠思考块（THINK / OBSERVE），告别黑盒等待 |
| 🔍 **LSP 工具链** | 跳转定义、查找引用等核心 LSP 能力，并配合检索与仓库分析工具使用 |
| 🧩 **Symbol Retrieval** | 全局符号空间检索，融合文件相关性与符号匹配度，按 intent 调整 kind 权重 |
| 🔗 **Context Expansion Engine** | 7 种静态关系扩展（import/export/define/call/reference/implement/inherit），预算驱动剪枝 |
| 📚 **Repo Knowledge Base** | 长期代码库知识库：Architecture Summary / Tech Stack / Entry Points / Core Modules / Critical Files |
| 🔄 **Reflection Loop** | 结构化 FailureAnalysis + RepairAction[] + ReflectionMemory，连续两轮无改善自动停止 |

### 支持的后端 / Supported Backends

| Provider | 说明 / Description | API Key |
|---|---|---|
| **SGLang** | 本地高性能推理 / Local high-performance inference | ❌ |
| **OpenAI** | GPT 系列模型 | ✅ |
| **Azure OpenAI** | Azure 托管的 OpenAI 服务 | ✅ |
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
4. 观察 Agent 自动生成的计划清单、运行状态提示和代码修改结果
5. 如有变更，可在侧边栏中查看 Diff、回退单文件或整批修改

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

## 测试与对比 / Tests & Comparisons

- **Trae vs Z Code 图像拼接代码生成对比**：[coding-test/image-stitching-comparison.md](coding-test/image-stitching-comparison.md) — 分析相同 Prompt 下不同 Agent 的代码生成质量、正确性与可运行性差异

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

### v0.6.1 — 2026-06-08

稳定性增强与交互优化 / Stability & Interaction Improvements

#### ✨ 版本摘要 / Highlights
- **对话重试**：Chat 侧边栏每条 assistant/error 消息右下角新增 "↻ 重试" 按钮，点击后截断该对话后续历史并重新发送对应 user 消息
- **防跳过机制**：工具调用失败后系统强制禁止 LLM 标记子任务完成，必须修正参数并重试，彻底杜绝幻觉导致的 Plan 突然终止
- **工具参数兼容**：`read_file` / `write_file` 同时兼容 `path` 和 `filePath` 参数名，解决 LLM 因参数名不一致导致的调用失败
- **THINK/OBSERVE 简洁约束**：系统提示强制要求 LLM 的思考与观察内容控制在 1-2 句话，禁止重复整体任务背景，显著减少冗余输出
- **文件删除感知**：文件系统监听 (`onDidDelete`) + 索引同步 (`symbolIndex`/`dependencyGraph`/`repoGraph` 自动清理) + 防御性 `fs.existsSync` 过滤三重保障，确保已删除文件不会残留于上下文
- **128K 上下文参数调优**：Auto-Compact 触发阈值从 80% 提升至 85%，消息数触发条件从 22 条提升至 44 条，保留尾部消息从 10 条提升至 20 条，摘要长度从 1800 字符提升至 4000 字符，总迭代上限从 50 提升至 100，单个子任务 ReAct 上限从 15 提升至 25

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### v0.6.0 — 2026-06-07

知识驱动 + 自我验证闭环：Discovery Phase、Symbol Retrieval、Context Expansion、Repo Knowledge Base、Reflection Loop  
Knowledge-Driven + Self-Verification Loop: Discovery Phase, Symbol Retrieval, Context Expansion, Repo Knowledge Base, Reflection Loop

#### ✨ 版本摘要 / Highlights
- **Discovery Phase**：Planner 之前运行深度发现，基于 Symbol Retrieval + Context Expansion + RepoGraph + DependencyGraph 纯静态生成 Discovery Report（模块/文件/符号/风险/范围估计）
- **Symbol Retrieval + Context Expansion**：从文件级检索升级为符号级上下文构建，7 种关系扩展（import/export/define/call/reference/implement/inherit），预算驱动剪枝
- **Repo Knowledge Base**：长期代码库知识库，自动推断 Architecture Summary / Tech Stack / Entry Points / Core Modules / Critical Files，首次构建 + 增量更新
- **Knowledge-driven Agent**：Prompt 注入 Architecture Summary / Critical Files / Primary Symbols / Related Symbols；Planner 根据知识库动态调整步骤
- **Reflection Loop**：自我验证闭环，结构化 FailureAnalysis + RepairAction[] + ReflectionMemory（避免重复失败）+ shouldContinueReflection（动态判断进展，连续两轮无改善自动停止）
- **AgentLoop 状态扩展**：LoopState 新增 REFLECT / REPLAN，执行流升级为 PLAN → EXECUTE → VERIFY → REFLECT → REPLAN，最大 3 次循环

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### v0.5.1 — 2026-06-05

Web 搜索与会话导出 / Web Search & Session Export

#### ✨ 版本摘要 / Highlights
- **Web 搜索工具**：新增 `web_search` 和 `web_fetch`，Agent 可通过 DuckDuckGo 搜索网页并抓取内容，用于查文档、API 参考和报错信息。Planner 自动检测搜索意图并插入 web_search 步骤
- **会话导出**：Chat 侧边栏新增导出按钮（↓），支持将会话导出为 Markdown 或 JSON，含完整对话、计划清单与编辑记录。也可通过命令面板 `Coding Agent: 导出会话` 触发

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### v0.5.0 — 2026-06-05

子系统全面落地 / Subsystem Rollout

#### ✨ 版本摘要 / Highlights
- **LLM Query Rewrite**：中文查询自动改写为英文 Search Terms，解决中英文 token 空间不匹配导致的检索失效问题
- **局部编辑工具集**：新增 `replace_text`、`insert_before`、`insert_after`、`append_text`，优先用于已有文件的局部修改
- **Intent-Aware 动态混合检索**：Reranker 根据 `modification` / `bug_fix` / `project_understanding` 自动切换五路检索权重
- **ReAct Tool Loop**：真正的工具调用循环，支持 tool_call 结果回灌 LLM，最大 15 次迭代
- **Runtime Verifier 子系统**：自动运行 `tsc --noEmit` / `eslint` / `npm test`，捕获编译错误并注入修复上下文
- **Git Analyzer 子系统**：自动检索 `git log`、`git blame`、`git diff`，为回归定位和历史审查提供上下文
- **工具使用率分析器**：统计最近 100 次运行的工具调用覆盖率，发现从未被调用的死工具
- **检索质量调试器**：分阶段输出 BM25 / Embedding / Hybrid / Rerank 结果，定位检索失效根因
- **Agent Loop 调试器**：追踪 PLAN → EXECUTE → VERIFY → REPAIR 状态流转

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### v0.4.0 — 2026-06-04

架构升级 / Architecture Upgrade

#### ✨ 版本摘要 / Highlights
- Prompt 改为缓存友好布局，静态信息前置、动态信息后置
- `PLANNING` 阶段升级为结构化 To-Do List，并在侧边栏展示 Checklist
- 长对话支持 Auto-Compact，自动压缩旧历史并保留关键进度
- 由 LLM 主导轻量/完整流程决策，轻量模式下支持自动升级至完整规划
- 默认上下文窗口扩展至 128K，并为生成回复预留输出空间
- Chat 侧边栏新增停止按钮，支持随时中断运行中的会话
- Compact 模式下支持 Trae 风格的可折叠思考过程显示
- 新增幻觉约束、危险命令拦截、Diff 幂等性与模糊匹配等安全/稳定性特性

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

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
