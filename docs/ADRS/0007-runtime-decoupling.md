# 0007. Phase 6 — Runtime 解耦：建立 Ziner Monorepo

- 状态：Proposed
- 日期：2026-06-17
- 决策人：@Ziner V2 架构组
- 影响阶段：Phase 6 → Phase 14
- 关联路线图：[ROADMAP_V2_ASSISTANT_RUNTIME.md §三](../ROADMAP_V2_ASSISTANT_RUNTIME.md)
- 取代：单一 `extensions/coding-agent` 仓库

---

## 背景

V1 → V2 已完成 Phase 0~5，所有可观测、评测、进化能力均构建在
`extensions/coding-agent/src/` 单一 package 内，运行时与 **VSCode Extension
Host 强耦合**（`import * as vscode from 'vscode'` 散布于 `extension.ts`、
各 Panel、各 Debugger）。

ROADMAP V2 第 §三节明确要求 **Phase 6 脱离 VSCode**：
- Runtime 必须成为**纯 Node 服务**
- VSCode 是 **Connector**，不是宿主
- `contracts / trace / evaluation / evolution / workflow / memory`
  必须可被未来 Desktop App、Terminal Connector、Browser Connector 复用

当前结构与该目标之间的**三个不可调和矛盾**：
1. **`src/infra/storage/jsonl-store.ts` 依赖 vscode.Memento？否** ✅ — 已经是纯 fs。
2. **所有 VSCode UI（`panels/`, `debug/`, `trace-ui/trace-panel.ts`）混在 `src/`** — 与 runtime 物理纠缠。
3. **V1 Agent（`agent/`, `context/`, `planner/`, `skills/`, `memory/`）与 V2 Runtime（`multi-agent/`, `trace/`, `evaluation/`, `evolution/`）并列存在** — 没有任何包边界。

---

## 备选方案

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A. 维持现状，继续在 extension 内分层** | 仅做内部目录调整 | 零迁移成本 | 不解决"VSCode 是宿主"问题；Desktop App 仍要重写一切 |
| **B. 拆 npm workspaces** | 在 `extensions/coding-agent` 内部用 `workspaces` 拆 packages | 接近目标；改动面小 | 仍与 extension 强绑定；不能对外发布 |
| **C. 建立独立 monorepo `ziner`**，VSCode Extension 退化为 Connector app | 顶层 monorepo，下含 `packages/*` 与 `apps/*` | 完全满足 ROADMAP；可独立发布；未来可加 desktop/cli/web | 需要跨仓迁移 / git history 保留 |
| **D. 走 polyrepo** | 每个 package 独立 repo | 治理清晰 | 跨包 PR 困难；本地联调慢 |

## 决策

采用 **方案 C**，并附加 **B 阶段过渡**：在迁移期保留 `extensions/coding-agent` 内部
`workspaces` 兼容层（详细迁移策略见 §五）。

> 理由：
> - ROADMAP 明确 `packages/runtime` 与 `apps/vscode-connector` 平级
> - 跨包编辑的 PR 在 monorepo 内更易审阅
> - pnpm workspace 已被 V2 评估接受（与 ADR-0002 的 JSONL/SQLite 策略一致）

### 关键约束

1. **`packages/**` 内禁止** `import * as vscode from 'vscode'`
2. **`packages/**` 内禁止** 任何 UI / DOM 依赖
3. **依赖方向** 严格自下而上（见 §三 依赖图）
4. **`apps/**` 可以依赖所有 `packages/*`**，但 **`packages/*` 互不依赖 apps**
5. **每个 `packages/*` 必须** 暴露 `package.json` + `tsconfig.json` + `index.ts` barrel

---

## 一、目标 Monorepo 目录结构

```
ziner/                                             # 新顶层仓库（或在 monorepo 根并列）
│
├── package.json                                   # workspace 根
├── pnpm-workspace.yaml                            # packages/* apps/*
├── tsconfig.base.json                             # 共享 TS 配置（strict、target ES2022）
├── nx.json / turbo.json                           # 可选：缓存构建（暂不强制）
├── ADR.md → docs/ADRS/
│
├── packages/
│   ├── contracts/                                 # Phase 0 抽出
│   │   ├── package.json       @ziner/contracts
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── run.ts         (AgentRun / AgentSpan / SpanEvent / ErrorRef / ModelRef)
│   │       ├── agent.ts       (IAgent / TaskContext / SharedState / Budget)
│   │       ├── eval.ts        (Evaluation / Benchmark / Baseline / PromptCandidate / VariantStats)
│   │       ├── config.ts      (ConfigSpec / ModelSpec / ToolSpec)
│   │       └── workflow.ts    (Workflow / WorkflowStep / IWorkflowStep)        ← 新增
│   │
│   ├── infra/                                     # 跨包工具
│   │   ├── errors/            @ziner/infra-errors
│   │   ├── cost/              @ziner/infra-cost
│   │   ├── storage/           @ziner/infra-storage
│   │   ├── permission/        @ziner/infra-permission
│   │   └── config/            @ziner/infra-config
│   │
│   ├── trace/                                     # Phase 1 + Phase 1.5 抽出
│   │   ├── package.json       @ziner/trace
│   │   ├── src/
│   │   │   ├── span.ts
│   │   │   ├── run-tracker.ts
│   │   │   ├── instrumentation.ts
│   │   │   ├── query-service.ts        ← 来自 trace-ui/query-service.ts（去掉 vscode 依赖）
│   │   │   ├── projections.ts          ← 原 query-service 中的 projection 逻辑
│   │   │   └── index.ts
│   │   └── __tests__/
│   │
│   ├── evaluation/                                # Phase 3 + Phase 4
│   │   ├── package.json       @ziner/evaluation
│   │   ├── src/
│   │   │   ├── harness/
│   │   │   │   ├── sandbox.ts
│   │   │   │   ├── rubric.ts
│   │   │   │   ├── benchmark-runner.ts
│   │   │   │   └── candidate-adapter.ts
│   │   │   ├── baseline.ts
│   │   │   ├── aggregate.ts
│   │   │   └── index.ts
│   │   └── __tests__/
│   │
│   ├── evolution/                                 # Phase 5
│   │   ├── package.json       @ziner/evolution
│   │   ├── src/
│   │   │   ├── engine.ts
│   │   │   ├── fingerprint.ts
│   │   │   ├── suggestions.ts
│   │   │   ├── ab-testing.ts          ← 抽出 QueryService.variantStats 业务
│   │   │   └── index.ts
│   │   └── __tests__/
│   │
│   ├── workflow/                                  # Phase 8 准备（先建空壳；Phase 8 实现 DSL）
│   │   ├── package.json       @ziner/workflow
│   │   ├── src/
│   │   │   ├── types.ts                (Workflow / WorkflowStep)
│   │   │   ├── engine.ts               (WorkflowEngine.run)
│   │   │   ├── steps/
│   │   │   │   ├── agent-step.ts
│   │   │   │   ├── orchestrator-step.ts   ← 包装现有 Orchestrator
│   │   │   │   ├── parallel-step.ts
│   │   │   │   ├── if-step.ts
│   │   │   │   ├── loop-step.ts
│   │   │   │   ├── retry-step.ts
│   │   │   │   ├── checkpoint-step.ts
│   │   │   │   └── approval-step.ts       ← Human-in-the-loop
│   │   │   ├── checkpoint.ts            (resume / replay)
│   │   │   ├── interpreter.ts            (YAML/JSON → Workflow AST)
│   │   │   └── index.ts
│   │   └── __tests__/
│   │
│   ├── memory/                                    # Phase 7 抽出（V1 已有 stub，Phase 7 重做）
│   │   ├── package.json       @ziner/memory
│   │   ├── src/
│   │   │   ├── types.ts                (MemoryEntry / EpisodicRecord / SemanticRecord / UserMemory / SkillMemory)
│   │   │   ├── memory-store.ts         (interface)
│   │   │   ├── file-memory-store.ts    (JSONL + SQLite)
│   │   │   ├── episodic.ts
│   │   │   ├── project.ts              ← 来自 V1 repoKnowledgeBase
│   │   │   ├── user.ts
│   │   │   ├── knowledge.ts
│   │   │   ├── skill.ts
│   │   │   └── index.ts
│   │   └── __tests__/
│   │
│   ├── llm/                                       # 跨包 LLM 抽象
│   │   ├── package.json       @ziner/llm
│   │   ├── src/
│   │   │   ├── provider.ts             (LLMProvider interface)
│   │   │   ├── message.ts
│   │   │   ├── factory.ts
│   │   │   └── index.ts
│   │   └── adapters/
│   │       ├── openai.ts
│   │       ├── anthropic.ts
│   │       ├── sglang.ts
│   │       └── deepseek.ts
│   │
│   ├── tools/                                     # 跨包 tool registry 抽象
│   │   ├── package.json       @ziner/tools
│   │   ├── src/
│   │   │   ├── registry.ts
│   │   │   ├── policy.ts               (ToolPolicy / ToolGuard)
│   │   │   └── index.ts
│   │   └── builtins/                   (file/edit/shell/search/...)
│   │
│   ├── connectors/                                # Phase 11 准备
│   │   ├── package.json       @ziner/connectors
│   │   ├── src/
│   │   │   ├── interface.ts            (IConnector)
│   │   │   ├── registry.ts
│   │   │   └── index.ts
│   │   ├── vscode/                     ← 迁自 apps/vscode-connector
│   │   ├── terminal/
│   │   ├── browser/
│   │   ├── git/
│   │   └── filesystem/
│   │
│   ├── agents/                                    # Phase 10 准备（先有 coding）
│   │   ├── package.json       @ziner/agents
│   │   ├── src/
│   │   │   ├── interface.ts            (重导出 IAgent)
│   │   │   ├── agent-loop-adapter.ts   ← 当前 multi-agent/agent-loop-adapter.ts
│   │   │   ├── prompted-agent.ts       ← 当前 multi-agent/prompted-agent.ts
│   │   │   ├── example-agents.ts
│   │   │   └── index.ts
│   │   └── coding/                     ← V1 CodingAgent
│   │       ├── package.json   @ziner/agent-coding
│   │       ├── src/
│   │       │   ├── agent-core.ts       (来自 src/agent/agent-core.ts)
│   │       │   ├── agent-loop.ts
│   │       │   ├── agent-pipeline.ts
│   │       │   ├── pipeline-types.ts
│   │       │   ├── verifier.ts
│   │       │   ├── planner.ts          (来自 src/planner/planner.ts)
│   │       │   ├── context/            (来自 src/context/*)
│   │       │   ├── skills/             (来自 src/skills/*)
│   │       │   ├── reflection/         (来自 src/reflection/*)
│   │       │   └── index.ts
│   │       └── __tests__/
│   │
│   └── runtime/                                   # Phase 6 核心
│       ├── package.json       @ziner/runtime
│       ├── src/
│       │   ├── index.ts                (composes everything)
│       │   ├── container.ts            (DI container)
│       │   ├── assistant-runtime.ts     (主入口：start / stop / runWorkflow)
│       │   ├── service-host.ts         (in-process service registry)
│       │   ├── ipc.ts                  (进程内 + 可选 IPC)
│       │   ├── multi-agent/            ← 当前 src/multi-agent/ 中除 adapter 之外
│       │   │   ├── agent-registry.ts
│       │   │   ├── shared-state.ts
│       │   │   └── orchestrator.ts
│       │   └── __tests__/
│       └── README.md
│
├── apps/
│   ├── desktop/                                   # Phase 6 后期或 Phase 6.5
│   │   ├── package.json   @ziner/app-desktop
│   │   ├── src/                        (Electron / Tauri)
│   │   └── webview/                    (复用 packages/trace 渲染逻辑)
│   │
│   ├── vscode-connector/                          # 当前 extension 改造
│   │   ├── package.json   @ziner/app-vscode
│   │   ├── src/
│   │   │   ├── extension.ts            (重写为 Connector host)
│   │   │   ├── panels/                 (chat-panel, composer-panel)
│   │   │   ├── webviews/               (trace-panel, evaluations-panel, evolution-panel)
│   │   │   ├── commands.ts
│   │   │   └── index.ts
│   │   └── package.json (extension manifest: publisher, contributes, engines.vscode)
│   │
│   └── cli/                                       # 未来（Phase 6 不强制）
│       └── package.json
│
└── docs/
    ├── ADRS/
    │   ├── 0001-...md  ~  0006-...md
    │   └── 0007-runtime-decoupling.md   ← 本文件
    └── ROADMAP_V2_ASSISTANT_RUNTIME.md
```

---

## 二、包职责矩阵

| 包 | 唯一职责 | 禁止依赖 | 测试要求 |
|------|----------|----------|----------|
| `contracts` | 类型 / 接口 / barrel | vscode, fs, http | 编译通过即可 |
| `infra/*` | 跨包工具（错误码、cost、storage、permission、config） | vscode, packages/* (除 contracts) | ≥ 80% 行覆盖 |
| `trace` | Run / Span / SpanEvent / Query / 投影 | vscode, packages/evaluation, packages/evolution, packages/workflow | ≥ 80% |
| `evaluation` | Harness / Benchmark / Rubric / Baseline / Aggregate | vscode, packages/evolution | ≥ 80% |
| `evolution` | 失败聚类 / 建议 / A-B | vscode, packages/workflow | ≥ 70% |
| `workflow` | WorkflowEngine / DSL / Checkpoint | vscode, packages/agents | ≥ 80% |
| `memory` | MemoryStore / 5 类 memory | vscode, packages/agents | ≥ 80% |
| `llm` | LLM 抽象 | vscode, packages/tools | ≥ 80% |
| `tools` | Tool registry / 权限 | vscode, packages/llm | ≥ 80% |
| `agents` | 通用 IAgent / adapter | vscode, packages/runtime | ≥ 80% |
| `agents/coding` | V1 CodingAgent 全套 | vscode, packages/agents (本包外子包) | 继承 V1 |
| `connectors` | IConnector / registry | vscode, packages/agents | 单元测试可 mock |
| `runtime` | 组装 + DI + 主入口 | vscode, packages/connectors (除 trace) | 集成测试 |
| `apps/*` | 具体 host 集成 | 互相禁止依赖 | e2e |

---

## 三、依赖图（强约束）

```
                    apps/desktop
                    apps/vscode-connector
                    apps/cli
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   connectors        runtime         agents (interface)
        │              │   │   │           │
        │              │   │   │           ▼
        │              │   │   │      agents/coding (V1)
        │              │   │   │           │
        │              ▼   ▼   ▼           │
        │           trace workflow memory  │
        │              │   │   │           │
        │              │   ▼   │           │
        │              │  memory?│          │
        │              │        │           │
        │              ▼        │           │
        │         evaluation    │           │
        │              │        │           │
        │              ▼        │           │
        │         evolution     │           │
        │              │        │           │
        └─────┬────────┼────────┼───────────┘
              ▼        ▼        ▼
          llm  tools  infra/*  contracts
                              (无依赖)
```

依赖规则（**单向，不可逆**）：
- `contracts` 是叶子，**任何包都允许**依赖
- `infra/*` 互相不依赖
- `trace` 可被 `evaluation` / `evolution` / `workflow` 依赖
- `evaluation` / `evolution` 互相**不依赖**（共同依赖 `trace` + `contracts`）
- `workflow` 可被 `runtime` 依赖；`workflow` 不依赖 `runtime`
- `agents/coding` 不被 `runtime` 之外依赖
- `runtime` 是除 `apps` 外**最高层**的包
- `apps/*` 可依赖任何包

**禁止方向**：
- ❌ `packages/*` → `apps/*`
- ❌ `packages/*` → `vscode`
- ❌ `evaluation` → `evolution`
- ❌ `workflow` → `agents`
- ❌ `agents/coding` → `workflow`

---

## 四、VSCode Extension → Connector 重构

### 4.1 当前 `extension.ts` 实际行为

```typescript
// 当前 extension.ts 干了 4 件事：
1. 实例化 TraceManager + createFileStore (composition root)
2. 注册 4 个命令 (openTrace, runMultiAgent, openEvaluations, openEvolution)
3. 在 activate() 启动各 Panel/Evaluator
4. import 大量 V1 业务（AgentCore, ChatPanel, ContextManager...）
```

### 4.2 重构后 `apps/vscode-connector/extension.ts`

```typescript
// 新的 extension.ts 只做一件事：host 一个 AssistantRuntime + 暴露 Connector API

import * as vscode from 'vscode';
import { AssistantRuntime } from '@ziner/runtime';
import { VSCodeConnector } from './connectors/vscode';

export async function activate(ctx: vscode.ExtensionContext) {
  // 1. 启动 runtime（in-process，纯 Node）
  const runtime = await AssistantRuntime.start({
    storeDir: ctx.globalStorageUri.fsPath,
    config: await loadConnectorConfig(),
  });

  // 2. 注册 VSCode Connector（向 runtime 注入"当前编辑器/文件/选中"等 context）
  const connector = new VSCodeConnector(ctx, runtime);
  await runtime.connectors.register(connector);

  // 3. 暴露命令（薄壳，全部委托给 runtime）
  ctx.subscriptions.push(
    vscode.commands.registerCommand('z.openTrace', () =>
      runtime.ui.openTracePanel()),
    vscode.commands.registerCommand('z.runWorkflow', (spec) =>
      runtime.workflow.run(spec)),
    vscode.commands.registerCommand('z.openEvaluations', () =>
      runtime.ui.openEvaluationsPanel()),
    vscode.commands.registerCommand('z.openEvolution', () =>
      runtime.ui.openEvolutionPanel()),
  );

  // 4. 监听 connector 事件，转换为 VSCode 通知
  connector.onDidChangeActiveFile((file) => {
    runtime.context.notify({ type: 'file.active', file });
  });
}
```

### 4.3 VSCodeConnector 提供的 Context

```typescript
interface IConnector {
  id: string;
  capabilities: ('editor' | 'terminal' | 'git' | 'fs')[];
  // 主动推送：当前文件、选区、git 状态
  subscribe(fn: (event: ConnectorEvent) => void): () => void;
  // 被动接受：runtime 调 connector 做事
  execute(action: ConnectorAction): Promise<ConnectorResult>;
}
```

V1 `ChatPanel` / `ComposerPanel` / `InlineCompletionProvider` 全部降级为 `IConnector` 的不同 `capabilities`：
- `ChatPanel` → `connector.execute({ type: 'chat.open' })`
- `InlineCompletion` → `connector.execute({ type: 'inline.suggest' })`

---

## 五、迁移策略（兼容期 2~3 周）

> 目标：**任何时刻 `git checkout main` 都能跑**。迁移期间不允许破坏 V1/V2 已有功能。

### 5.1 阶段化步骤

| Step | 时间 | 动作 | 兼容保证 |
|------|------|------|----------|
| **M0. 准备** | 0.5d | 在仓库根建 `pnpm-workspace.yaml`、`tsconfig.base.json`；`extensions/coding-agent` 内部改 `tsconfig.project` 引用 | 不改源代码 |
| **M1. 抽 contracts** | 0.5d | 复制 `src/contracts/*` → `packages/contracts/src/`；在原路径留 `re-export shim`：`src/contracts/index.ts` = `export * from '@ziner/contracts'` | 所有 `from '../contracts'` 仍工作 |
| **M2. 抽 infra** | 1d | 同上：`infra/errors`、`infra/cost`、`infra/storage`、`infra/permission`、`infra/config` 逐包搬 | 写 import 路径修正 |
| **M3. 抽 trace** | 1d | `src/trace/*` → `packages/trace/src/`；`src/trace-ui/query-service.ts` 拆为 `packages/trace/src/projections.ts` + `apps/vscode-connector/src/webviews/trace/` | webview 的 `import { QueryService }` 改为 `@ziner/trace` |
| **M4. 抽 evaluation + evolution** | 1.5d | 同上；同时把 `harness/` 整体进 `packages/evaluation/src/harness/` | PromptedAgent / EvolutionPanel 改 import |
| **M5. 抽 multi-agent** | 1d | `agent-registry` / `shared-state` / `orchestrator` → `packages/runtime/src/multi-agent/`；`agent-loop-adapter` / `prompted-agent` / `example-agents` → `packages/agents/src/` | extension.ts 改 import |
| **M6. 抽 agents/coding (V1)** | 2d | `src/agent/` + `src/context/` + `src/planner/` + `src/skills/` + `src/reflection/` + `src/memory/memoryManager.ts` + `src/memory/repoKnowledgeBase.ts` → `packages/agents/coding/src/` | extension.ts 改 import；**这是最大块** |
| **M7. 抽 llm + tools** | 0.5d | `src/llm/llm-provider.ts` → `packages/llm/src/provider.ts`；`src/tools/tool-registry.ts` → `packages/tools/src/registry.ts` | Coding Agent 改 import |
| **M8. 重写 extension.ts 为 Connector** | 1d | `apps/vscode-connector/src/extension.ts` 重写；保留 V1 命令通过 Connector 暴露 | 命令面板不变化 |
| **M9. 验证** | 1d | `pnpm -r test`、`pnpm -r build`、VSCode 调试启动、手动跑一次多 agent | 跑通 6 个核心测试集 |
| **M10. 清理** | 0.5d | 删除 `extensions/coding-agent/src/`；保留 `extensions/coding-agent/package.json` 仅作 build artifact 目录 | 旧 import 全断 |

总计：**~10 天（2 周）**

### 5.2 兼容层（shim）实现

**单包 shim**（以 `src/contracts/index.ts` 为例）：
```typescript
// extensions/coding-agent/src/contracts/index.ts
// 兼容层：迁移期间 re-export 新 package
export * from '@ziner/contracts';
```

**tsconfig 项目引用**：
```jsonc
// extensions/coding-agent/tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "../contracts": ["../../packages/contracts/src"],
      "../contracts/*": ["../../packages/contracts/src/*"],
      "../trace": ["../../packages/trace/src"],
      "../trace/*": ["../../packages/trace/src/*"],
      // ... 其它迁移包
      "*": ["src/*", "node_modules/*"]
    }
  },
  "references": [
    { "path": "../../packages/contracts" },
    { "path": "../../packages/trace" },
    // ...
  ]
}
```

**package.json 依赖**：
```jsonc
// extensions/coding-agent/package.json
{
  "dependencies": {
    "@ziner/contracts": "workspace:*",
    "@ziner/trace": "workspace:*",
    // ...
  }
}
```

### 5.3 灰度切换

每个 Step 完成后做一次 "全量测试"：
- `pnpm -r test` —— 跑所有 package 测试
- `pnpm -r typecheck` —— 跑 `tsc --noEmit`
- `pnpm --filter @ziner/app-vscode package` —— 打 VSIX
- 手动启动调试扩展，验证：
  1. TracePanel 能打开
  2. `Run Multi Agent` 能跑通 example trio
  3. EvaluationsPanel 显示 dashboard
  4. EvolutionPanel 显示 A/B 候选池

---

## 六、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| V1 `src/context/*` 和 V1 `src/memory/*` 互相纠缠，拆包时引入循环 | 高 | 阻断 M6 | M6 优先做；先建立 `packages/agents/coding/src/context` 与 `packages/agents/coding/src/memory` 临时目录，再决定哪些是 V1 私有 / 哪些应进 `packages/memory` |
| `src/trace-ui/query-service.ts` 含 vscode 引用 | 中 | 阻断 M3 | 预先 grep 确认：当前 query-service 已 type-only 引用 vscode，可纯函数化迁出 |
| `pnpm workspace` 与 `tsc project references` 联调速度慢 | 中 | CI 慢 | 引入 `tsc --build --incremental`；CI 用 turbo 缓存 |
| 用户既有 V1 配置文件（`.z/agent.json`）路径不兼容 | 中 | 用户体验降级 | M8 时增加 `legacy-config-migrator`；读取老路径自动写到新 `~/.ziner/` |
| 数据迁移（旧的 `runs.jsonl` 路径） | 中 | 数据丢失 | `FileStore` 路径改为可配置；M0 引入 `storeDir` 参数；旧数据自动 copy |
| 迁移期间两条 import 路径并存，开发认知负担 | 中 | 误改老路径 | M3 起在 CI 加 lint：`extensions/coding-agent/src/**` 禁止 `import * from '../trace'`（必须 `@ziner/trace`） |
| VSCode API 在 `apps/vscode-connector` 之外被误引 | 中 | 违反 Phase 6 核心约束 | 加 CI check：`packages/**` 全包 grep `'vscode'` 必须为 0；`apps/vscode-connector/**` 除外 |

---

## 七、Phase 6 完成判定（Definition of Done）

- [ ] `pnpm-workspace.yaml` 已建
- [ ] 6 个目标 package 已建：`contracts / trace / evaluation / evolution / workflow / memory`（workflow 与 memory 可为空壳，但目录必须存在）
- [ ] 全部 `packages/**` 经 CI grep 验证 **0 个** `vscode` 引用
- [ ] `apps/vscode-connector/src/extension.ts` 重写完成，通过 Connector 接口与 Runtime 对接
- [ ] `pnpm -r test` 通过（包含原 V1 + V2 全部测试集）
- [ ] `pnpm --filter @ziner/app-vscode package` 成功生成 VSIX
- [ ] 手动验证 6 个核心命令可用：`openTrace / runMultiAgent / openEvaluations / openEvolution / openChat / openComposer`
- [ ] `extensions/coding-agent/src/` 旧目录已删除（仅保留 `package.json` + `tsconfig.json` 用于打包）
- [ ] ADR-0007 被 link 到 `README.md`
- [ ] 至少 1 篇 `docs/MIGRATION_NOTES.md` 写明用户可见变更

---

## 八、与后续阶段的衔接

| 阶段 | 依赖 Phase 6 的产物 | Phase 6 必须留的接口 |
|------|---------------------|----------------------|
| **Phase 7 Unified Memory** | `packages/memory/`（空壳） | `MemoryStore` interface（`memory-v2` 草案） |
| **Phase 8 Workflow Engine** | `packages/workflow/`（空壳） | `Workflow / WorkflowStep` 类型在 `contracts/workflow.ts` |
| **Phase 9 Knowledge Hub** | `packages/connectors/filesystem/` 占位 | `IConnector` interface |
| **Phase 10 Agent Ecosystem** | `packages/agents/coding/` 完整 | `IAgent` interface（在 `contracts/agent.ts`） |
| **Phase 11 Connectors** | `packages/connectors/` 主包 | `IConnector` interface |
| **Phase 12 Full Observability** | `packages/trace/` | `SpanType` enum 已预留 `'memory' / 'skill' / 'workflow' / 'connector'` |
| **Phase 13 Evaluation 2.0** | `packages/evaluation/` | `Evaluation` interface + `EvalSubject` enum |
| **Phase 14 Evolution 2.0** | `packages/evolution/` | `EvolutionEngine.generate({ scope: 'agent' \| 'workflow' \| 'skill' \| 'memory' })` 扩展点 |

---

## 九、ADR-0007 决策摘要（一张图）

```
Ziner Monorepo
────────────────────
                 ┌──────────────┐
                 │  apps/*      │   ← VSCode / Desktop / CLI
                 └──────┬───────┘
                        │ depends on
        ┌───────────────┼───────────────┐
        │               │               │
   ┌────▼─────┐    ┌────▼────┐    ┌─────▼────┐
   │ runtime  │    │connectors│    │ agents   │
   └────┬─────┘    └─────────┘    └─────┬────┘
        │                               │
        │   ┌─────────┐  ┌─────────┐    │
        ├──►│ workflow│  │ memory  │◄───┤
        │   └────┬────┘  └────┬────┘    │
        │        │            │         │
        │   ┌────▼────┐  ┌────▼────┐    │
        ├──►│ trace   │  │  llm    │    │
        │   └────┬────┘  │  tools  │    │
        │        │       └────┬────┘    │
        │   ┌────▼────┐      │         │
        ├──►│evaluation│     │         │
        │   └────┬────┘      │         │
        │   ┌────▼────┐      │         │
        └──►│evolution│      │         │
            └────┬────┘      │         │
                 │           │         │
                 ▼           ▼         ▼
              ┌─────────────────────────┐
              │   infra/* + contracts   │   ← 零 vscode 依赖
              └─────────────────────────┘
```

---

## 十、待 Review 决策点

> 提交 Review 前需确认的开放问题：

1. **monorepo 工具选型**：`pnpm`（推荐，磁盘效率）vs `npm workspaces`（零依赖）vs `yarn`？**建议 pnpm**
2. **包管理器与发布**：`@ziner/*` 是否对外发布到 npm？目前**内部 workspaces only** 即可
3. **构建工具**：是否引入 `nx` 或 `turbo`？**建议暂不引入**，等 packages > 10 再评估
4. **V1 Coding Agent 是否全部进 `packages/agents/coding`**：还是保留部分 V1 模块在 `apps/vscode-connector/src/legacy/`？**建议全部进包**，否则 Phase 11 Connectors 时还要再迁一次
5. **V1 `MemoryManager`（vscode.Memento）** 怎么办？vscode.Memento 只能在 extension host 用 → **应被替换**为 `@ziner/memory` 的 `FileMemoryStore`，M6 时同步做
6. **Phase 6 是否同步做 Phase 7 Memory 统一**？建议 **不同步**，分两步走，避免单次 PR 过大
7. **VSIX 包名是否变化**？是否从旧品牌名迁移到 `Ziner`？建议**保留旧名**，避免用户侧更新断裂
8. **desktop app 技术栈**：Electron / Tauri / Web？**本 ADR 不决策**，留作 Phase 6.5 单独 ADR

---

## 状态

- [x] 2026-06-17：草稿 v1（Phase 6 启动评审）
- [ ] 评审通过
- [ ] M0 启动
