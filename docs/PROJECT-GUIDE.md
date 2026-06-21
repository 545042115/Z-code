# Z Code 项目架构指南

> **目标读者**：没看过一行代码的人。读完本文，你将理解这个项目的构成、运行流程和核心技术细节。
>
> **阅读时间**：约 20 分钟。

---

## 一、项目是什么

Z Code 是一个 **桌面 AI 助手平台**，对标 Marvis / WorkBuddy / OpenHands Desktop。

它有两个版本：

| 版本 | 定位 | 入口 | 当前状态 |
|---|---|---|---|
| **V1** | VSCode Coding Agent 扩展 | `extensions/coding-agent/` | ✅ 可用（v1.2.0） |
| **V2** | 独立桌面应用 + 通用 Agent 平台 | `apps/desktop/` | ✅ 核心可用（alpha） |

**V1 是什么**：一个 VSCode 插件，装上后在 VSCode 里有个 AI 助手帮你写代码。它是"Coding 专用"的。

**V2 是什么**：不再依赖 VSCode，是一个独立的桌面应用（`.exe`），能做的不只是写代码，还能查资料、操作浏览器、操控微信/QQ、读文档等。V2 把 V1 的 Coding 能力"上提"为通用 Runtime，未来可以挂载多种 Agent（Coding / Research / Office / Browser）。

**V1 和 V2 的关系**：V2 不是重写 V1，而是把 V1 里"通用"的部分（与 VSCode 无关的）抽到 `packages/` 下，V1 降级为 V2 的一个"Connector"（适配器）。V1 的 Coding 能力通过 `apps/vscode-connector/` 桥接到 V2 Runtime。

---

## 二、项目构成（目录结构）

### 2.1 顶层目录

```text
Z Code/
├── packages/          # V2 核心：通用 Runtime + 契约 + 基础设施 + Agent
├── apps/              # V2 宿主入口：桌面应用 / CLI / VSCode 连接器
├── extensions/        # V1：VSCode Coding Agent 扩展
├── docs/              # 设计文档 + ADR + Roadmap
├── tools/             # PowerShell 构建辅助脚本
├── .skills/           # Skill 系统示例
├── coding-test/       # 对比测试
├── package.json       # Monorepo 根配置（npm workspaces）
├── tsconfig.json      # TypeScript 配置（Project References）
├── build-all.ps1      # 一键构建脚本
├── README.md          # 项目主文档
└── AGENT_SPEC.md      # V1 Coding Agent 构建规范
```

### 2.2 `packages/` — V2 核心包（15 个）

这是 V2 的"地基"。所有通用能力都在这里，**不依赖任何 UI 框架（VSCode / Electron）**。

```text
packages/
├── contracts/              # 纯类型定义（接口），所有包的"共同语言"
├── infra/                  # 基础设施（5 个互不依赖的子包）
│   ├── errors/             #   错误码 + 分类器
│   ├── cost/               #   token 计价 + 预算控制
│   ├── storage/            #   JSONL 持久化存储
│   ├── permission/         #   文件/网络/工具守卫（fs-guard / net-guard / tool-guard）
│   └── config/             #   配置中心 + secrets 管理
├── trace/                  # 可观测性：Span 树 + RunTracker + Projections
├── runtime/                # V2 Runtime 主体（机制层 + 框架层）
└── agents/                 # Agent 包
    ├── browser-agent/      #   Browser Agent（Playwright 自动化）
    ├── coding-agent/       #   Coding Agent V2 适配层（stub，委托给 V1）
    ├── research-agent/     #   Research Agent（占位）
    └── office-agent/       #   Office Agent（占位）
```

#### `packages/contracts/` — "共同语言"

定义所有包共享的**纯类型接口**（无运行时代码）。任何包都可以依赖它。

核心接口：
- `IAgent` — Agent 的标准接口（`execute` / `canHandle` / `rollback` / `health`）
- `ITool` / `IToolRegistry` — 工具和工具注册表
- `ILLMProvider` — LLM 调用接口
- `IMemoryProvider` — 记忆存储接口
- `IPlanner` — 计划器接口
- `AgentRun` / `AgentSpan` — Trace 数据结构

#### `packages/runtime/` — V2 Runtime 主体

这是 V2 的"大脑"，包含两大层：

**机制层**（无业务逻辑）：
- `orchestrator/` — 多 Agent 协调器（sequential / parallel / dag 三种模式）
- `permission/` — ConfirmationGate（HITL 确认门）+ DryRunExecutor（模拟执行）+ 风险分级
- `audit/` — 审计日志（JSONL append-only）

**框架层**（注册器，无业务逻辑）：
- `memory/` — **6 种记忆子系统**（详见第五节）
- `perception/` — 感知层（截屏 / OCR / 语音识别 / 文档解析，通过 Python sidecar）
- `action/` — GUI 自动化（鼠标 / 键盘 / 剪贴板，跨平台）
- `planning/` — DAG / sequential 调度器
- `reflection/` — 反射引擎框架
- `skills/` — Skill 加载 / 选择 / 解析
- `evaluation/` — Benchmark 评测 + LocalSandbox
- `evolution/` — 失败聚类 + 启发式建议
- `knowledge/` — 项目 / 用户 / 文档知识层
- `embedding/` — 本地 n-gram 嵌入模型
- `storage/` — InMemoryVectorStore（余弦相似度）

### 2.3 `apps/` — 宿主入口（3 个）

这是用户实际接触的"应用"。它们依赖 `packages/` 但不被任何包依赖。

```text
apps/
├── desktop/            # Electron 桌面应用（主要入口）
├── vscode-connector/   # V2↔V1 桥接 + IM 自动回复
└── cli/                # 命令行工具（z run / z trace ls / z trace show）
```

#### `apps/desktop/` — Electron 桌面应用

标准 Electron 三进程架构：

| 进程 | 文件 | 职责 |
|---|---|---|
| **主进程** | `main.ts` | 4 个窗口（main/chat/trace/settings）+ 30 个 IPC handler + 系统托盘 + 全局快捷键 |
| **Preload** | `preload.ts` | 通过 `contextBridge` 暴露 `ZDesktopAPI` 给渲染进程（安全边界） |
| **渲染进程** | `renderer/` | 4 个 UI 面板：Chat / Trace / Settings / Memory |

关键模块：
- `runtime-bridge.ts` — V2 Runtime 桥接 + HITL 确认门 + 审计日志
- `session-manager.ts` — 会话 CRUD + JSON 持久化
- `browser-service.ts` — Browser Agent 封装
- `tray.ts` — 系统托盘（5 项菜单）
- `hotkey.ts` — 全局快捷键 `Ctrl+Shift+Z`
- `updater.ts` — 自动更新（electron-updater）
- `license.ts` — 许可证服务（Free / Pro / Enterprise）

#### `apps/vscode-connector/` — 核心桥接层

这是 V2 和 V1 之间的"桥梁"，也是 **Chat Agent 的实际实现所在**。

核心模块：
- `chat-agent.ts` — **Chat Agent 主体**（Plan + ReAct + Reflect + Memory，627 行）
- `coding-agent-factory.ts` — 把 chat-agent 包装成 V2 `IAgent`
- `llm-provider.ts` — OpenAIProvider（兼容 OpenAI / DeepSeek / Anthropic / Gemini / Ollama）
- `task-tools.ts` — 9 个文件/Shell 工具
- `web-tools.ts` — DuckDuckGo 搜索 + web_fetch
- `browser-tools.ts` — 7 个 Playwright 工具
- `perception-tools.ts` — 4 个感知工具（OCR / 描述 / 转录 / 文档解析）
- `wechat-hook-service.ts` — WeChatFerry DLL 注入微信
- `qq-onebot-service.ts` — NapCat + OneBot v11 WebSocket
- `computer-use-service.ts` — Windows UIAutomation 操控

#### `apps/cli/` — 命令行工具

```bash
z run <task>          # 执行一个任务
z trace ls            # 列出最近 20 个 Run
z trace show <runId>  # 显示某个 Run 的 Span 树
z version             # 打印版本
z help                # 帮助
```

### 2.4 `extensions/coding-agent/` — V1 VSCode 扩展

这是 V1 的"全部"，是一个 VSCode 扩展（v1.2.0）。它实现了完整的三层混合架构：

- `agent/agent-core.ts` — 状态机（PLANNING / THINK / ACT / OBSERVE / VERIFY / REFLECT / DONE）
- `agent/agent-loop.ts` — Plan → Execute → Verify → Reflect → Replan 循环
- `planner/planner.ts` — 前置规划
- `reflection/reflection-engine.ts` — 条件触发的反思
- `tools/tool-registry.ts` — 28+ 工具（文件 / 搜索 / LSP / Git / 验证）
- `context/` — ContextManager + Retrieval + RepoGraph + SymbolIndex
- `skills/` — Skill 系统
- `memory/` — V1 自己的记忆

**与 `packages/agents/coding-agent/` 的关系**：后者是 V2 适配层（stub），通过 `impl` 注入委托给前者。由于 V1 依赖 `vscode` API，V2 包不能直接 import V1，所以用"依赖注入"模式在运行时连接。

---

## 三、完整流程：从用户输入到结果输出

以"查询北京天气并保存到桌面"为例，追踪完整链路：

### 3.1 用户输入

用户在 Desktop Chat 窗口输入："查询北京天气并保存到桌面"

### 3.2 IPC 传递（Renderer → Main）

```text
renderer/chat.ts                    # 用户点击发送
  └─ zApi.runTask(text, sessionId)  # 调用 preload 暴露的 API
     └─ ipcRenderer.invoke('RUN_TASK', task, sessionId)  # IPC 到主进程

main.ts                             # 主进程收到
  └─ ipcMain.handle('RUN_TASK', ...)
     └─ bridge.runTask(task, sessionId)
```

### 3.3 RuntimeBridge → VSCodeConnector

```text
runtime-bridge.ts
  └─ bridge.runTask(task, sessionId)
     └─ this.connector.runTask(task, 'desktop', sessionId)

vscode-connector/index.ts
  └─ VSCodeConnector.runTask(task, source, sessionId)
     ├─ 1. 构建 LLM Provider（OpenAIProvider，支持 5 种后端）
     ├─ 2. registerChatAgent() — 用 createCodingAgentFromChat() 把 chat-agent 包装成 V2 IAgent
     ├─ 3. AssistantRuntime.createOrchestrator() — 创建 Orchestrator + RunTracker
     └─ 4. orchestrator.run() — 进入 Agent 执行循环
```

### 3.4 Chat Agent 执行（核心）

`chat-agent.ts` 的 `execute()` 方法，**4 个阶段**：

#### Phase 1: Memory Recall（记忆召回，无 LLM）

```text
并行召回 3 种记忆：
  ├─ long-term:   "用户之前问过上海天气"（持久事实）
  ├─ episodic:    "我在这个项目做过天气查询"（任务经历）
  └─ preferences: "用户偏好简洁回答"（用户偏好）
```

#### Phase 2: Planning（规划）

**双模式规划**（`planningMode: 'simple' | 'hierarchical' | 'auto'`）：

- **simple 模式**（默认）：LLM 生成 2-4 步的简短计划，注入 system prompt
- **hierarchical 模式**：LLM 生成 milestones + steps 结构化计划，渲染为 markdown 注入 system prompt
- **auto 模式**：根据任务长度和关键词自动选择（含"plan"/"方案"/"步骤"等关键词或长任务自动走 hierarchical）

```text
simple 模式：
  LLM 生成: {"plan": ["搜索北京天气", "保存到桌面"]}
  → 注入 system prompt 作为参考

hierarchical 模式：
  LLM 生成:
    milestones: [{id:"m1", name:"信息收集", objective:"获取天气数据"}]
    steps: [{id:"s1", milestoneId:"m1", name:"搜索天气", instruction:"搜索北京天气"}]
  → 渲染为 markdown 计划注入 system prompt
  → 后续 ReAct 循环按步骤执行
```

#### Phase 3: ReAct 循环（Think → Act → Observe，最多 8 轮）

```text
第 1 轮：
  THINK: LLM 看到 tools 列表，决定调用 web_search
  ACT:   executeTool('web_search', { query: '北京天气' })
         └─ DuckDuckGo HTML 搜索，返回结果摘要
  OBSERVE: 搜索结果作为 tool message 塞回 messages

第 2 轮：
  THINK: LLM 看到搜索结果，决定抓取某个天气页面
  ACT:   executeTool('web_fetch', { url: 'https://...weather...' })
         └─ Node http/https 抓取页面，stripHtml 去标签
  OBSERVE: 页面纯文本塞回 messages

第 3 轮：
  THINK: LLM 看到天气信息，决定写入桌面文件
  ACT:   ConfirmationGate.confirm('write_file', { filePath: '...', content: '...' })
         └─ 风险分级: medium（写操作）
         └─ 弹出 Desktop Modal UI，用户点击"允许"
         └─ executeTool('write_file', { filePath: 'C:\Users\...\Desktop\weather.md', content: '...' })
         └─ resolvePath 检查通过（桌面在 USERPROFILE 下）
         └─ fs.writeFileSync 写入文件
  OBSERVE: "文件已写入" 塞回 messages

第 4 轮：
  THINK: LLM 看到写入成功，不再调用工具
  → 返回最终答案："已查询北京天气并保存到桌面 weather.md"
```

**工具调用的两种解析方式**：
1. **Native function calling**（OpenAI 格式）：LLM 直接返回 `toolCalls` 数组
2. **XML fallback**（兼容 DeepSeek 等模型）：LLM 在 content 里输出 `<tool_calls><invoke name="..."><parameter name="...">value</parameter></invoke></tool_calls>`，用正则解析

#### Phase 4: Memory Save（记忆保存，异步非阻塞）

**记忆智能提取**（替代硬编码关键词匹配）：

```text
旧方案：硬编码关键词 ['我喜欢', 'I like', 'I prefer', ...]
  → 只能抓"我喜欢咖啡"这种显式偏好
  → 抓不住"我在上海"、"我明天要出差"、"我对花生过敏"

新方案：规则 + LLM 混合提取器（fact-extractor.ts）
  → 启发式规则：快速匹配 location / preference / constraint / identity / goal
     "我住在上海" → { factType: 'location', value: '上海', confidence: 0.92 }
     "I am allergic to peanuts" → { factType: 'constraint', value: 'peanuts', confidence: 0.9 }
  → LLM 回退：规则未命中时，用一次轻量 LLM 调用提取
  → 结果存入 long-term memory，下次 recall 能命中
```

```text
记录 episode:    "用户问了北京天气，我搜索并保存到桌面"
提取事实:       "用户 location 是 上海"（存入 long-term memory）
推断 preferences: "用户喜欢把结果保存到桌面"（可选）
```

### 3.5 结果返回

```text
chat-agent.execute() 返回 { text: "已查询北京天气..." }
  └─ orchestrator.run() 完成
     └─ tracker.flush() + tracker.finish()（持久化 Trace）
        └─ VSCodeConnector.runTask() 返回 { runId, result }
           └─ RuntimeBridge.runTask() 返回
              └─ main.ts IPC handler 返回给 renderer
                 └─ chat.ts 显示最终答案
```

### 3.6 完整链路图

```text
用户输入
  ↓
renderer/chat.ts → zApi.runTask()
  ↓ IPC
main.ts → bridge.runTask()
  ↓
runtime-bridge.ts → connector.runTask()
  ↓
vscode-connector/index.ts
  ├─ 构建 LLM Provider
  ├─ registerChatAgent() → createCodingAgentFromChat()
  └─ AssistantRuntime.createOrchestrator()
     ↓
     orchestrator.run()
       ↓
       chat-agent.execute()
         ├─ Phase 1: Memory Recall
         ├─ Phase 1.5: 多模态附件预处理 (可选，图片/音频/文档→文本)
         ├─ Phase 2: Planning (simple 或 hierarchical)
         ├─ Phase 3: ReAct 循环 (LLM × N, Tool × N)
         │    ├─ ToolInvocationPipeline (统一流水线)
         │    │    ├─ 风险分级 (classifyRisk)
         │    │    ├─ 注入扫描 (PromptInjectionDetector)
         │    │    ├─ 路径沙箱 (PathGuard)
         │    │    ├─ ConfirmationGate.confirm() → Desktop Modal UI
         │    │    ├─ DryRunExecutor (可选，模拟执行)
         │    │    └─ AuditLogger (记录审计日志)
         │    └─ executeTool() → web_search / web_fetch / write_file
         └─ Phase 4: Memory Save (异步，含事实提取器)
       ↓
     tracker.flush() → 持久化 Trace (JSONL)
  ↓
返回 { runId, result }
  ↓ IPC
renderer/chat.ts 显示结果
```

---

## 四、核心技术细节

### 4.1 推理模式：Plan + ReAct + Reflect 混合架构

Z Code 不是单一的 ReAct 或 Plan-and-Execute，而是**三者混合**：

| 阶段 | 方法 | 作用 | 触发条件 |
|---|---|---|---|
| **Plan** | Plan-and-Execute | 先生成 2-4 步计划（simple 模式）或 milestones+steps（hierarchical 模式），指导后续行动 | 每次任务开始时 1 次 LLM 调用 |
| **ReAct** | ReAct（Reasoning + Acting） | Think → Act → Observe 循环 | Plan 之后，最多 8 轮 |
| **Reflect** | Reflection | 复盘失败原因，生成修复计划 | **仅当 Verify 失败时**（V1），或通过 Memory Save 软反思（V2） |

**为什么混合**：
- 纯 ReAct 的问题：没有全局规划，容易在复杂任务中迷失
- 纯 Plan-and-Execute 的问题：计划太死板，无法应对意外
- 混合的好处：Plan 提供方向，ReAct 提供灵活性，Reflect 提供纠错

### 4.2 ReAct 循环详解

ReAct = Reasoning（推理）+ Acting（行动）

```text
循环开始（最多 8 轮）:
  1. THINK: 把对话历史 + 工具列表喂给 LLM，LLM 决定下一步
  2. ACT:   如果 LLM 要调用工具 → 执行工具
            如果 LLM 不调用工具 → 循环结束，返回最终答案
  3. OBSERVE: 工具执行结果塞回对话历史
  4. 回到 1
```

**关键设计**：
- **工具列表在每轮都传给 LLM**：LLM 知道有哪些工具可用
- **对话历史累积**：每轮的 thought / action / observation 都保留
- **最大轮次限制**：防止无限循环（默认 8 轮）
- **XML fallback**：兼容不支持 function calling 的模型

### 4.3 工具系统（23 个工具）

Chat Agent 有 **23 个工具**，分 4 类：

| 类别 | 工具数 | 工具列表 |
|---|---|---|
| **Web** | 2 | `web_search`（DuckDuckGo 搜索）、`web_fetch`（抓取网页） |
| **File/Shell** | 9 | `read_file`、`write_file`、`replace_text`、`append_text`、`insert_text`、`run_terminal`、`search_code`、`list_directory`、`get_project_context` |
| **Browser** | 7 | `browser_navigate`、`browser_click`、`browser_scroll`、`browser_screenshot`、`browser_go_back`、`browser_go_forward`、`browser_close` |
| **Perception** | 4 | `ocr_image`（OCR 识别）、`describe_image`（图像描述）、`transcribe_audio`（语音转录）、`parse_document`（文档解析） |

**工具分发**：`chat-agent.ts` 的 `executeTool()` 函数用一个大的 `switch(name)` 分发到具体实现。

**路径安全**：`task-tools.ts` 的 `resolvePath()` 检查路径是否在项目目录或用户家目录（USERPROFILE/HOME）内，防止 Agent 读写任意路径。

### 4.4 Memory 系统（6 种记忆）

Z Code 有 **6 种记忆子系统**，模拟人类大脑的不同记忆类型：

| 记忆类型 | 类比 | 用途 | 示例 |
|---|---|---|---|
| **short-term** | 工作记忆 | 当前对话轮次 | "用户刚问了天气" |
| **long-term** | 长期记忆 | 持久事实和学习 | "用户的项目用 TypeScript" |
| **episodic** | 情节记忆 | 任务级经历 | "我在项目 Y 做过 X" |
| **semantic** | 语义记忆 | 概念级知识 | "我知道 React 是前端框架" |
| **procedural** | 程序记忆 | 技能级能力 | "我能做代码审查" |
| **preference** | 偏好记忆 | 用户喜好 | "用户喜欢简洁回答" |

**持久化方式**：JSONL append-only 文件（`memories.jsonl`），每条记录一行 JSON。删除通过追加 tombstone 记录实现。

**向量召回**：可插拔的 `IEmbeddingProvider`（默认本地 n-gram 嵌入）+ `IVectorStore`（默认 InMemoryVectorStore，余弦相似度）。

### 4.5 Trace 系统（可观测性）

每次任务执行都会生成完整的 **Span 树**，类似 OpenTelemetry：

```text
orchestrator:sequential (root Span)
├── agent:chat-agent (type=agent)
│   ├── llm:planning (type=llm, tokens=512)
│   ├── tool:web_search (type=tool)
│   │   └── llm:generate (type=llm)
│   ├── tool:web_fetch (type=tool)
│   ├── tool:write_file (type=tool)
│   │   └── confirmation:gate (type=tool)
│   └── llm:final-answer (type=llm)
└── memory:save (type=memory)
```

**9 种 SpanType**：`llm` / `tool` / `planner` / `verify` / `reflection` / `routing` / `memory` / `skill` / `agent`

**持久化方式**：JSONL append-only（`runs.jsonl` + `spans.jsonl` + `traces/<runId>.jsonl`），写入用 atomic rename 保证 crash safety。

**UI 可视化**：Desktop 的 Trace 面板显示 Span 树 + 过滤 + 导出。

### 4.6 Orchestrator（多 Agent 协调）

当任务需要多个 Agent 协作时，Orchestrator 负责调度：

**三种执行模式**：
| 模式 | 行为 | 适用场景 |
|---|---|---|
| **sequential** | 按拓扑序逐个执行，任一失败即停止 | 有依赖关系的任务链 |
| **parallel** | 所有 Agent 并发执行，聚合结果 | 独立任务并行 |
| **dag** | 按依赖分波次，同波并发，波间串行 | 复杂依赖图 |

**协作机制**：
- **SharedState 黑板**：Agent 通过 `ctx.sharedState.get/set` 读写共享状态
- **AgentRegistry**：按 capability 注册/查找，`canHandle` 评分路由
- **Budget 控制**：每个 Agent 消费 BudgetGuard，超限则剩余 Agent 跳过
- **maxAgentCalls**（默认 16）：防止无限循环

### 4.7 HITL（Human-in-the-Loop）确认门

Agent 执行敏感操作前，会弹出确认窗口让用户决策：

**5 级风险分级**：
| 级别 | 含义 | 默认行为 | 示例 |
|---|---|---|---|
| `safe` | 只读、无副作用 | 自动允许 | `read_file` / `list_directory` |
| `low` | 低风险写操作 | 自动允许 | `write_file`（新建） |
| `medium` | 中等风险写操作 | 需确认 | `write_file`（覆盖）/ `run_terminal`（安全命令） |
| `high` | 高风险操作 | 需确认 | `run_terminal`（任意命令） |
| `critical` | 极高风险 | 需确认（强制） | `rm -rf` / 删数据库 / 改密码 |

**4 种决策**：Allow / Deny / Always Allow / Always Deny（后两种持久化到 `always-rules.json`）

**审计日志**：所有决策记录到 JSONL 审计日志（`audit/<runId>.jsonl`），支持按 runId / toolName / outcome / 时间范围过滤。

### 4.8 Dry-run 模式（模拟执行）

用户可在 Settings 中开启 Dry-run 模式。开启后，Agent 的所有工具调用**不真正执行**，而是返回模拟描述：

```text
write_file → "将写入 C:\Users\...\weather.md（128 字节）"
run_terminal → "将执行命令: npm test"
web_search → "将搜索: 北京天气"
```

用途：让用户预览 Agent 的完整计划，确认无误后再关闭 Dry-run 真正执行。

---

## 五、构建和测试

### 5.1 Monorepo 管理

使用 **npm workspaces**（非 pnpm/yarn）。所有包在根 `package.json` 的 `workspaces` 字段声明。

TypeScript 使用 **Project References** + `composite: true` + `incremental: true` 实现增量构建。

### 5.2 常用命令

```bash
# 安装依赖（根目录）
npm install

# 构建所有包
npm run build

# 类型检查所有包
npm run typecheck

# 运行所有测试
npm test

# 运行单个包的测试
npm test --workspace=@z-assistant/runtime

# Desktop 一键打包（Windows）
.\build-all.ps1
# 产物：apps/desktop/dist/win-unpacked/Z Assistant.exe
```

### 5.3 测试框架

使用 **Node.js 内置 `node:test`** + `node:assert`（非 Jest/Mocha）。

测试文件位于各包的 `__tests__/` 目录下，编译后用 `node --test` 运行。

### 5.4 依赖规则

```text
contracts  ← 任何包可依赖（叶子包）
infra/*    ← 互相不依赖
trace      ← 不依赖 runtime
runtime    ← 依赖 trace + infra/* + contracts
agents/*   ← 依赖 runtime + contracts
apps/*     ← 可依赖任何 packages/*

禁止：packages/* → apps/*
禁止：packages/* → vscode（CI grep 验证）
```

---

## 六、关键设计决策

| 决策 | 选择 | 原因 |
|---|---|---|
| **桌面框架** | Electron（非 Tauri） | 生态成熟，Node.js 兼容性好 |
| **Monorepo 工具** | npm workspaces（非 pnpm） | 零额外依赖，Node.js 原生支持 |
| **测试框架** | node:test（非 Jest） | 零依赖，Node.js 原生 |
| **推理模式** | Plan + ReAct + Reflect 混合 | Plan 提供方向，ReAct 提供灵活性，Reflect 提供纠错 |
| **LLM 后端** | OpenAI 兼容接口 | 支持 OpenAI / DeepSeek / Anthropic / Gemini / Ollama |
| **工具调用** | Native function calling + XML fallback | 兼容不支持 function calling 的模型 |
| **持久化** | JSONL append-only | 简单、crash-safe、流式读 |
| **向量存储** | InMemoryVectorStore（默认） | 零依赖，可插拔升级到 LanceDB |
| **嵌入模型** | 本地 n-gram（默认） | 零外部依赖，可插拔升级到 sentence-transformers |
| **Browser 自动化** | Playwright | 跨浏览器，API 现代 |
| **GUI 自动化** | PowerShell / osascript / xdotool | 跨平台，无额外依赖 |
| **HITL 风险分级** | 5 级（safe/low/medium/high/critical） | 平衡安全与效率 |
| **审计日志** | JSONL append-only | 与 RunTracker 同模式，流式读 |
| **V1→V2 接入** | Adapter 模式（impl 注入） | V2 包不能 import V1（vscode 依赖） |

---

## 七、相关文档

| 文档 | 用途 |
|---|---|
| [ROADMAP-V2-Capability-Gap.md](./ROADMAP-V2-Capability-Gap.md) | V2 距离 marvis 的能力差距 + 执行进度 |
| [ADR-001-Architecture-Refactor-Revised.md](./ADR-001-Architecture-Refactor-Revised.md) | V2 架构重构决策（Phase 6A） |
| [ROADMAP_V2_ASSISTANT_RUNTIME.md](./ROADMAP_V2_ASSISTANT_RUNTIME.md) | V2 顶层技术路线 |
| [V2_VISION.md](./V2_VISION.md) | V2 产品愿景 |
| [SECURITY.md](./SECURITY.md) | 安全策略 |
| [ADRS/](./ADRS/) | 10 个架构决策记录 |
| ../AGENT_SPEC.md | V1 Coding Agent 构建规范（三层混合架构） |
| ../README.md | 项目主文档 |

---

**本文档**面向新手，目标是让没看过代码的人理解项目全貌。如需深入某个模块，请参考相关文档或直接阅读源码（各文件均有详细注释）。
