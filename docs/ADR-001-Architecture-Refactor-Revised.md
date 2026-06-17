# ADR-001: Phase 6A - Architecture First (Revised v2)

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

```text
F:\Z-code\                                  # 仓库主目录（V2 Assistant Runtime）
│
├── README.md                                # V2 顶层说明
├── package.json                             # V2 根（npm workspaces）
├── tsconfig.json                            # V2 根
├── .gitignore
│
├── docs/                                    # 已有 V2 文档
├── tools/                                   # 已有构建工具
├── coding-test/                             # 已有测试项目
│
├── extensions/
│   └── coding-agent/                        # V1 VSCode 扩展（保留 + 维护）
│       ├── package.json                     # v1.3.0+（V1 仍可发布）
│       ├── tsconfig.json
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
│           ├── planner/                     # V1 Coding Planner 模板
│           ├── reflection/                  # V1 Coding 复盘策略
│           ├── analysis/                    # V1 Coding 专用分析
│           ├── agent/                       # V1 Coding Agent 核心
│           ├── utils/                       # V1 工具（含 diff-engine.ts）
│           ├── evaluation/                  # V1 Coding 特有 Bench
│           ├── evolution/                   # V1 Coding 特有策略
│           └── infra/                       # V1 内部基础设施（迁移后变空）
│
├── packages/                                # V2 通用功能
│   ├── contracts/                           # 跨包类型
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
│   ├── runtime/                             # V2 Runtime 平台（机制 + 框架）
│   │   └── src/
│   │       ├── trace/                       # 通用 Trace（Span / Run / Metric / QueryService）
│   │       ├── storage/                     # 通用 JSONL / SQLite 存储
│   │       ├── cost/                        # 通用成本计算
│   │       ├── errors/                      # 通用错误分类
│   │       ├── permission/                  # 通用权限
│   │       ├── config/                      # 通用配置中心
│   │       ├── budget/                      # 通用 budget guard
│   │       ├── planning/                    # 通用 Planner 框架（Plan/Step/DAG）
│   │       ├── reflection/                  # 通用 Reflection 框架
│   │       ├── context/                     # 通用 Context 框架（context-budget / registry）
│   │       ├── skills/                      # 通用 Skill 框架（loader/selector/validator）
│   │       ├── orchestrator/                # 多 Agent 协调
│   │       ├── evaluation/                  # 通用 Eval 框架
│   │       ├── evolution/                   # 通用 Evolution 框架
│   │       ├── workflow/                    # 占位：未来 Workflow Engine
│   │       └── memory/                      # 占位：未来 Long-Term Memory
│   │
│   └── agents/
│       ├── coding-agent/                    # V2 Coding Agent 接口适配（薄薄一层）
│       │   └── src/
│       │       ├── agent-loop-adapter.ts    # IAgent 适配（接入 V2 Orchestrator）
│       │       ├── planner/                 # Coding Planner 实现 V2 IPlanner
│       │       ├── reflection/              # Coding Reflection 实现 V2 IReflectionEngine
│       │       ├── context/                 # Coding context providers 实现 V2 IContextProvider
│       │       ├── skills/                  # Coding 特有 Skill（注册到 V2 ISkillRegistry）
│       │       ├── tools/                   # Coding 特有 Tool（注册到 V2 IToolRegistry）
│       │       ├── verifier/                # Coding 专用 Verifier（实现 V2 IVerifier）
│       │       └── index.ts
│       ├── research-agent/                  # 占位：未来 Research Agent
│       ├── office-agent/                    # 占位：未来 Office Agent
│       └── browser-agent/                   # 占位：未来 Browser Agent
│
└── apps/                                    # V2 宿主入口
    ├── cli/                                 # V2 CLI 入口（独立程序，**不是 VSCode 扩展**）
    │   └── src/
    ├── desktop/                             # 占位：未来 Desktop 入口
    │   └── src/
    └── vscode-connector/                    # V2 在 VSCode 上的 Connector（桥接 V1）
        └── src/bridge.ts
```

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

## 4.1 物理迁到 V2 `packages/runtime/`（机制层）

```text
src/infra/storage/          → packages/runtime/src/storage/
src/infra/cost/             → packages/runtime/src/cost/
src/infra/errors/           → packages/runtime/src/errors/
src/infra/permission/       → packages/runtime/src/permission/
src/infra/config/config-center.ts → packages/runtime/src/config/
src/infra/budget/           → packages/runtime/src/budget/
```

## 4.2 物理迁到 V2 `packages/runtime/`（框架层）

```text
src/planner/         框架部分   → packages/runtime/src/planning/
src/reflection/      框架部分   → packages/runtime/src/reflection/
src/skills/          框架部分   → packages/runtime/src/skills/
src/evaluation/      框架部分   → packages/runtime/src/evaluation/
src/evolution/       框架部分   → packages/runtime/src/evolution/
src/context/context-budget.ts   → packages/runtime/src/context/context-budget.ts
```

**注意**：

- `planner/` `reflection/` `skills/` `evaluation/` `evolution/` 内部的 **Coding 实现部分**（具体模板 / 策略 / Bench）**继续留 V1**。
- 例如 `planner/plan-templates/coding.ts` 这种 Coding 模板留 V1，不迁 V2。

## 4.3 物理迁到 V2 `packages/runtime/`（机制层：trace + orchestrator）

```text
src/multi-agent/         → packages/runtime/src/orchestrator/
src/trace/{core, query}  → packages/runtime/src/trace/core/
                           packages/runtime/src/trace/query/
```

## 4.4 物理迁到 V2 `packages/contracts/`（跨包类型）

```text
src/contracts/           → packages/contracts/src/
```

## 4.5 物理迁到 V2 `packages/agents/coding-agent/`（V2 接口适配）

**不移动 V1 内的 Coding 业务实现**，只在 V2 适配层创建薄包装：

- `packages/agents/coding-agent/src/agent-loop-adapter.ts`（包装 V1 `agent/agent-loop-adapter.ts`）
- `packages/agents/coding-agent/src/planner/index.ts`（实现 V2 IPlanner，import V1 `planner/`）
- `packages/agents/coding-agent/src/reflection/index.ts`（实现 V2 IReflectionEngine，import V1 `reflection/`）
- `packages/agents/coding-agent/src/context/index.ts`（实现 V2 IContextProvider，import V1 `context/retrieval/` 等）
- `packages/agents/coding-agent/src/skills/index.ts`（注册 V1 `skills/` Coding 特有 skill 到 V2 ISkillRegistry）
- `packages/agents/coding-agent/src/tools/index.ts`（注册 V1 `tools/` Coding 工具到 V2 IToolRegistry）
- `packages/agents/coding-agent/src/verifier/index.ts`（实现 V2 IVerifier，import V1 `verifier/`）

## 4.6 创建 V2 入口

- `apps/cli/src/index.ts`：V2 CLI 入口（独立程序）
- `apps/vscode-connector/src/bridge.ts`：桥接 V1（让 V1 通过 import 接入 V2）

## 4.7 仓库根配置

- 创建 `F:\Z-code\package.json`（V2 根，npm workspaces 含 `packages/*` 与 `apps/*`）
- 创建 `F:\Z-code\tsconfig.json`（V2 根，path alias `@coding-agent/*`）
- 创建 `F:\Z-code\.gitignore`（V2 根，排除 `node_modules/` `out/` `dist/` `.env` 等）

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

## Step 1：创建 V2 根配置

- 创建仓库根 `F:\Z-code\package.json`（V2 根，npm workspaces）
- 创建仓库根 `F:\Z-code\tsconfig.json`（V2 根，path alias）
- 创建仓库根 `F:\Z-code\.gitignore`（V2 根）

## Step 2：创建 V2 目录骨架

- 创建 `F:\Z-code\packages\contracts\src\`（占位）
- 创建 `F:\Z-code\packages\runtime\src\`（占位）
- 创建 `F:\Z-code\packages\agents\coding-agent\src\`（占位）
- 创建 `F:\Z-code\packages\agents\{research-agent, office-agent, browser-agent}\`（占位）
- 创建 `F:\Z-code\apps\cli\src\`（占位）
- 创建 `F:\Z-code\apps\desktop\`（占位）
- 创建 `F:\Z-code\apps\vscode-connector\src\`（占位）

## Step 3：迁出 contracts

- 物理移动 `src/contracts/` → `packages/contracts/src/`
- 更新 V1 import 路径

## Step 4：迁出 infra（机制层）

- 物理移动 `src/infra/storage/` → `packages/runtime/src/storage/`
- 物理移动 `src/infra/cost/` → `packages/runtime/src/cost/`
- 物理移动 `src/infra/errors/` → `packages/runtime/src/errors/`
- 物理移动 `src/infra/permission/` → `packages/runtime/src/permission/`
- 物理移动 `src/infra/config/config-center.ts` → `packages/runtime/src/config/`
- 物理移动 `src/infra/budget/` → `packages/runtime/src/budget/`
- 更新 V1 import 路径

## Step 5：迁出 trace + multi-agent（机制层）

- 物理移动 `src/trace/{core, query}` → `packages/runtime/src/trace/{core, query}`
- 物理移动 `src/multi-agent/` → `packages/runtime/src/orchestrator/`
- `src/trace-ui/` 留 V1（VSCode 适配）

## Step 6：迁出 框架层

- 物理移动 `src/planner/` 框架部分 → `packages/runtime/src/planning/`
- 物理移动 `src/reflection/` 框架部分 → `packages/runtime/src/reflection/`
- 物理移动 `src/skills/` 框架部分 → `packages/runtime/src/skills/`
- 物理移动 `src/evaluation/` 框架部分 → `packages/runtime/src/evaluation/`
- 物理移动 `src/evolution/` 框架部分 → `packages/runtime/src/evolution/`
- 物理移动 `src/context/context-budget.ts` → `packages/runtime/src/context/context-budget.ts`
- **Coding 实现部分**（`planner/plan-templates/coding.ts` 等）**继续留 V1**

## Step 7：创建 V2 Coding Agent 适配层

- 创建 `packages/agents/coding-agent/src/agent-loop-adapter.ts`（包装 V1 `src/agent/agent-loop-adapter.ts`）
- 创建 `packages/agents/coding-agent/src/planner/index.ts`（实现 V2 IPlanner）
- 创建 `packages/agents/coding-agent/src/reflection/index.ts`（实现 V2 IReflectionEngine）
- 创建 `packages/agents/coding-agent/src/context/index.ts`（实现 V2 IContextProvider）
- 创建 `packages/agents/coding-agent/src/skills/index.ts`（注册 Coding Skill）
- 创建 `packages/agents/coding-agent/src/tools/index.ts`（注册 Coding Tool）
- 创建 `packages/agents/coding-agent/src/verifier/index.ts`（实现 V2 IVerifier）

## Step 8：创建 V2 入口

- 创建 `apps/cli/src/index.ts`（V2 CLI 入口）
- 创建 `apps/vscode-connector/src/bridge.ts`（桥接 V1）

## Step 9：编译 + 测试

- V1 编译 0 错误，所有测试通过
- V2 编译 0 错误（如有测试则通过）
- V1 `npm run package` 能产出 `.vsix`

## Step 10：输出新依赖图

- 画出 V1 / V2 / V1↔V2 桥接 三个层级的依赖关系

---

# 十、成功标准

## 10.1 目录结构标准

- [ ] 仓库根 `F:\Z-code\package.json` + `tsconfig.json` 存在
- [ ] V2 顶层：`packages/{contracts, runtime, agents/{coding-agent, research-agent, office-agent, browser-agent}}/` + `apps/{cli, desktop, vscode-connector}/`
- [ ] V1 内部：`extensions/coding-agent/src/{agent, panels, inline, edit, tools, llm, verifier, context, memory, embedding, git, discovery, harness, debug, trace-ui, planner, reflection, analysis, utils, evaluation, evolution, contracts}/`（V2 通用功能已迁出）

## 10.2 编译测试标准

- [ ] V1 编译 0 错误，所有 V1 测试通过
- [ ] V2 编译 0 错误（如有 V2 测试则通过）
- [ ] V1 `npm run package` 能产出 `.vsix`（V1 仍可发布）

## 10.3 依赖关系标准

最终依赖关系：

```text
extensions/coding-agent/src/extension.ts   (V1)
        ↓
packages/runtime/                          (V2)
        ↓
packages/agents/coding-agent/              (V2 Coding 适配)
        ↓
extensions/coding-agent/src/agent/         (V1 Coding 业务实现)
        ↓
extensions/coding-agent/src/{planner, reflection, context, ...}  (V1 Coding 专用)
```

而不是：

```text
extensions/coding-agent/src/agent/         (V1 Coding AgentLoop)
    ↓
src/trace/eval/evolution/                  (V1 内部的 Runtime —— 反了)
```

## 10.4 未来扩展准备

- [ ] `packages/agents/research-agent/` / `office-agent/` / `browser-agent/` 占位已建
- [ ] `apps/desktop/` 占位已建
- [ ] `packages/runtime/src/{workflow, memory}/` 占位已建
- [ ] `packages/contracts/src/` 含 `IAgent` / `IPlanner` / `IReflectionEngine` / `IContextProvider` / `ISkillRegistry` / `IToolRegistry` / `IVerifier` / `ILLMProvider` / `IBudgetGuard` 接口

## 10.5 项目定位

完成后项目定位变为：

```text
仓库主目录（F:\Z-code\）
    = Assistant Runtime（V2）
    + 跨包类型（packages/contracts/）
    + 通用机制 + 框架（packages/runtime/）
    + Coding Agent 适配（packages/agents/coding-agent/）
    + 多个宿主入口（apps/cli / apps/desktop / apps/vscode-connector/）

extensions/coding-agent/（V1）
    = VSCode 扩展
    + VSCode 适配层
    + Coding 专用业务实现（agent / planner / reflection / analysis / context / skills / evaluation / evolution）
```

为后续 Desktop Runtime / Research Agent / Office Agent / Long-Term Memory / Workflow Engine 预留扩展位，但本阶段不实现。
