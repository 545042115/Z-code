# ADR-001: Phase 6A - Architecture First (Revised v2)

> **当前实现状态 (2026-06-18)**: 本 ADR 描述的目标结构已在仓库中落地。具体进度见末尾的 [§十一、当前实现状态与已落地项](#十一当前实现状态与已落地项)。配套的更细节设计见 [ADR-0007: Runtime 解耦](./ADRS/0007-runtime-decoupling.md)。

## 核心原则

**V1 = Coding Agent VSCode 扩展**（保留 + 维护）。

**V2 = 仓库主目录的 Assistant Runtime**（独立程序 CLI/Desktop，**不再是 VSCode 扩展**）。

VSCode 扩展**降级为 V2 的一个 Connector**（`apps/vscode-connector/`），不再承担 Agent 宿主职责。

**重构目标**：将 V1 中**通用 agent 功能**（与 VSCode 扩展无关、且跨 Agent 可复用的代码）从 `extensions/coding-agent/src/` 抽取到**仓库主目录**下，作为 V2 Assistant Runtime 的核心。**Coding 专用能力（仅服务 Coding Agent 的）+ VSCode 适配层**继续留在 V1。

**判断"是否上提"的标准**：

> **未来 Browser Agent / Research Agent / Office Agent 会不会用这个能力？**
> - 会用 → 上提到 V2（`packages/runtime/` 或 `packages/contracts/`）
> - 不会用 → 留 V1（Coding 专用或 VSCode 适配，放 `extensions/coding-agent/src/`）

**重要红线**：

1. **含 `import * as vscode from 'vscode'` 的文件必须留在 V1**（V2 通用 Runtime 不依赖 VSCode API）
2. **Coding 专用能力不迁**（架构评审、圈复杂度、代码检索、diff-engine、Coding Bench 等，Browser Agent 不会用）
3. **V1 仍能完整运行**（Coding 工作流不破坏）
4. **`packages/**` 内禁止 vscode 引用**（CI grep 验证）
5. **`packages/**` 内禁止 UI / DOM 依赖**

---

# 一、当前问题

V1 当前结构（`extensions/coding-agent/src/` 内部一切混在一起）：

```text
src/
├── agent/                       # Coding AgentLoop 核心
├── planner/                     # Coding Planner 模板
├── reflection/                  # Coding 复盘策略
├── discovery/                   # 代码库探索（Coding 专用）
├── context/                     # 混合（Coding 专用 + 通用）
│   ├── context-budget.ts          # 通用 token 预算
│   ├── retrieval/                 # ★ Coding 专用
│   ├── context-builder.ts         # ★ Coding 专用
│   ├── reranker.ts                # ★ Coding 专用
│   ├── impact-analyzer.ts         # ★ Coding 专用
│   ├── repo-map.ts                # ★ Coding 专用
│   ├── repo-graph.ts              # ★ Coding 专用
│   ├── context-manager.ts         # VSCode 耦合
│   ├── workspace-scanner.ts       # VSCode 耦合
│   ├── symbol-index.ts            # VSCode LSP
│   ├── dependency-graph.ts        # VSCode 耦合
│   └── context-expansion.ts       # VSCode 耦合
├── memory/                      # VSCode Memento 适配
├── skills/                      # Skill 框架 + Coding 特有 skill 内容
├── analysis/                    # ★ 全部 Coding 专用
│   ├── architecture-review/        # 架构评审
│   ├── change-impact/              # 变更影响
│   ├── complexity/                 # 圈复杂度
│   └── task-understanding/         # 任务理解
├── multi-agent/                 # 多 Agent 协调（通用）
├── trace/                       # 通用 Trace
├── trace-ui/                    # VSCode Trace Webview
├── evaluation/                  # Eval 框架 + Coding Bench 混合
├── evolution/                   # Evolution 框架 + Coding 策略混合
├── tools/                       # 工具注册（vscode 重度耦合）
├── llm/                         # LLM Provider（vscode 适配）
├── verifier/                    # Runtime Verifier（vscode 适配）
├── inline/                      # VSCode 行内补全
├── edit/                        # VSCode WorkspaceEdit
├── panels/                      # VSCode Webview
├── git/                         # VSCode Git API
├── embedding/                   # VSCode 嵌入存储
├── harness/                     # VSCode 调试
├── debug/                       # VSCode 调试命令
├── utils/
│   └── diff-engine.ts            # ★ Coding 专用（代码 diff）
├── infra/                       # 通用基础设施
│   ├── storage/                   # 通用存储
│   ├── config/                    # 通用配置
│   ├── permission/                # 通用权限
│   ├── cost/                      # 通用成本
│   ├── errors/                    # 通用错误
│   └── budget/                    # 通用 budget guard
├── contracts/                   # 跨包类型
└── extension.ts                 # VSCode 入口
```

**问题**：

1. V1 与 V2 混杂（V2 = Runtime 雏形 = 跨 Agent 通用能力，未独立）
2. 平台能力（通用基础设施）与 Coding 能力（领域知识）混杂
3. Agent 与 Runtime 边界不清晰
4. **V2 在 V1 内部 `src/` 下，无法平滑扩展**（未来 Research/Office Agent 会被 V1 的 Coding 知识污染）
5. 项目根没有 `package.json` / `tsconfig.json`（V2 应是仓库主目录）
6. 大量 Coding 专用能力混在通用能力中（如 `retrieval/` `architecture-review/` `diff-engine.ts`）

---

# 二、重构原则

## 本阶段允许

- 物理文件移动（V1 → V2 `packages/`）
- 通用机制 / 框架抽象（`packages/contracts/` 接口定义）
- 仓库根 `package.json` + `tsconfig.json` 创建
- 仓库根 `npm workspaces` 配置
- `apps/cli/` V2 CLI 入口创建
- V1 `extension.ts` 职责缩减（仅注册命令 / Panel / 初始化 Runtime）
- 通用 Skill / Eval / Evolution 框架（不实现 Coding 内容）

## 本阶段禁止

- **Desktop App / Electron / Tauri / Native App 实现**（仅在 `apps/desktop/` 占位）
- **Workflow Engine 实现**（仅在 `packages/runtime/src/workflow/` 占位）
- **Long-Term Memory V2 实现**（仅在 `packages/runtime/src/memory/` 占位）
- **Research Agent / Office Agent / Browser Agent 实现**（仅在 `packages/agents/` 占位 `research-agent/` `office-agent/` `browser-agent/`）
- **重写 AgentLoop / Planner / ReflectionEngine / ContextManager / Orchestrator 的核心逻辑**
- **把 Coding 专用能力错误地抽到 V2**（Coding Planner 模板 / Coding 复盘策略 / 代码检索 / diff-engine / Coding Bench 等）
- **直接新增跨包依赖**（必须经 `packages/contracts/` 接口）

---

# 三、目标目录结构

## 3.1 Phase 6A 完成后

> 实际落地结构（与原计划的差异已用 🆕 标注）。详见 [§十一](#十一当前实现状态与已落地项)。

```text
F:\Z-code\                                  # 仓库主目录（V2 Assistant Runtime）
│
├── README.md                                # V2 顶层说明
├── package.json                             # V2 根（npm workspaces）🆕
├── tsconfig.json                            # V2 根 🆕
├── .gitignore
│
├── docs/                                    # 已有 V2 文档
├── tools/                                   # 已有构建工具
├── coding-test/                             # 已有测试项目
│
├── extensions/
│   └── coding-agent/                        # V1 VSCode 扩展（保留 + 维护）
│       ├── package.json                     # v1.2.0+，依赖 @ziner/* 🆕
│       ├── tsconfig.json                    # 含 path alias + project references 🆕
│       └── src/
│           ├── extension.ts                 # V1 VSCode 入口
│           ├── panels/                      # V1 私有 Webview
│           ├── inline/                      # V1 私有 inline
│           ├── edit/                        # V1 私有 edit
│           ├── tools/                       # V1 Coding 工具（vscode 适配）
│           ├── llm/                         # V1 LLM 适配
│           ├── verifier/                    # V1 Verifier 适配
│           ├── skills/                      # V1 Coding 特有 Skill 内容
│           ├── context/                     # V1 context（Coding 专用 + VSCode 耦合）
│           ├── memory/                      # V1 memory 适配（VSCode Memento）
│           ├── embedding/                   # V1 embedding
│           ├── git/                         # V1 git 适配
│           ├── discovery/                   # V1 discovery（Coding 专用）
│           ├── harness/                     # V1 harness
│           ├── debug/                       # V1 debug
│           ├── trace-ui/                    # V1 trace UI
│           ├── trace/                       # V1 trace 入口（shim → @ziner/trace）🆕
│           │   ├── index.ts                 # 兼容 shim 文件
│           │   └── trace-adapter.ts         # V1 类型适配（LLMProvider/ToolRegistry/Pipeline）
│           ├── planner/                     # V1 Coding Planner 模板
│           ├── reflection/                  # V1 Coding 复盘策略
│           ├── analysis/                    # V1 Coding 专用分析
│           ├── agent/                       # V1 Coding Agent 核心
│           ├── utils/                       # V1 工具（含 diff-engine.ts）
│           ├── evaluation/                  # V1 Coding 特有 Bench
│           ├── evolution/                   # V1 Coding 特有策略
│           ├── multi-agent/                 # 迁移期间保留（V1 内部使用）🆕
│           ├── infra/                       # V1 内部基础设施（迁移后变空 shim）🆕
│           └── contracts/                   # V1 contracts shim → @ziner/contracts 🆕
│
├── packages/                                # V2 通用功能
│   ├── contracts/                           # 跨包类型 (@ziner/contracts) 🆕独立包
│   │   └── src/
│   │       ├── index.ts
│   │       ├── run.ts                       # AgentRun / Span / Metric
│   │       ├── agent.ts                     # IAgent / TaskContext / AgentResult
│   │       ├── config.ts                    # ConfigSpec
│   │       ├── eval.ts                      # Benchmark / EvalConfig
│   │       ├── verifier.ts                  # IVerifier
│   │       ├── llm.ts                       # ILLMProvider
│   │       ├── tool.ts                      # ITool / IToolRegistry
│   │       ├── planner.ts                   # IPlanner
│   │       ├── reflection.ts                # IReflectionEngine
│   │       ├── context.ts                   # IContextProvider
│   │       ├── skill.ts                     # ISkillRegistry
│   │       ├── budget.ts                    # IBudgetGuard
│   │       └── ...
│   │
│   ├── infra/                               # 跨包工具（独立子包族）🆕
│   │   ├── errors/                          # @ziner/infra-errors
│   │   ├── cost/                            # @ziner/infra-cost
│   │   ├── storage/                         # @ziner/infra-storage
│   │   ├── permission/                      # @ziner/infra-permission
│   │   └── config/                          # @ziner/infra-config
│   │
│   ├── trace/                               # V2 Trace 独立包 (@ziner/trace) 🆕独立
│   │   └── src/
│   │       ├── span.ts                      # Span 生命周期
│   │       ├── run-tracker.ts               # RunTracker + TraceManager
│   │       ├── instrumentation.ts           # 通用 Instrumenter（duck-typed）
│   │       ├── projections.ts               # UI 投影（listRuns / listSpanNodes / 等）
│   │       └── index.ts
│   │
│   ├── runtime/                             # V2 Runtime 平台（机制 + 框架）
│   │   └── src/
│   │       ├── index.ts                     # 组合入口（导出 RUNTIME_VERSION + 各子模块）
│   │       ├── trace/                       # 占位 re-export（实际逻辑在 packages/trace）🆕
│   │       ├── storage/                     # 占位 re-export（实际逻辑在 packages/infra/storage）🆕
│   │       ├── cost/                        # 占位 re-export（实际逻辑在 packages/infra/cost）🆕
│   │       ├── errors/                      # 占位 re-export（实际逻辑在 packages/infra/errors）🆕
│   │       ├── permission/                  # 占位 re-export（实际逻辑在 packages/infra/permission）🆕
│   │       ├── config/                      # 占位 re-export（实际逻辑在 packages/infra/config）🆕
│   │       ├── budget/                      # 占位 re-export（实际逻辑在 packages/infra/）🆕
│   │       ├── orchestrator/                # 多 Agent 协调（agent-registry / shared-state / orchestrator）
│   │       ├── planning/                    # 通用 Planner 框架（Plan/Step/DAG 调度器）
│   │       ├── reflection/                  # 通用 Reflection 框架
│   │       ├── context/                     # 通用 Context 框架（context-budget + registry）
│   │       ├── skills/                      # 通用 Skill 框架（loader/selector/validator）
│   │       ├── evaluation/                  # 通用 Eval 框架（benchmark-runner / candidate-adapter / rubric / sandbox）
│   │       ├── evolution/                   # 通用 Evolution 框架
│   │       ├── workflow/                    # 占位：未来 Workflow Engine
│   │       └── memory/                      # 占位：未来 Long-Term Memory
│   │
│   └── agents/
│       ├── coding-agent/                    # V2 Coding Agent 接口适配（薄薄一层）
│       │   └── src/
│       │       ├── agent-core.ts            # 包装 V1 agent/agent-core.ts
│       │       ├── agent-loop-adapter.ts    # IAgent 适配（接入 V2 Orchestrator）
│       │       ├── planner.ts               # Coding Planner 实现 V2 IPlanner
│       │       ├── reflection.ts            # Coding Reflection 实现 V2 IReflectionEngine
│       │       ├── context.ts               # Coding context providers 实现 V2 IContextProvider
│       │       ├── skills.ts                # Coding 特有 Skill（注册到 V2 ISkillRegistry）
│       │       ├── tools.ts                 # Coding 特有 Tool（注册到 V2 IToolRegistry）
│       │       ├── verifier.ts              # Coding 专用 Verifier（实现 V2 IVerifier）
│       │       └── index.ts
│       ├── research-agent/                  # 占位：未来 Research Agent
│       ├── office-agent/                    # 占位：未来 Office Agent
│       └── browser-agent/                   # 占位：未来 Browser Agent
│
└── apps/                                    # V2 宿主入口
    ├── cli/                                 # V2 CLI 入口（独立程序，**不是 VSCode 扩展**）
    │   └── src/
    │       └── index.ts                     # argv 解析 + 子命令分发
    ├── desktop/                             # 占位：未来 Desktop 入口
    │   └── src/
    │       └── index.ts
    └── vscode-connector/                    # V2 在 VSCode 上的 Connector（桥接 V1）
        └── src/
            └── index.ts                     # VSCodeConnector + AssistantRuntime 桥接
```

**与原计划的关键差异**：

1. 🆕 **`packages/contracts` / `packages/infra/*` / `packages/trace`** 拆为独立 package（每个有独立的 `package.json` + `tsconfig.json` + `index.ts`），便于独立发布和复用。原计划把它们都放在 `packages/runtime/src/` 下，实际拆开后依赖关系更清晰。
2. 🆕 **`packages/runtime` 内部子包**（trace / storage / cost / errors / permission / config / budget）现为 re-export shim，真实实现在 `packages/infra/*` 和 `packages/trace`。这样既保留旧的 `@ziner/runtime/{trace,storage,...}` 入口，又确保单一实现来源。
3. 🆕 **V1 保留 shim 文件**（`src/contracts/index.ts`、`src/trace/index.ts`、`src/infra/*/index.ts`），迁移期间不破坏 V1 现有 import 路径。
4. 🆕 **`apps/vscode-connector` 与 `apps/cli` 已建立**，含真实可启动的入口（CLI 已有 argv 解析和子命令）。

## 3.2 判断标准总结

| 归属 | 判定 |
|---|---|
| **V2 `packages/runtime/`** | 机制层（无业务）+ 框架层（提供机制让 Coding / 未来 Browser / Research 注册）|
| **V2 `packages/contracts/`** | 跨包类型 + 接口 |
| **V2 `packages/agents/coding-agent/`** | Coding 业务在 V2 通用接口上的**薄适配层**（不重复实现 Coding 业务）|
| **V2 `apps/{cli, desktop, vscode-connector}/`** | V2 宿主入口 |
| **V1 `extensions/coding-agent/src/`** | VSCode 适配（vscode.* import）+ Coding 业务实现 |

---

# 四、目录迁移清单

> 状态标注说明：✅ 已完成 · 🟡 进行中 · ⏳ 待开始 · ❌ 不迁（与本 ADR 决策一致）。
> 各步骤的细节与 shim 实现见 [§十一](#十一当前实现状态与已落地项)。

## 4.1 物理迁到 V2 `packages/infra/*`（机制层）✅ 已完成

```text
src/infra/storage/          → packages/infra/storage/        ✅ (@ziner/infra-storage)
src/infra/cost/             → packages/infra/cost/           ✅ (@ziner/infra-cost)
src/infra/errors/           → packages/infra/errors/         ✅ (@ziner/infra-errors)
src/infra/permission/       → packages/infra/permission/     ✅ (@ziner/infra-permission)
src/infra/config/           → packages/infra/config/         ✅ (@ziner/infra-config)
src/infra/budget/           → packages/infra/cost/budget.ts  ✅ (并入 cost 子包)
```

V1 端配套：在 `src/infra/*/index.ts` 留下 shim 文件 `export * from '@ziner/infra-*'`，确保 V1 旧 import 路径全部继续工作。

## 4.2 物理迁到 V2 `packages/runtime/`（框架层）✅ 已完成

```text
src/planner/         框架部分   → packages/runtime/src/planning/        ✅
src/reflection/      框架部分   → packages/runtime/src/reflection/       ✅
src/skills/          框架部分   → packages/runtime/src/skills/           ✅
src/evaluation/      框架部分   → packages/runtime/src/evaluation/       ✅ (benchmark-runner / candidate-adapter / rubric / sandbox)
src/evolution/       框架部分   → packages/runtime/src/evolution/        ✅
src/context/context-budget.ts   → packages/runtime/src/context/context-budget.ts  ✅
```

**注意**：

- `planner/` `reflection/` `skills/` `evaluation/` `evolution/` 内部的 **Coding 实现部分**（具体模板 / 策略 / Bench）**继续留 V1**。
- 例如 `planner/plan-templates/coding.ts` 这种 Coding 模板留 V1，不迁 V2。
- V1 `evaluation/` 与 `evolution/` 下的 **panel** 适配（VSCode Webview）也留 V1。

## 4.3 物理迁到 V2 `packages/trace/` 与 `packages/runtime/src/orchestrator/`（机制层：trace + multi-agent）✅ 已完成

```text
src/trace/span.ts                → packages/trace/src/span.ts             ✅
src/trace/run-tracker.ts         → packages/trace/src/run-tracker.ts      ✅
src/trace/instrumentation.ts     → packages/trace/src/instrumentation.ts  ✅ (拆为 V2 Instrumenter + V1 trace-adapter)
src/trace-ui/query-service.ts    → packages/trace/src/projections.ts     ✅ (projection 逻辑)
                                 + apps/vscode-connector/src/webviews/trace/ (UI 逻辑) ⏳
src/multi-agent/                 → packages/runtime/src/orchestrator/     ✅ (agent-registry / shared-state / orchestrator)
                                 + packages/agents/coding-agent/src/agent-loop-adapter.ts ✅
```

**关于 query-service 的拆分**：

- **V2 投影逻辑**（`projectRunSummary` / `listRunSummaries` / `listSpanNodes` / `aggregateEvaluations` / `projectToolUsage` / `projectSkillUsage` / `projectVariantStats` 等）→ `packages/trace/src/projections.ts`
- **V1 UI 特定逻辑**（调用 `vscode.window` / `vscode.workspace`、渲染 Webview 等）→ 保留在 `src/trace-ui/query-service.ts` 内部

## 4.4 物理迁到 V2 `packages/contracts/`（跨包类型）✅ 已完成

```text
src/contracts/           → packages/contracts/src/     ✅
```

V1 端：在 `src/contracts/index.ts` 留下 shim 文件 `export * from '@ziner/contracts'`。

## 4.5 物理迁到 V2 `packages/agents/coding-agent/`（V2 接口适配）✅ 已完成

**不移动 V1 内的 Coding 业务实现**，只在 V2 适配层创建薄包装：

- `packages/agents/coding-agent/src/agent-core.ts`（包装 V1 `agent/agent-core.ts`）✅
- `packages/agents/coding-agent/src/agent-loop-adapter.ts`（包装 V1 `agent/agent-loop-adapter.ts`）✅
- `packages/agents/coding-agent/src/planner.ts`（实现 V2 IPlanner，import V1 `planner/`）✅
- `packages/agents/coding-agent/src/reflection.ts`（实现 V2 IReflectionEngine，import V1 `reflection/`）✅
- `packages/agents/coding-agent/src/context.ts`（实现 V2 IContextProvider，import V1 `context/retrieval/` 等）✅
- `packages/agents/coding-agent/src/skills.ts`（注册 V1 `skills/` Coding 特有 skill 到 V2 ISkillRegistry）✅
- `packages/agents/coding-agent/src/tools.ts`（注册 V1 `tools/` Coding 工具到 V2 IToolRegistry）✅
- `packages/agents/coding-agent/src/verifier.ts`（实现 V2 IVerifier，import V1 `verifier/`）✅

## 4.6 创建 V2 入口

- `apps/cli/src/index.ts`：V2 CLI 入口（独立程序）✅（已含 argv 解析 + 子命令分发）
- `apps/vscode-connector/src/index.ts`：桥接 V1（让 V1 通过 import 接入 V2）✅（已含 VSCodeConnector + AssistantRuntime stub）
- `apps/desktop/src/index.ts`：占位 ✅

## 4.7 仓库根配置 ✅ 已完成

- 创建 `F:\Z-code\package.json`（V2 根，npm workspaces 含 `packages/*` 与 `apps/*`）✅
- 创建 `F:\Z-code\tsconfig.json`（V2 根，path alias `@coding-agent/*`）✅
- 创建 `F:\Z-code\.gitignore`（V2 根，排除 `node_modules/` `out/` `dist/` `.env` 等）✅

---

# 五、不迁清单（V1 保留）

## 5.1 VSCode 适配层（必须留 V1）

```text
src/extension.ts                    # VSCode 入口
src/panels/                         # VSCode Webview
src/inline/                         # VSCode 行内补全
src/edit/                           # VSCode WorkspaceEdit
src/tools/                          # Coding 工具 vscode 适配层
src/llm/                            # VSCode LLM Provider
src/verifier/                       # VSCode child_process 适配
src/git/                            # VSCode Git API
src/embedding/                      # VSCode 嵌入存储
src/harness/                        # VSCode 调试
src/debug/                          # VSCode 调试命令
src/trace-ui/                       # VSCode Trace Webview
src/memory/                         # VSCode Memento
src/context/
  ├── workspace-scanner.ts          # VSCode 耦合
  ├── symbol-index.ts               # VSCode LSP
  ├── dependency-graph.ts           # VSCode 耦合
  ├── context-expansion.ts          # VSCode 耦合
  └── context-manager.ts            # VSCode 耦合
```

## 5.2 Coding 专用能力（不迁 V2，未来 Browser/Research/Office Agent 不会用）

```text
src/agent/                          # Coding AgentLoop 核心（Plan→Execute→Verify→Repair）
  ├── agent-core.ts
  ├── agent-loop.ts
  ├── agent-pipeline.ts
  ├── pipeline-types.ts
  └── verifier.ts                   # Coding 专用 TS 编译 / ESLint / 单测
src/planner/（Coding 模板部分）
src/reflection/（Coding 复盘策略部分）
src/discovery/                      # 代码库探索
src/analysis/                       # 全部 Coding 专用
  ├── architecture-review/            # 架构评审
  ├── change-impact/                  # 变更影响
  ├── complexity/                     # 圈复杂度
  └── task-understanding/             # 任务理解
src/utils/diff-engine.ts            # 代码 diff
src/context/
  ├── impact-analyzer.ts            # 变更影响分析
  ├── repo-map.ts                   # 代码地图
  ├── repo-graph.ts                 # 依赖图
  ├── retrieval/                    # 代码检索
  ├── hybrid-retrieval.ts           # 混合检索
  ├── symbol-retrieval.ts           # 符号检索
  ├── reranker.ts                   # 重排序
  └── context-builder.ts            # 构造代码上下文
src/skills/（Coding 特有 Skill 内容）   # 具体 skill 文件（PR review / refactor）
src/evaluation/（HumanEval / SWE-bench 等 Coding Bench）
src/evolution/（Coding 特有策略）
```

## 5.3 为什么这些不迁

- **`agent/`**：Plan→Execute→Verify→Repair 4 步循环耦合 Coding 概念（Verify 跑 tsc / Repair 回滚代码）—— Browser Agent 的"修复"是回滚操作，不是回滚代码
- **`analysis/*`**：4 个分析全是 Coding 概念（架构 / 变更影响 / 圈复杂度 / 任务理解）—— Browser Agent 不需要圈复杂度
- **`context/{retrieval, builder, repo-map, ...}`**：代码检索 / 代码地图 / 构造代码上下文 —— Browser Agent 探索的是 DOM
- **`utils/diff-engine.ts`**：代码 diff —— Browser Agent 关心的是 DOM diff
- **`skills/` 内容**：V1 内的 `skill-loader.ts` 等是**机制**（可上提），但**具体 skill 文件**（PR review / refactor）留 V1
- **`evaluation/` Coding Bench**：HumanEval / SWE-bench 是 Coding 专用 —— Browser Agent 跑 web 任务
- **`discovery/`**：探索代码库 —— Browser Agent 探索 DOM
- **`trace-ui/`**：VSCode Webview —— V2 用不上 VSCode
- **`memory/`**（VSCode Memento）：当前是 VSCode 适配，通用 Long-Term Memory 还没实现（仅占位）

---

# 六、Coding Agent 定位

**V1 内部 Coding Agent**（`src/agent/`）保留：完整的 Coding 业务实现（Plan→Execute→Verify→Repair）。

**V2 Coding Agent 适配层**（`packages/agents/coding-agent/`）只做一件事：**把 V1 Coding AgentLoop 接入 V2 Orchestrator**（IAgent 适配）。不重复实现 Coding 业务。

Coding Agent 负责：

```text
PLAN          # 规划 Coding 任务
EXECUTE       # 执行 Coding 动作（写代码 / 改文件 / 跑命令）
VERIFY        # 验证（跑 tsc / eslint / 测试）
REFLECT       # 复盘（看 git diff / 测试结果）
REPLAN        # 重新规划（修复失败）
```

属于**专家 Agent**（Expert Agent），受益于 V2 通用 Runtime：

- V2 Orchestrator 调度
- V2 Trace 记录全流程
- V2 Budget 限制
- 未来 V2 Memory 沉淀 Coding 经验
- 未来 V2 Skill 复用 Coding 模式

---

# 七、Runtime 定位

**V2 Runtime**（`packages/runtime/`）不直接处理 Coding 业务，只提供**机制 + 框架**：

```text
机制层（无业务）：
- trace        通用 Span / Run / Metric
- storage      通用 JSONL / SQLite
- cost         通用成本计算
- errors       通用错误分类
- permission   通用权限
- config       通用配置中心
- budget       通用 budget guard
- orchestrator 多 Agent 协调

框架层（提供机制让 Coding / 未来 Browser / Research 注册）：
- planning     Plan / Step / DAG 模型 + 调度逻辑
- reflection   复盘机制（评估上次执行 + 给出建议）
- context      token 预算 + IContextProvider 注册
- skills       loader / selector / validator
- evaluation   EvalRunner + Benchmark 接口
- evolution    Evolution 引擎机制

占位（未来扩展）：
- workflow     未来 Workflow Engine
- memory       未来 Long-Term Memory
```

未来所有 Agent（V1 Coding / 未来 Research / Office / Browser）**共用 V2 Runtime**。

---

# 八、extension.ts 调整

**保留**：`extensions/coding-agent/src/extension.ts`

**职责缩减**：

```text
extension.ts
    ↓
Runtime Bootstrap (V2 packages/runtime/)
    ↓
Runtime Services (V2 packages/runtime/)
    ↓
Coding Agent (V1 src/agent/ 通过 packages/agents/coding-agent/ 接入)
```

**extension.ts 只负责**：

- 注册 VSCode 命令
- 注册 Panel（chat-panel / composer-panel / trace-panel / evaluations-panel / evolution-panel / ...）
- 初始化 V2 Runtime
- 桥接 V1 ↔ V2

**不承载业务逻辑**。

---

# 九、执行步骤

> 状态标注说明：✅ 已完成 · 🟡 进行中 · ⏳ 待开始 · ❌ 不迁（与本 ADR 决策一致）。
> 与 [§四 目录迁移清单](#四目录迁移清单) 一一对应。

## Step 1：创建 V2 根配置 ✅

- 创建仓库根 `F:\Z-code\package.json`（V2 根，npm workspaces）✅
- 创建仓库根 `F:\Z-code\tsconfig.json`（V2 根，path alias）✅
- 创建仓库根 `F:\Z-code\.gitignore`（V2 根）✅

## Step 2：创建 V2 目录骨架 ✅

- 创建 `F:\Z-code\packages\contracts\src\` ✅
- 创建 `F:\Z-code\packages\runtime\src\`（含 8 个机制层 + 6 个框架层 + 2 个占位）✅
- 创建 `F:\Z-code\packages\infra\{errors,cost,storage,permission,config}\` ✅
- 创建 `F:\Z-code\packages\trace\src\` ✅
- 创建 `F:\Z-code\packages\agents\coding-agent\src\` ✅
- 创建 `F:\Z-code\packages\agents\{research-agent, office-agent, browser-agent}\`（占位）✅
- 创建 `F:\Z-code\apps\cli\src\` ✅
- 创建 `F:\Z-code\apps\desktop\`（占位）✅
- 创建 `F:\Z-code\apps\vscode-connector\src\` ✅

## Step 3：迁出 contracts ✅

- 物理移动 `src/contracts/` → `packages/contracts/src/` ✅
- V1 端 shim：`extensions/coding-agent/src/contracts/index.ts` = `export * from '@ziner/contracts'` ✅
- 验证：V1 `extensions/coding-agent/src/contracts/README.md` 标注迁移说明 ✅

## Step 4：迁出 infra（机制层）✅

- 物理移动 `src/infra/storage/` → `packages/infra/storage/` ✅
- 物理移动 `src/infra/cost/` → `packages/infra/cost/` ✅
- 物理移动 `src/infra/errors/` → `packages/infra/errors/` ✅
- 物理移动 `src/infra/permission/` → `packages/infra/permission/` ✅
- 物理移动 `src/infra/config/` → `packages/infra/config/` ✅
- 物理移动 `src/infra/budget/` → `packages/infra/cost/budget.ts`（并入 cost 子包）✅
- V1 端 shim：5 个 `src/infra/*/index.ts` 全部 `export * from '@ziner/infra-*'` ✅

## Step 5：迁出 trace + multi-agent（机制层）✅

- 物理移动 `src/trace/span.ts` → `packages/trace/src/span.ts` ✅
- 物理移动 `src/trace/run-tracker.ts` → `packages/trace/src/run-tracker.ts` ✅
- 物理移动 `src/trace/instrumentation.ts` → 拆为 V2 `packages/trace/src/instrumentation.ts`（通用 Instrumenter）+ V1 `src/trace/trace-adapter.ts`（V1 类型适配）✅
- 物理移动 `src/trace-ui/query-service.ts` 的 projection 逻辑 → `packages/trace/src/projections.ts` ✅
- `src/trace-ui/` 留 V1（VSCode 适配）✅
- 物理移动 `src/multi-agent/{agent-registry, shared-state, orchestrator}.ts` → `packages/runtime/src/orchestrator/` ✅
- 物理移动 `src/multi-agent/agent-loop-adapter.ts` → `packages/agents/coding-agent/src/agent-loop-adapter.ts` ✅

## Step 6：迁出 框架层 ✅

- 物理移动 `src/planner/` 框架部分 → `packages/runtime/src/planning/` ✅
- 物理移动 `src/reflection/` 框架部分 → `packages/runtime/src/reflection/` ✅
- 物理移动 `src/skills/` 框架部分 → `packages/runtime/src/skills/` ✅
- 物理移动 `src/evaluation/` 框架部分 → `packages/runtime/src/evaluation/` ✅
- 物理移动 `src/evolution/` 框架部分 → `packages/runtime/src/evolution/` ✅
- 物理移动 `src/context/context-budget.ts` → `packages/runtime/src/context/context-budget.ts` ✅
- **Coding 实现部分**（`planner/plan-templates/coding.ts` 等）**继续留 V1** ✅

## Step 7：创建 V2 Coding Agent 适配层 ✅

- 创建 `packages/agents/coding-agent/src/agent-core.ts`（包装 V1 `src/agent/agent-core.ts`）✅
- 创建 `packages/agents/coding-agent/src/agent-loop-adapter.ts`（包装 V1）✅
- 创建 `packages/agents/coding-agent/src/planner.ts`（实现 V2 IPlanner）✅
- 创建 `packages/agents/coding-agent/src/reflection.ts`（实现 V2 IReflectionEngine）✅
- 创建 `packages/agents/coding-agent/src/context.ts`（实现 V2 IContextProvider）✅
- 创建 `packages/agents/coding-agent/src/skills.ts`（注册 Coding Skill）✅
- 创建 `packages/agents/coding-agent/src/tools.ts`（注册 Coding Tool）✅
- 创建 `packages/agents/coding-agent/src/verifier.ts`（实现 V2 IVerifier）✅

## Step 8：创建 V2 入口 ✅

- 创建 `apps/cli/src/index.ts`（V2 CLI 入口，含 argv 解析 + 子命令分发）✅
- 创建 `apps/vscode-connector/src/index.ts`（桥接 V1，含 VSCodeConnector + AssistantRuntime stub）✅
- 创建 `apps/desktop/src/index.ts`（占位）✅

## Step 9：编译 + 测试 🟡

- V1 编译 0 错误 ✅（npm run typecheck 通过）
- V2 编译 0 错误 ✅（npm run typecheck 通过）
- V1 既有测试通过：`infra/storage` / `infra/errors` / `infra/cost` / `infra/permission` / `infra/config` / `multi-agent` ✅
- V1 `trace-ui` 测试 ⏳（已知失败，见 [§十一 风险与遗留](#十一风险与遗留)）
- V2 包测试：`contracts` / `trace` / `runtime`（orchestrator/evaluation/evolution）✅
- V1 `npm run package` 能产出 `.vsix` 🟡（需手动验证打包流程；当前可执行 `vsce package`）

## Step 10：输出新依赖图 ⏳

- 画出 V1 / V2 / V1↔V2 桥接 三个层级的依赖关系（详见 [§十一 §4 依赖图](#4-依赖图单向往下)）

---

# 十、成功标准

## 10.1 目录结构标准

- [x] 仓库根 `F:\Z-code\package.json` + `tsconfig.json` 存在 ✅
- [x] V2 顶层：`packages/{contracts, infra/*, trace, runtime, agents/{coding-agent, research-agent, office-agent, browser-agent}}/` + `apps/{cli, desktop, vscode-connector}/` ✅
- [x] V1 内部：`extensions/coding-agent/src/{agent, panels, inline, edit, tools, llm, verifier, context, memory, embedding, git, discovery, harness, debug, trace-ui, trace, planner, reflection, analysis, utils, evaluation, evolution, multi-agent, infra, contracts}/`（V2 通用功能已迁出；`infra/`、`trace/`、`contracts/` 留 shim）✅

## 10.2 编译测试标准

- [x] V1 编译 0 错误 ✅
- [x] V2 编译 0 错误 ✅
- [x] V1 既有 infra/multi-agent 测试通过 ✅
- [x] V2 包测试通过（`@ziner/contracts` / `@ziner/trace` / `@ziner/runtime`）✅
- [ ] V1 `npm run package` 产出 `.vsix` 🟡（需在 CI 上跑 `vsce package` 验证）

## 10.3 依赖关系标准

最终依赖关系（实际落地）：

```text
extensions/coding-agent/src/extension.ts   (V1)
        ↓
apps/vscode-connector/src/index.ts         (V2 Connector 桥接) 🆕
        ↓
packages/runtime/                          (V2 机制 + 框架组合)
        ↓
packages/trace/                            (V2 Trace 独立包) 🆕
packages/infra/{errors, cost, storage, permission, config}  (V2 工具包族) 🆕
packages/agents/coding-agent/              (V2 Coding 适配)
        ↓
extensions/coding-agent/src/agent/         (V1 Coding 业务实现)
        ↓
extensions/coding-agent/src/{planner, reflection, context, ...}  (V1 Coding 专用)
```

而不是（反模式）：

```text
extensions/coding-agent/src/agent/         (V1 Coding AgentLoop)
    ↓
src/trace/eval/evolution/                  (V1 内部的 Runtime —— 反了)
```

**V1 ↔ V2 桥接方向**（已落地）：
- V1 旧 import 路径（如 `from '../trace'`）通过 `extensions/coding-agent/src/trace/index.ts` shim → `@ziner/trace`
- V1 旧 import 路径（如 `from '../contracts'`）通过 `extensions/coding-agent/src/contracts/index.ts` shim → `@ziner/contracts`
- V1 旧 import 路径（如 `from '../infra/storage'`）通过 `extensions/coding-agent/src/infra/storage/index.ts` shim → `@ziner/infra-storage`
- V1 不直接 import `@ziner/runtime` 做副作用；通过 `apps/vscode-connector` 桥接（如未来需要）

## 10.4 未来扩展准备

- [x] `packages/agents/research-agent/` / `office-agent/` / `browser-agent/` 占位已建 ✅
- [x] `apps/desktop/` 占位已建 ✅
- [x] `packages/runtime/src/{workflow, memory}/` 占位已建 ✅
- [x] `packages/contracts/src/` 含 `IAgent` / `IPlanner` / `IReflectionEngine` / `IContextProvider` / `ISkillRegistry` / `IToolRegistry` / `IVerifier` / `ILLMProvider` / `IBudgetGuard` 接口 ✅

## 10.5 项目定位

完成后项目定位变为：

```text
仓库主目录（F:\Z-code\）
    = Assistant Runtime（V2）
    + 跨包类型（packages/contracts/）
    + 通用机制 + 框架（packages/runtime/ + packages/trace/ + packages/infra/*）
    + Coding Agent 适配（packages/agents/coding-agent/）
    + 多个宿主入口（apps/cli / apps/desktop / apps/vscode-connector/）

extensions/coding-agent/（V1）
    = VSCode 扩展
    + VSCode 适配层
    + Coding 专用业务实现（agent / planner / reflection / analysis / context / skills / evaluation / evolution）
```

为后续 Desktop Runtime / Research Agent / Office Agent / Long-Term Memory / Workflow Engine 预留扩展位，但本阶段不实现。

---

# 十一、当前实现状态与已落地项

> 本节为本 ADR 的**实施附录**，记录 Phase 6A 当前进度、Shim 机制、依赖图与遗留风险。配套的更细节设计见 [ADR-0007: Runtime 解耦](./ADRS/0007-runtime-decoupling.md)。

## 1. 已落地包（V2）

| 包名 | 路径 | 版本 | 职责 | 状态 |
|------|------|------|------|------|
| `@ziner/contracts` | `packages/contracts/` | 0.1.0 | 跨包类型 / 接口 | ✅ |
| `@ziner/infra-errors` | `packages/infra/errors/` | 0.1.0 | 错误码 + 分类器 | ✅ |
| `@ziner/infra-cost` | `packages/infra/cost/` | 0.1.0 | 价格 + budget | ✅ |
| `@ziner/infra-storage` | `packages/infra/storage/` | 0.1.0 | JSONL Store | ✅ |
| `@ziner/infra-permission` | `packages/infra/permission/` | 0.1.0 | fs / net / tool 守卫 | ✅ |
| `@ziner/infra-config` | `packages/infra/config/` | 0.1.0 | 配置中心 + secrets | ✅ |
| `@ziner/trace` | `packages/trace/` | 0.1.0 | Run / Span / Projection / Instrumenter | ✅ |
| `@ziner/runtime` | `packages/runtime/` | 0.1.0 | orchestrator / planning / reflection / context / skills / evaluation / evolution + 占位 workflow / memory | ✅ |
| `@ziner/agent-coding` | `packages/agents/coding-agent/` | 0.1.0 | Coding Agent V2 适配层 | ✅ |
| `@ziner/agent-research` | `packages/agents/research-agent/` | 0.1.0 | 占位 | ✅ |
| `@ziner/agent-office` | `packages/agents/office-agent/` | 0.1.0 | 占位 | ✅ |
| `@ziner/agent-browser` | `packages/agents/browser-agent/` | 0.1.0 | 占位 | ✅ |
| `@ziner/app-cli` | `apps/cli/` | 0.1.0 | V2 CLI 入口 | ✅ |
| `@ziner/app-vscode-connector` | `apps/vscode-connector/` | 0.1.0 | V2 VSCode 桥接 | ✅ |
| `@ziner/app-desktop` | `apps/desktop/` | 0.1.0 | 占位 | ✅ |

## 2. Shim 兼容机制（已落地）

为保证 V1 旧 import 路径不破坏，每个迁出到 V2 的模块在 V1 侧留有**单行 shim 文件**：

```typescript
// extensions/coding-agent/src/contracts/index.ts
// V1 contracts shim — re-exports from V2 @ziner/contracts.
export * from '@ziner/contracts';

// extensions/coding-agent/src/trace/index.ts
// Shim: V1 extension → @ziner/trace
export {
  Span, TraceManager, RunTracker,
  type SpanOptions, type RunStartOptions, type RunFinishOptions, type TraceManagerOptions,
} from '@ziner/trace';
export { TraceInstrumentation, type TraceInstrumentationOptions } from './trace-adapter';

// extensions/coding-agent/src/infra/storage/index.ts
export * from '@ziner/infra-storage';

// extensions/coding-agent/src/infra/errors/index.ts
export * from '@ziner/infra-errors';

// extensions/coding-agent/src/infra/cost/index.ts
export * from '@ziner/infra-cost';

// extensions/coding-agent/src/infra/permission/index.ts
export * from '@ziner/infra-permission';

// extensions/coding-agent/src/infra/config/index.ts
export * from '@ziner/infra-config';
```

**TypeScript Project References**：

V1 扩展的 `tsconfig.json` 通过 `references` 字段声明对 V2 包的依赖，确保增量构建与类型检查：

```jsonc
// extensions/coding-agent/tsconfig.json（节选）
{
  "references": [
    { "path": "../../packages/contracts" },
    { "path": "../../packages/infra/errors" },
    { "path": "../../packages/infra/cost" },
    { "path": "../../packages/infra/storage" },
    { "path": "../../packages/infra/permission" },
    { "path": "../../packages/infra/config" },
    { "path": "../../packages/trace" },
    { "path": "../../packages/runtime" },
    { "path": "../../packages/agents/coding-agent" }
  ]
}
```

**V1 package.json 依赖**：

```jsonc
// extensions/coding-agent/package.json（节选）
{
  "dependencies": {
    "@ziner/contracts": "0.1.0",
    "@ziner/infra-errors": "0.1.0",
    "@ziner/infra-cost": "0.1.0",
    "@ziner/infra-storage": "0.1.0",
    "@ziner/infra-permission": "0.1.0",
    "@ziner/infra-config": "0.1.0",
    "@ziner/trace": "0.1.0",
    "@ziner/runtime": "0.1.0"
  }
}
```

**测试脚本（V1）**：

```jsonc
{
  "scripts": {
    "test": "tsc -p ./ && node --test out/infra/storage/__tests__/*.test.js out/infra/errors/__tests__/*.test.js out/infra/cost/__tests__/*.test.js out/infra/permission/__tests__/*.test.js out/infra/config/__tests__/*.test.js out/trace-ui/__tests__/*.test.js out/multi-agent/__tests__/*.test.js"
  }
}
```

## 3. trace-ui/query-service.ts 拆分规则

V1 `extensions/coding-agent/src/trace-ui/query-service.ts` 在迁移期按以下规则拆分：

| 函数 / 类 | 归属 | 新位置 |
|-----------|------|--------|
| `listRuns()` / `listRunSummaries()` / `listSpanNodes()` | V2（纯函数 + Store 调用） | `packages/trace/src/projections.ts` |
| `readRunEvents()` | V2 | `packages/trace/src/projections.ts` |
| `listToolUsage()` / `listSkillUsage()` | V2 | `packages/trace/src/projections.ts` |
| `projectRunSummary()` / `projectSpanNode()` / `projectSpanEvent()` | V2 | `packages/trace/src/projections.ts` |
| `buildBaseline()` / `diffBaseline()` | V2 | `packages/trace/src/projections.ts` |
| `projectVariantStats()` / `computeScoreTrend()` | V2 | `packages/trace/src/projections.ts` |
| VSCode Webview 数据绑定（`vscode.window.*`、`vscode.workspace.*`） | V1 留 | `extensions/coding-agent/src/trace-ui/query-service.ts`（瘦身版） |

## 4. 依赖图（单向，往下）

```
                    apps/desktop
                    apps/vscode-connector     ← V2 桥接 V1
                    apps/cli
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   @ziner           @ziner            @ziner
     /runtime        /agents/coding    /agents/{research,office,browser}
        │                                  │
        │   ┌─────────┐  ┌─────────┐      │
        ├──►│ workflow│  │ memory  │◄─────┤ (占位)
        │   └────┬────┘  └────┬────┘      │
        │        │            │            │
        │   ┌────▼────┐  ┌────▼────┐      │
        ├──►│ trace   │  │ planning│      │
        │   └────┬────┘  │  skills │      │
        │        │       │  context│      │
        │   ┌────▼────┐  │  reflct │      │
        ├──►│evaluatn │  └────┬────┘      │
        │   └────┬────┘       │            │
        │   ┌────▼────┐       │            │
        └──►│evolution│       │            │
            └────┬────┘       │            │
                 │            │            │
                 ▼            ▼            ▼
          ┌──────────────────────────────┐
          │  @ziner/infra/*         │
          │  (errors/cost/storage/perm/   │
          │   config)                     │
          │  + @ziner/contracts     │
          │     (叶子，零依赖)             │
          └──────────────────────────────┘
```

**依赖规则（强制）**：
- `contracts` 是叶子，**任何包都允许**依赖
- `infra/*` 互相不依赖
- `trace` 不依赖 `runtime` 内部的 framework 子包
- `runtime` 依赖 `trace` + `infra/*` + `contracts`
- `agents/coding` 依赖 `runtime` + `contracts`
- `apps/*` 可依赖任何 `packages/*`
- ❌ `packages/*` → `apps/*` 禁止
- ❌ `packages/*` → `vscode` 禁止

## 5. 风险与遗留

| 风险 | 状态 | 备注 |
|------|------|------|
| V1 `src/trace-ui/__tests__/query-service.test.ts` 失败 | ⏳ 已知 | V1 旧测试数据 / 模拟方式与新 store 接口不完全兼容，需在 R10 整改 |
| V1 `src/evolution/__tests__/*` 失败 | ⏳ 已知 | 旧的 eval/fingerprint 测试数据已陈旧；与 evolution 框架迁移同步处理 |
| V1 `extensions/coding-agent` 内 `multi-agent/` 仍含 prompt-agent 等文件 | ⏳ R10 | 应最终全部迁出到 `packages/agents/`，但当前通过 shim 仍可用 |
| `apps/vscode-connector` 的 `AssistantRuntime.boot` 是 stub | ⏳ R7 | 当前返回 no-op runtime + 错误码 3001；R7 替换为真实实现 |
| 仓库根 `pnpm-workspace.yaml` 未启用 | ❌ 决策 | 当前使用 npm workspaces（决策见 ADR-0007 §十.1）；暂不切 pnpm |
| V1 旧 import 路径（`from '../trace'` 等）仍被允许 | 🟡 临时 | 为保证迁移期不破坏；CI lint 待加 `禁止 import 'extensions/coding-agent/src/infra' / 'src/contracts' / 'src/trace'`，必须走 `@ziner/*` |

## 6. 后续衔接（Phase 7~）

| 阶段 | 衔接内容 |
|------|----------|
| **Phase 7 Unified Memory** | `packages/runtime/src/memory/`（占位）已就位；需重做 V1 `src/memory/` → `packages/memory/`（独立顶级包，详见 ADR-0007 §一） |
| **Phase 8 Workflow Engine** | `packages/runtime/src/workflow/`（占位）已就位；`Workflow` / `WorkflowStep` 类型已在 `contracts` 中预留 |
| **Phase 9 Knowledge Hub** | `packages/connectors/filesystem/` 待建；`IConnector` interface 待加 |
| **Phase 10 Agent Ecosystem** | `packages/agents/coding/` 已完整；`@ziner/agents` 主包与 `IAgent` interface 已就位 |
| **Phase 11 Connectors** | `apps/vscode-connector` 是首个 connector；更多 connector（terminal / browser / git / filesystem）需独立建包 |
| **Phase 12 Full Observability** | `packages/trace` 已就位；`SpanType` 需扩 `'memory' / 'skill' / 'workflow' / 'connector'` |
| **Phase 13 Evaluation 2.0** | `packages/runtime/src/evaluation/` 已就位 |
| **Phase 14 Evolution 2.0** | `packages/runtime/src/evolution/` 已就位；`EvolutionEngine.generate({ scope: ... })` 扩展点待加 |

## 7. 文档交叉引用

- 配套细节设计：[ADR-0007 Runtime 解耦](./ADRS/0007-runtime-decoupling.md)
- 路线图：[ROADMAP_V2_ASSISTANT_RUNTIME.md](./ROADMAP_V2_ASSISTANT_RUNTIME.md)
- V2 愿景：[V2_VISION.md](./V2_VISION.md)
- 阶段交付文档：[PHASE0_FOUNDATION](./PHASE0_FOUNDATION.md) ~ [PHASE5_EVOLUTION](./PHASE5_EVOLUTION.md)

---

# 十二、ADR 变更历史

| 日期 | 版本 | 变更人 | 内容 |
|------|------|--------|------|
| 2026-06-17 | v1 | @Ziner V2 架构组 | 初稿，定义 Phase 6A 重构目标与原则 |
| 2026-06-18 | v2 | @Ziner V2 架构组 | 添加 [§十一 当前实现状态](#十一当前实现状态与已落地项)；更新 §3.1 目录结构、§四 迁移清单、§九 执行步骤、§十 成功标准，反映实际落地；新增 ADR-0007 引用 |

