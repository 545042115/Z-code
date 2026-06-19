# Z Code / Z Assistant

> **项目定位 / Project Positioning**
> 本项目是一个**面向学习的 Agent 流程实现**，核心目标是逐步构建和理解 Coding Agent 的完整工作流。从 v0.3.0 到最新版本，每个版本的迭代都对应一个可学习的里程碑，适合**按版本顺序逐步阅读代码、理解演进过程**。
>
> **注意事项 / Caveats**
> - 随着功能持续叠加，部分模块之间可能出现边界模糊或轻微 Bug
> - 目前**缺少 MCP (Model Context Protocol) 类型的外部工具调用**，所有工具均为内置实现
> - 不以生产级稳定性为目标，而以**可理解、可扩展、可教学**为优先
>
> AI 编程助手集合，**当前核心项目为 VS Code 扩展 `coding-agent`（V1）**，支持多后端 LLM、Repo 级上下文与结构化执行流。  
> AI coding assistant collection, currently centered on the `coding-agent` VS Code extension with multi-backend LLM support, repo-aware context, and a structured execution flow.
>
> **当前版本 / Current Versions**
> - V1（VSCode 扩展）：v1.2.0
> - V2（Assistant Runtime）：v2.0.0-alpha.2（**Phase 7-9 — P0 三重能力已落地** ✅）

> **V2 演进 / V2 Direction (P0 三件套已落地)**
> 仓库根目录已按 [ADR-001](docs/ADR-001-Architecture-Refactor-Revised.md) 与 [ADR-0007](docs/ADRS/0007-runtime-decoupling.md) 完成 Phase 6A 重构，正式进入 **Z Assistant 双轨结构**：
> - **V1 = `extensions/coding-agent/`**：保留的 VSCode Coding Agent 扩展（v1.2.0 继续可发版）。
> - **V2 = 仓库根 `packages/` + `apps/`**（npm workspaces）：Assistant Runtime 平台，**不再是 VSCode 扩展**。
> - **P0 三件套全部落地**：📖 Long-Term Memory（6 种记忆子系统 + Knowledge 知识层） / 🖥️ Desktop 独立应用（Electron + Chat/Trace/Settings 面板） / 🤖 Computer Use（Browser Agent + GUI 自动化 + Screen 感知 + 安全策略）。
> - 后续 P1 路线已就绪：多模态感知 / Human-in-the-Loop UI / Skill Auto-Discovery。

支持 **SGLang**（本地推理）、**OpenAI**、**Azure OpenAI**、**Deepseek**、**小米 MiMo** 等多种模型后端，提供接近 Cursor / Trae / Claude Code 风格的编程体验。  
Supports **SGLang** (local inference), **OpenAI**, **Azure OpenAI**, **Deepseek**, **Xiaomi MiMo**, and more, delivering a workflow inspired by Cursor / Trae / Claude Code.

---

## 项目结构 / Project Structure

```
├── extensions/
│   └── coding-agent/               VS Code 扩展（核心项目 / Core project）
│       ├── src/
│       │   ├── agent/
│       │   │   ├── agent-core.ts    三层混合架构核心（ReAct: THINK → ACT → OBSERVE）
│       │   │   ├── agent-loop.ts    Agent 执行循环（PLAN → EXECUTE → VERIFY → [条件触发] REFLECT → REPLAN）
│       │   │   └── verifier.ts      自动化验证封装（tsc --noEmit / eslint / npm test）
│       │   ├── discovery/
│       │   │   └── discovery.ts      Discovery Phase：深度发现引擎（模块/文件/符号/风险/范围）
│       │   ├── task-understanding/
│       │   │   └── task-understanding.ts  Task Understanding：意图分类 + 约束提取
│       │   ├── architecture-review/
│       │   │   └── architecture-review.ts  Architecture Review：结构变更分析
│       │   ├── change-impact/
│       │   │   └── change-impact-analysis.ts  Change Impact Analysis：静态分析影响范围
│       │   ├── complexity/
│       │   │   └── complexity-estimator.ts  Complexity Estimation：任务复杂度评估（Fast/Full Path 路由）
│       │   ├── skills/
│       │   │   ├── skill-manager.ts      Skill Manager：Skill 发现/选择/加载/缓存
│       │   │   ├── skill-loader.ts       Skill Loader：扫描 .skills/**/SKILL.md
│       │   │   ├── skill-selector.ts     Skill Selector：硬过滤 + 多信号加权评分 + imports 展开
│       │   │   ├── skill-validator.ts    Skill Validator：frontmatter/imports/循环引用/文件引用校验
│       │   │   └── skill-types.ts        Skill 类型定义（SkillMode/Triggers/Verification/Sections）
│       │   ├── reflection/
│       │   │   ├── reflectionEngine.ts   Reflection Engine：FailureAnalysis + RepairAction + ReflectionMemory
│       │   │   └── reflection-agent.ts   Reflection Agent：条件触发反射（Verify 失败时触发）
│       │   ├── memory/
│       │   │   ├── memoryManager.ts      多轮记忆系统（按 repo+session+intent 存储）
│       │   │   └── repoKnowledgeBase.ts  Repo Knowledge Base：长期代码库知识库
│       │   ├── embedding/
│       │   │   └── embeddingManager.ts   TF-IDF 语义检索
│       │   ├── planner/
│       │   │   └── planner.ts            Pipeline Planner（基于 Discovery Report 动态调整步骤）
│       │   ├── config/
│       │   │   └── config-manager.ts     多配置管理 / Multi-config management
│       │   ├── llm/
│       │   │   └── llm-provider.ts       统一 LLM 接口 / Unified LLM interface
│       │   ├── context/
│       │   │   ├── context-manager.ts    LSP 上下文管理（集成所有子模块）
│       │   │   ├── context-budget.ts     Context Budget：统一预算管理，防止 Prompt 膨胀
│       │   │   ├── contextBuilder.ts     增量/全量上下文构建
│       │   │   ├── contextExpansion.ts   Context Expansion Engine：7 种关系静态扩展，预算驱动
│       │   │   ├── symbolRetrieval.ts    Symbol Retrieval：全局符号空间检索
│       │   │   ├── hybrid-retrieval.ts   混合检索（BM25 + Embedding + Graph + CodeRel + FileType）
│       │   │   ├── repoGraph.ts          模块层级 + 数据流图
│       │   │   ├── repoMap.ts            仓库结构地图
│       │   │   ├── reranker.ts           Intent-Aware Reranker（动态权重调整）
│       │   │   ├── symbolIndex.ts        符号索引
│       │   │   ├── retrieval.ts          代码检索
│       │   │   ├── dependencyGraph.ts    文件依赖关系图
│       │   │   ├── impactAnalyzer.ts     变更影响分析
│       │   │   └── workspaceScanner.ts   工作区扫描
│       │   ├── tools/
│       │   │   └── tool-registry.ts      工具系统（含 LSP + 上下文 + 记忆/embedding/RepoGraph + 局部编辑工具）
│       │   ├── git/
│       │   │   └── git-analyzer.ts       Git 分析器（commit log / blame / diff / file history）
│       │   ├── verifier/
│       │   │   └── runtime-verifier.ts   运行时验证器（tsc / eslint / npm test）
│       │   ├── debug/
│       │   │   ├── tool-usage-analyzer.ts   工具使用率分析器
│       │   │   ├── agent-loop-debugger.ts   Agent Loop 调试器
│       │   │   ├── retrieval-debugger.ts    检索质量调试器
│       │   │   ├── git-context-debugger.ts  Git 上下文调试器
│       │   │   └── verification-debugger.ts 验证调试器
│       │   ├── panels/
│       │   │   ├── chat-view-provider.ts 侧边栏 Chat（WebviewView）
│       │   │   ├── chat-panel.ts         输出面板 Chat
│       │   │   └── composer-panel.ts     Composer 面板
│       │   ├── inline/
│       │   │   └── inline-completion.ts  Tab 补全和行内编辑
│       │   ├── utils/
│       │   │   └── diff-engine.ts        工具库 / Utilities
│       │   └── extension.ts              扩展入口
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

知识驱动 + 自我验证闭环架构 / Knowledge-Driven + Self-Verification Loop: **Discovery → Skill Discovery → Task Understanding → Complexity Estimation → Architecture Review → Change Impact Analysis → Planner → Execute → Verify → [条件触发] Reflect → Replan**

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
| 🧠 **长上下文支持** | 支持最大 128K 上下文窗口，Auto-Compact 自动压缩旧历史，为生成回复预留输出空间 |
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
| 🛠️ **Skill System** | Claude Code 风格的 Skill 系统：结构化 frontmatter（mode/priority/triggers/imports/verification）、硬过滤 + 7 信号加权评分、imports 递归展开、循环引用检测、Skill Validator 校验、4 个调试命令 |
| 📏 **Context Budget** | 统一预算管理：按来源限制字符数（Skill 5K / File 6K / KeyCode 4K / 总计 24K），优先级驱动裁剪，防止 Prompt 膨胀 |
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

## Z Assistant V2 — Assistant Runtime 平台 (Phase 6A landed)

> 本节描述 V2。配套设计：[ADR-001 §3.1 目标目录结构](docs/ADR-001-Architecture-Refactor-Revised.md)、[ADR-0007 §一 目标 Monorepo 目录结构](docs/ADRS/0007-runtime-decoupling.md)、[ROADMAP_V2_ASSISTANT_RUNTIME.md](docs/ROADMAP_V2_ASSISTANT_RUNTIME.md)、[V2_VISION.md](docs/V2_VISION.md)。

### V2 定位

Z Assistant 是一个**跨 Agent 复用的运行时平台**：trace / storage / cost / errors / permission / config / budget / orchestrator / planning / reflection / context / skills / evaluation / evolution 一套机制，让未来的 Coding / Research / Office / Browser Agent 在同一 Runtime 上跑。

V1 VSCode 扩展（`extensions/coding-agent`）保留并继续发版；V2 不会替换 V1，而是给 V1 加一层 **Adapter**，并为未来非 Coding 的 Agent（Browser / Research / Office）铺好 Runtime。

### V2 包清单

| 包 / Package | 版本 | 职责 / Responsibility | 状态 |
|---|---|---|---|
| `@z-assistant/contracts` | 0.1.0 | 跨包类型 / 接口（`IAgent` / `IPlanner` / `IReflectionEngine` / `IContextProvider` / `ISkillRegistry` / `IToolRegistry` / `IVerifier` / `ILLMProvider` / `IBudgetGuard` / `AgentRun` / `Span` …） | ✅ |
| `@z-assistant/infra-errors` | 0.1.0 | 错误码 + 分类器（`3001-3999` 通用错误） | ✅ |
| `@z-assistant/infra-cost` | 0.1.0 | pricing + budget（多模型 token 计价 + 预算控制） | ✅ |
| `@z-assistant/infra-storage` | 0.1.0 | JSONL Store（runs / spans / evaluations / candidates） | ✅ |
| `@z-assistant/infra-permission` | 0.1.0 | fs-guard / net-guard / tool-guard | ✅ |
| `@z-assistant/infra-config` | 0.1.0 | 配置中心 + secrets | ✅ |
| `@z-assistant/trace` | 0.1.0 | Span 生命周期 / RunTracker / TraceManager / Projections / Instrumenter | ✅ |
| `@z-assistant/runtime` | 0.1.0 | orchestrator / planning / reflection / context / skills / evaluation / evolution / **memory（6 种记忆子系统）** / **knowledge（project/user/document 知识层）** / **action（GUI 自动化）** / **perception（screen 感知）** / **permission/computer-use（安全策略）** | ✅ |
| `@z-assistant/agent-coding` | 0.1.0 | Coding Agent V2 适配层（不重复 Coding 业务，只把 V1 接入 V2 Runtime） | ✅ |
| `@z-assistant/agent-research` | 0.1.0 | 占位 | ✅ |
| `@z-assistant/agent-office` | 0.1.0 | 占位 | ✅ |
| `@z-assistant/agent-browser` | 0.1.0 | Browser Agent（Playwright 后端 / DOM 解析 / Session 持久化 / 元素高亮 / 决策引擎 / 跨标签页操作） | ✅ |
| `@z-assistant/app-cli` | 0.1.0 | V2 CLI 入口（`z run <task>` / `z trace ls|show` / `z version`） | ✅ |
| `@z-assistant/app-vscode-connector` | 0.1.0 | V2 ↔ V1 桥接（`VSCodeConnector` + `AssistantRuntime` stub + **WeChatFerry / Computer-Use 微信/QQ 服务**） | ✅ |
| `@z-assistant/app-desktop` | 0.1.0 | Electron 桌面应用（Chat / Trace / Settings 面板 / System Tray / Global Hotkey / Auto Update / License Service / **WeChatFerry 微信自动回复** / **Computer Use AI 操控微信/QQ**） | ✅ |

### V2 包详细结构 / V2 Package Structure

```
apps/vscode-connector/
├── src/
│   ├── index.ts                   VSCodeConnector 桥接类
│   ├── llm-provider.ts            LLM 提供商封装
│   ├── chat-agent.ts              聊天 Agent
│   ├── chat-profile.ts            聊天风格分析
│   ├── wechat-hook-service.ts     WeChatFerry 微信 Hook（DLL 注入捕获全部消息）
│   ├── qq-onebot-service.ts       QQ OneBot 服务（NapCat + OneBot v11 WebSocket）
│   ├── computer-use-service.ts    Computer Use 桌面自动化引擎（截图/OCR/鼠标/键盘/窗口检测）
│   ├── computer-use-wechat.ts     Computer Use 微信服务（截图+模拟操控）
│   └── computer-use-qq.ts         Computer Use QQ 服务（截图+模拟操控）
```

### V2 特性 / Features

| 特性 / Feature | 说明 / Description |
|---|---|
| 🏗️ **Monorepo 布局** | npm workspaces + TypeScript project references，每个 V2 包独立 `package.json` + `tsconfig.json` + barrel `index.ts` |
| 🧩 **统一接口** | `IAgent` / `IPlanner` / `IReflectionEngine` / `IContextProvider` / `ISkillRegistry` / `IToolRegistry` / `IVerifier` / `ILLMProvider` / `IBudgetGuard` 在 `contracts` 内集中定义 |
| 🛠️ **infra 工具包族** | errors / cost / storage / permission / config 拆为 5 个独立包，互相不依赖，可被任意 V2 包或 V1 通过 shim 引用 |
| 📊 **Trace 独立包** | `@z-assistant/trace` 涵盖 Span 生命周期、RunTracker、TraceManager 持久化协调、纯函数 Projections（listRunSummaries / listSpanNodes / projectVariantStats / …）、duck-typed Instrumenter（wrapLLM / wrapTool / wrapPipeline） |
| 🎯 **Orchestrator** | 通用多 Agent 协调：agent-registry（按 capability 评分）/ shared-state（pub/sub + 版本追踪）/ orchestrator（sequential / parallel / dag 三种模式 + fail-fast + maxAgentCalls + artifact namespace） |
| 🪜 **框架层** | planning（DAG / sequential 调度器）/ reflection / context（budget + provider registry）/ skills（loader/selector/validator）/ evaluation（benchmark-runner / candidate-adapter / rubric / sandbox）/ evolution |
| 🔌 **Adapter 模式** | `@z-assistant/agent-coding` 不重写 Coding 业务，只把 V1 `src/agent/`、`src/planner/`、`src/reflection/`、`src/context/` 等包装成 V2 接口 |
| 🌉 **V2 ↔ V1 桥接** | `apps/vscode-connector` 暴露 `VSCodeConnector`，V1 在 `activate()` 期间实例化一次；V1 不直接 import `@z-assistant/runtime` 做副作用（teardown-safe） |
| 📦 **CLI 入口** | `apps/cli` 已有 `argv` 解析和子命令分发；`z run <task>` 可触发 `VSCodeConnector.runTask` 走通端到端路径（runtime 当前是 stub，R7 替换） |
| 🧪 **测试基线** | 130+ 个 V2 测试全部通过（`@z-assistant/runtime` / `@z-assistant/agent-browser` / `@z-assistant/app-desktop` 全部）；`npm test --workspaces --if-present` 一键全跑 |
| | **P0 新增能力 — 2026-06-18** |
| 📖 **Long-Term Memory** | 6 种记忆子系统（短期/长期/情景/语义/程序/偏好）+ Knowledge 知识层（Project/User/Document）+ 隐私遗忘（GDPR） + 向量存储 + 混合检索 + 跨 Agent 共享 |
| 🖥️ **Desktop 独立应用** | Electron 桌面端：Chat / Trace / Settings 三面板 + System Tray + Global Hotkey（`Ctrl+Shift+Z`）+ Auto Update + License Service + File Association |
| 🤖 **Computer Use** | Browser Agent（Playwright 后端 / DOM 解析 / 决策引擎 / Session 持久化 / 跨标签页 / 元素高亮）+ GUI 自动化（鼠标/键盘/剪贴板）+ Screen 截图 + 安全策略（危险 URL 拦截/动作分级） |
| 💚 **WeChatFerry 微信自动回复** | 通过 DLL 注入微信 Windows 客户端，自动回复好友私聊和群聊 @消息，支持风格模仿 |
| 💙 **QQ 自动回复（NapCat + OneBot）** | 通过 NapCat + OneBot v11 WebSocket 协议，自动回复 QQ 好友私聊和群聊 @消息，支持风格模仿 |
| 🖥️ **Computer Use 微信/QQ 操控** | 通过截图 + OCR + 鼠标键盘模拟操控微信/QQ 窗口，零封号风险，无需 DLL 注入 |

### V1 ↔ V2 桥接

V1 ↔ V2 通过 **shim 文件**双向兼容，迁移期不破坏 V1 旧 import 路径：

```typescript
// V1 旧 import 路径：extensions/coding-agent/src/contracts/index.ts
export * from '@z-assistant/contracts';

// V1 旧 import 路径：extensions/coding-agent/src/trace/index.ts
export { Span, TraceManager, RunTracker, ... } from '@z-assistant/trace';
export { TraceInstrumentation, ... } from './trace-adapter';   // V1 类型适配

// V1 旧 import 路径：extensions/coding-agent/src/infra/storage/index.ts
export * from '@z-assistant/infra-storage';
// ... errors / cost / permission / config 同理
```

V1 `package.json` 显式声明 8 个 `@z-assistant/*` 依赖；`tsconfig.json` 通过 `references` 声明增量构建。**未来 R10 整改**：CI 加 lint 禁止 V1 旧路径 import，必须走 `@z-assistant/*`。

### V2 依赖图（单向，往下）

```
                  apps/desktop
                  apps/vscode-connector     ← V2 桥接 V1
                  apps/cli
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
  @z-assistant     @z-assistant   @z-assistant
    /runtime        /agent-coding  /agents/{research,office,browser}
        │                               │
        │   ┌─────────┐  ┌─────────┐    │
        ├──►│ workflow│  │ memory  │◄───┤  (占位)
        │   └────┬────┘  └────┬────┘    │
        │        │            │          │
        │   ┌────▼────┐  ┌────▼────┐    │
        ├──►│ trace   │  │planning │    │
        │   └────┬────┘  │ skills  │    │
        │        │       │ context │    │
        │   ┌────▼────┐  │reflectn │    │
        ├──►│evaluatn │  └────┬────┘    │
        │   └────┬────┘       │          │
        │   ┌────▼────┐       │          │
        └──►│evolution│       │          │
            └────┬────┘       │          │
                 │            │          │
                 ▼            ▼          ▼
            ┌──────────────────────────┐
            │ @z-assistant/infra/*     │
            │  + @z-assistant/contracts│  (叶子)
            └──────────────────────────┘
```

依赖规则（强制）：
- `contracts` 是叶子，任何包可依赖
- `infra/*` 互相不依赖
- `trace` 不依赖 `runtime` 框架子包
- `runtime` 依赖 `trace` + `infra/*` + `contracts`
- `agents/coding` 依赖 `runtime` + `contracts`
- `apps/*` 可依赖任何 `packages/*`
- ❌ `packages/*` → `apps/*` 禁止
- ❌ `packages/*` → `vscode` 禁止（CI grep 验证）

### V2 后续路线 / Roadmap

| 阶段 | 内容 | 衔接 |
|---|---|---|
| **P0-1 ✅ Long-Term Memory** | 6 种记忆子系统 + Knowledge 知识层（Project/User/Document）+ 隐私/GDPR + 向量存储 + 混合检索 | `packages/runtime/src/memory/` + `packages/runtime/src/knowledge/` |
| **P0-2 ✅ Desktop 独立应用** | Electron + Chat/Trace/Settings + Tray + Hotkey + Auto Update + License + File Association | `apps/desktop/` |
| **P0-3 ✅ Computer Use** | Browser Agent (Playwright) + GUI 自动化 + Screen 截图 + 安全策略 | `packages/agents/browser-agent/` + `packages/runtime/src/{action,perception,permission}/` |
| **P1-1** 多模态感知 | Voice / Image／Video 输入 + LLM 多模态理解 | `packages/runtime/src/perception/{audio,image,video}.ts` |
| **P1-2** Human-in-the-Loop UI | 安全确认弹窗 / 操作审批 / 实时监控 | `apps/desktop/src/renderer/approval.ts` + Electron 原生对话框 |
| **P1-3** Skill Auto-Discovery | Memory → Skill 自动转化 / Skill 推荐 | `packages/runtime/src/memory/procedural.ts` → Skill 注册 |

---

## 测试与对比 / Tests & Comparisons

- **Trae vs Z Code 图像拼接代码生成对比**：[coding-test/image-stitching-comparison.md](coding-test/image-stitching-comparison.md) — 分析相同 Prompt 下不同 Agent 的代码生成质量、正确性与可运行性差异

---

## 开发 / Development

### 环境要求 / Requirements

- Node.js 18+
- VS Code 1.85+
- TypeScript 5.3+

### V1 扩展构建 / Build V1 Extension

```bash
# 方式 1：开发者模式 / Dev mode
cd extensions/coding-agent
npm install
npm run compile
# 按 F5 启动调试 / Press F5 to start debugging

# 方式 2：发布包 / Package for distribution
# 或使用 / Or use: .\tools\update.ps1
```

### V2 Monorepo 构建 / Build V2 Monorepo

```bash
# 在仓库根 / Run from repo root
npm install                              # 装全部 workspace 依赖
npm run typecheck                        # 全部 V1 + V2 包 typecheck（0 错误）
npm test                                 # 全部 V1 + V2 包测试
npm run build --workspaces --if-present  # 全部 V1 + V2 包构建
npm run clean --workspaces --if-present  # 清理 out/ dist/

# 单包操作 / Per-package
npm test --workspace=@z-assistant/runtime
npm run build --workspace=@z-assistant/agent-browser
```

### V2 CLI 使用 / Use V2 CLI

```bash
# 构建后 / After build
node apps/cli/out/index.js version
# → @z-assistant/runtime v0.1.0

node apps/cli/out/index.js run "fix the failing test"
# → runId=run-...  （runtime 当前 stub，R7 替换为真实 AssistantRuntime）

node apps/cli/out/index.js trace ls
# → (stub) z trace ls: not implemented in Phase 6A
```

### 已知遗留 / Known Legacy

- `apps/vscode-connector` 的 `AssistantRuntime.boot()` 当前是 stub（返回 no-op runtime + 错误码 `3001`），后续替换为真实实现。
- P0 三件套（Memory / Desktop / Computer Use）已完成；P1 多模态感知 / Human-in-the-Loop / Skill Auto-Discovery 待推进。

---

## 更新日志 / Changelog

### v2.0.0-alpha.4 — 2026-06-20

Z Assistant V2 — QQ OneBot 集成 + 微信/QQ 双协议自动回复 / QQ OneBot Integration + Dual-Protocol Auto-Reply

#### ✨ 版本摘要 / Highlights

- **💙 QQ 自动回复（NapCat + OneBot v11）**：新增 NapCat + OneBot WebSocket 协议支持，自动回复 QQ 好友私聊和群聊 @消息
- **💚 微信 Hook DLL 注入**：从 iLink Bot API 切换为 WeChatFerry DLL 注入，直接捕获微信收发的全部消息，无需自建 Bot
- **🎭 聊天风格模仿（ChatProfile）**：新增风格分析模块，自动收集对话双方消息，分析说话风格并注入 LLM 提示，让 AI 回复更自然
- **⚡ 任务队列**：新增消息队列机制，避免并发消息导致 "Run already active" 冲突
- **📊 状态推送**：完整的状态推送链路（Service → Connector → Bridge → IPC → Preload → UI），设置面板实时显示连接状态和消息数
- **🔧 打包修复**：修复 electron-builder asar 打包导致 WeChatFerry ESM 模块加载失败的问题

#### 📚 详细说明 / Full Notes

- 新增文件：
  - `apps/vscode-connector/src/qq-onebot-service.ts` — QQ OneBot WebSocket 服务
  - `apps/vscode-connector/src/wechat-hook-service.ts` — 微信 Hook 服务（替换旧 iLink 服务）
  - `apps/vscode-connector/src/chat-profile.ts` — 聊天风格分析
- 移除文件（不再使用）：
  - `apps/vscode-connector/src/wechat-ilink-service.ts` — iLink Bot API 服务
  - `apps/vscode-connector/src/qq-bot-service.ts` — QQ Bot API 服务
- 依赖变更：新增 `wechatferry@0.0.26`、`ws@^8.21.0`

### v2.0.0-alpha.3 — 2026-06-19

Z Assistant V2 — 微信/QQ 自动回复 + Computer Use 桌面操控 / WeChat/QQ Auto-Reply + Computer Use Desktop Control

#### ✨ 版本摘要 / Highlights

- **💬 WeChatFerry 微信自动回复**：通过 DLL 注入微信 Windows 客户端，自动回复指定联系人和群聊消息，支持 @提及过滤、联系人/群聊列表可视化勾选
- **🖥️ Computer Use 微信/QQ 操控**：通过截图（screenshot-desktop）+ OCR（tesseract.js）+ 鼠标键盘模拟（PowerShell）操控微信/QQ 窗口，零封号风险，无需 DLL 注入或协议逆向
- **🤖 Computer Use Service**：底层桌面自动化引擎，支持窗口检测（Win32 API）、OCR 识别（中文+英文）、鼠标/键盘模拟、截图
- **🗑️ 移除 QQ 协议方案**：移除 icqq 和 LLOneBot 方案，QQ 统一使用 Computer Use 方式操控
- **📋 微信联系人/群聊可视化选择**：连接微信后自动显示联系人列表和群聊列表，支持搜索、全选/取消全选，勾选自动保存
- **🔧 依赖清理**：移除 `test-out` 测试目录，释放约 200MB 空间

#### 📚 详细说明 / Full Notes

- 新增文件：
  - `apps/vscode-connector/src/computer-use-service.ts` — 桌面自动化引擎
  - `apps/vscode-connector/src/computer-use-wechat.ts` — Computer Use 微信服务
  - `apps/vscode-connector/src/computer-use-qq.ts` — Computer Use QQ 服务
- 依赖变更：新增 `screenshot-desktop`、`tesseract.js`；移除 `icqq`

### v2.0.0-alpha.2 — 2026-06-18

Z Assistant V2 — P0 三重能力落地 / P0 Triple Capabilities Landed

#### ✨ 版本摘要 / Highlights

- **📖 Long-Term Memory（P0-1）**：6 种记忆子系统完整实现：
  - Short-Term（短期对话轮次）/ Long-Term（跨 Session 事实）/ Episodic（情景任务回顾）/ Semantic（概念语义）/ Procedural（程序技能）/ Preferences（用户偏好）
  - Knowledge 知识层：ProjectKnowledgeBase / UserKnowledgeBase / DocumentKnowledgeBase
  - 基础设施：IMemoryProvider + InMemoryVectorStore（余弦相似度）+ 本地 n-gram embedding（零外部依赖）+ JSONL 文件持久化 + 混合检索（向量+关键词回退）
  - 隐私遗忘：PrivacyManager 支持 GDPR 查看/删除/清除/导出
  - 写入策略：白名单 + 重要性阈值 + 频率限制 + 去重
  - 跨 Agent 共享：SharedMemory 发布/读取 + 冲突解决策略
- **🖥️ Desktop 独立应用（P0-2）**：Electron 桌面端完整实现：
  - Chat / Trace / Settings 三面板 + System Tray + Global Hotkey（`Ctrl+Shift+Z`）
  - 进程模型：Main + Preload（contextBridge）+ Renderer（sandboxed）
  - Auto Update：electron-updater 集成 + 自动检测/下载/重启提示
  - License Service：Free / Pro / Enterprise 三级许可 + 功能特征控制
  - 打包配置：electron-builder（macOS .dmg / Windows NSIS / Linux AppImage）+ File Association（.zap/.zconfig/.zlog）
- **🤖 Computer Use（P0-3）**：让 Agent 像人一样操作电脑：
  - Browser Agent：IBrowserBackend 抽象 + Playwright 实现 + DOM 解析（LLM 可读结构化文本）+ 决策引擎（Observe → LLM → Execute 循环）+ Session 持久化（Cookie/Storage）+ 元素高亮 + 跨标签页操作
  - GUI 自动化：IGUIProvider 抽象 + DesktopGUIProvider（Win/macOS/Linux 三平台鼠标/键盘/剪贴板/热键）
  - Screen 感知：IScreenProvider 抽象 + DesktopScreenProvider（OS 级截图）
  - 安全策略：动作风险分级（safe~critical）+ 危险 URL 拦截 + 高风险操作检测
- **测试基线**：Runtime 117 测试 + Desktop 13 测试 + Browser Agent 9 测试 = **139 个 V2 测试全部通过**

#### 📚 详细说明 / Full Notes

- ROADMAP：[docs/ROADMAP-V2-Capability-Gap.md](docs/ROADMAP-V2-Capability-Gap.md)
- 完成内容审计：P0-1 100% / P0-2 100% / P0-3 100%

### v2.0.0-alpha.1 — 2026-06-18

Z Assistant V2 — Assistant Runtime 平台（Phase 6A 落地）/ Assistant Runtime Platform (Phase 6A landed)

#### ✨ 版本摘要 / Highlights

- **Monorepo 重组**：仓库根升级为 npm workspaces，顶层目录变为 `extensions/coding-agent/`（V1）+ `packages/{contracts, infra/*, trace, runtime, agents/*}/`（V2）+ `apps/{cli, desktop, vscode-connector}/`。
- **15 个 V2 包全部落地**：
  - `@z-assistant/contracts`（跨包类型 / 接口）
  - `@z-assistant/infra-{errors, cost, storage, permission, config}`（5 个工具包）
  - `@z-assistant/trace`（Span / RunTracker / Projections / Instrumenter）
  - `@z-assistant/runtime`（orchestrator + planning / reflection / context / skills / evaluation / evolution + workflow/memory 占位）
  - `@z-assistant/agent-{coding, research, office, browser}`（4 个 Agent 包，coding 完整 + 3 个占位）
  - `@z-assistant/app-{cli, vscode-connector, desktop}`（3 个宿主入口，cli 与 vscode-connector 完整 + desktop 占位）
- **V1 ↔ V2 桥接（shim 兼容）**：V1 端 5 个 `infra/*` + `contracts` + `trace` 全部留下单行 shim 文件 `export * from '@z-assistant/...'`；V1 旧 import 路径全部继续工作，零破坏。
- **TypeScript Project References**：V1 `tsconfig.json` 通过 `references` 声明对 8 个 V2 包的依赖；增量构建与类型检查一致。
- **测试基线**：161 个测试全部通过（V1 既有 infra/storage/errors/cost/permission/config + multi-agent 加上 V2 全部）；`npm test --workspaces --if-present` 一键全跑。
- **Orchestrator 框架**：通用多 Agent 协调（agent-registry 按 capability 评分 / shared-state pub/sub + 版本追踪 / orchestrator sequential/parallel/dag 三种模式 + fail-fast + maxAgentCalls + artifact namespace）。
- **CLI 入口**：`apps/cli` 已有 argv 解析与子命令分发（`z run` / `z trace` / `z version` / `z help`）。
- **VSCode Connector**：`apps/vscode-connector` 提供 `VSCodeConnector` 类（含事件订阅、runTask、isReady、trace、store 接口），V1 在 `activate()` 期间实例化一次，teardown-safe。

#### 📚 详细说明 / Full Notes

- 完整设计：[ADR-001 §十一 当前实现状态与已落地项](docs/ADR-001-Architecture-Refactor-Revised.md)
- 配套细节：[ADR-0007 Runtime 解耦](docs/ADRS/0007-runtime-decoupling.md)
- 路线图：[ROADMAP_V2_ASSISTANT_RUNTIME.md](docs/ROADMAP_V2_ASSISTANT_RUNTIME.md)

### v1.2.0 — 2026-06-15

AgentPipeline + EditTransaction / Unified Pipeline & Edit Transactions

#### ✨ 版本摘要 / Highlights
- **AgentPipeline**：提取 AgentCore 和 AgentLoop 的共享前置分析流水线为独立模块，8 阶段按序执行（Discovery → TaskUnderstanding → SkillSelection → ComplexityEstimation → ArchitectureReview → ChangeImpactAnalysis → Planning → ContextSetup），确保 UI 模式和 Loop 模式对同一请求的前置分析结果一致
- **EditTransaction**：编辑事务化，多文件修改绑定统一事务 ID，支持快照捕获（FileSnapshot）、冲突检测（contentHash）、按事务回滚、验证结果绑定，9 种事务状态（planned → applying → applied → verifying → verified → reverting → reverted / failed / conflict）
- **AgentLoop 修复**：通过 AgentPipeline 统一修复了 AgentLoop 的 3 处参数缺失问题（contextBuilder.build 缺少 currentFile、skillManager.select 缺少 currentFile/openFiles、context.currentFile 未设置）

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### v1.1.0 — 2026-06-12

Skill 系统升级 + Context Budget / Skill System Upgrade + Context Budget

#### ✨ 版本摘要 / Highlights
- **Skill 系统完整升级**：结构化 frontmatter（description / mode / priority / triggers / imports / stop_if / verification）、Markdown sections 解析（Purpose / Workflow / Do / Do Not 等 9 个标准 section）
- **Skill 选择算法升级**：硬过滤（stop_if / intents / file_globs）+ 7 信号加权软评分（名称 0.35 + 关键词 0.25 + 文件 0.20 + 标签 0.15 + 描述 0.15 + 符号 0.10 + 优先级 0.10），命中原因记录
- **Skill imports 与组合**：imports 递归展开（最大深度 3）、循环引用检测（DFS）、导入 Skill 不占直接 Top-K
- **Skill Validator**：校验 name / mode / priority / frontmatter 闭合 / imports 可解析 / 循环引用 / references 和 scripts 文件存在性
- **4 个调试命令**：`Validate Skills` / `Reload Skills` / `Show Active Skills` / `Explain Skill Selection`
- **Context Budget**：统一预算管理，按来源限制字符数（Skill 5K / File 6K / KeyCode 4K / Diagnostics 800 / 总计 24K），优先级驱动裁剪，防止 Prompt 膨胀
- **Skill 选择移到 TaskUnderstanding 之后**：传入 taskType / currentFile / openFiles，提升选择精度
- **示例 Skill**：`typescript-quality`（strict 模式）、`llm-provider`（imports typescript-quality）

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### v0.7.0 — 2026-06-09

Skill System 完整落地 / Skill System Rollout

#### ✨ 版本摘要 / Highlights
- **Skill System（Claude Code 风格）**：新增 `.skills/**/SKILL.md` 自动发现、解析和注入系统
  - `SkillLoader`：递归扫描 `.skills/` 目录，解析 YAML frontmatter（name + tags）和 Markdown 正文
  - `SkillSelector`：基于用户请求关键词、TaskType、Discovery 结果中的文件扩展名和符号名进行评分，返回 Top-K（默认 3）相关 Skill
  - `SkillManager`：整合发现/选择/加载/缓存，30 秒 TTL 索引缓存，Prompt 自动注入 `=== ACTIVE SKILLS ===` 块
- **与现有流水线兼容**：Skill Discovery 插入在 Discovery 之后、Task Understanding 之前，不改动后续任何阶段
- **向后兼容**：若无 `.skills/` 目录，系统静默跳过，不影响现有流程

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

### v0.6.2 — 2026-06-09

Change Planning Layer 完整落地 / Full Change Planning Layer Rollout

#### ✨ 版本摘要 / Highlights
- **Task Understanding**：新增意图分类模块，将用户请求自动分类为 CREATE / MODIFY / REFACTOR / REPLACE / MIGRATE / ANALYZE，并提取约束条件（如"新建文件"、"不要在原文件实现"、"保持接口不变"）
- **Architecture Review**：新增架构审查模块，基于 Discovery 报告分析是否需要拆函数、拆类、新增文件、更新引用，检测单一职责原则违反，将结构化建议注入 Planner
- **Change Impact Analysis**：新增变更影响分析模块，基于 SymbolIndex + DependencyGraph + RepoGraph 纯静态分析影响范围，输出直接/间接影响文件列表、关键受影响符号、测试覆盖缺口与风险摘要
- **条件触发 Reflection Agent**：改造反射循环为条件触发模式，Verify 通过时不触发反射，仅失败时调用标准化 ReflectionAgent.reflect() 接口，返回 shouldContinue / shouldReplan / rootCause / repairActions
- **Planner 任务类型模板**：Planner 根据 TaskType 生成差异化步骤模板（REPLACE：定位旧实现 → 创建新实现 → 更新引用 → 验证行为；REFACTOR：理解结构 → 拆分/抽取 → 保持行为 → 验证）
- **三层流水线兼容**：Task Understanding → Architecture Review → Change Impact Analysis → Planner 形成完整 Change Planning Layer，与现有 Discovery / Execution / Verify / Reflection 全兼容

#### 📚 详细说明 / Full Notes
- 详细安装、使用方式与完整更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

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
