# Phase 0 — Foundation（基础设施）

## 目标

在进入任何业务阶段（Trace / Multi-Agent / Harness / Eval / Evolution）之前，
先建立一套**所有阶段共用**的横切基础设施，避免后续阶段互相侵入、各自造轮子。

> 本阶段不出业务功能，只出"地基"。
> 不完成本阶段，**禁止启动 Phase 1**。

参考：

- OpenTelemetry Semantic Conventions（`gen_ai.*` / `tool.*`）
- 12-Factor App（配置外置）
- LangSmith / Langfuse 数据模型
- SQLite + JSONL 双写范式

---

## 范围

| 模块 | 用途 | 被哪些阶段使用 |
|---|---|---|
| 契约层 | 统一类型定义 | 全部 |
| 存储层 | 结构化 + 流式 | P1/P1.5/P3/P4 |
| 配置中心 | 集中管理 | P2/P3/P5 |
| 权限与沙箱 | 工具/文件/网络边界 | P2/P3 |
| 成本控制 | Hard cap | P1/P4 |
| 错误与日志 | 统一异常分类 | 全部 |
| 测试基线 | 录制回放 | P1+ |

---

## 新目录

```text
src/
├── contracts/                 # 跨阶段共享类型
│   ├── run.ts                 # AgentRun / AgentSpan / SpanEvent
│   ├── agent.ts               # IAgent / TaskContext / AgentResult / SharedState
│   ├── eval.ts                # Benchmark / Score / Rubric
│   ├── config.ts              # ConfigSpec / ModelSpec / PromptVersion
│   └── index.ts
│
├── infra/
│   ├── storage/
│   │   ├── sqlite.ts          # 结构化指标（runs/spans/evaluations）
│   │   ├── jsonl.ts           # 流式事件（trace events）
│   │   └── store.ts           # 统一门面
│   │
│   ├── config/
│   │   ├── config-center.ts   # 集中加载/校验/热更新
│   │   ├── schema.ts          # zod / valibot 校验
│   │   └── secrets.ts         # API Key 加密存储
│   │
│   ├── permission/
│   │   ├── tool-guard.ts      # 工具白/黑名单
│   │   ├── fs-guard.ts        # 文件访问边界（workspace 外拒绝）
│   │   └── net-guard.ts       # 网络出口白名单
│   │
│   ├── cost/
│   │   ├── budget.ts          # per-run / per-day 硬上限
│   │   └── pricing.ts         # 模型价格表
│   │
│   ├── errors/
│   │   ├── error-codes.ts     # 统一错误码
│   │   └── classifier.ts      # 失败分类（超时/工具/幻觉/越权）
│   │
│   └── observability-bootstrap.ts  # 初始化 Logger + Trace Recorder
│
└── test/
    ├── fixtures/              # 录制回放用 trace fixture
    └── replay.ts              # 用 Trace JSONL 复现一次 Run
```

---

## 核心类型契约

### AgentRun / AgentSpan（统一基线，Phase 1 直接复用）

```ts
// src/contracts/run.ts
export type RunStatus = "running" | "success" | "failed" | "cancelled";

export interface AgentRun {
  id: string;
  traceId: string;             // OTel 风格，跨进程可关联
  sessionId: string;           // 多轮对话串联
  userId?: string;

  task: string;
  model: { provider: string; name: string };

  startTime: number;           // epoch ms
  endTime?: number;
  duration?: number;

  status: RunStatus;

  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;

  tags: string[];
  metadata: Record<string, unknown>;

  error?: { code: string; message: string; stack?: string };
}

export type SpanType =
  | "llm" | "tool" | "planner" | "verify"
  | "reflection" | "routing" | "memory" | "skill";

export type SpanStatus = "ok" | "error" | "cancelled";

export interface AgentSpan {
  id: string;
  traceId: string;
  runId: string;
  parentSpanId?: string;

  name: string;                // 人类可读，如 "tool:edit_file"
  type: SpanType;
  agent?: string;              // Phase 2 多 Agent 区分

  startTime: number;
  endTime?: number;
  duration?: number;

  status: SpanStatus;

  input?: unknown;
  output?: unknown;

  attributes: Record<string, unknown>;  // OTel 风格
  events: SpanEvent[];                  // 流式事件

  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;

  error?: { code: string; message: string };
}

export interface SpanEvent {
  ts: number;
  name: string;
  attributes?: Record<string, unknown>;
}
```

### IAgent / TaskContext（Phase 2 直接复用）

```ts
// src/contracts/agent.ts
export interface ModelSpec {
  provider: string;
  name: string;
  temperature?: number;
  maxTokens?: number;
}

export interface TaskContext {
  task: string;
  sharedState: SharedState;     // 多 Agent 共享黑板
  parentRunId: string;
  traceId: string;
  budget: { tokensLeft: number; costLeftUsd: number };
}

export interface AgentResult {
  ok: boolean;
  output?: unknown;
  artifacts?: Record<string, unknown>;
  error?: { code: string; message: string };
  metrics?: { tokensIn: number; tokensOut: number; costUsd: number; durationMs: number };
}

export interface IAgent {
  name: string;
  role: string;
  capabilities: string[];       // 用于路由打分
  dependencies: string[];       // DAG 依赖
  modelPreference?: ModelSpec;

  canHandle?(ctx: TaskContext): number;   // 0-1
  execute(ctx: TaskContext): Promise<AgentResult>;
  rollback?(ctx: TaskContext): Promise<void>;
}

export interface SharedState {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  subscribe(key: string, fn: (v: unknown) => void): () => void;
}
```

### Benchmark / Rubric（Phase 3 直接复用）

```ts
// src/contracts/eval.ts
export interface Benchmark {
  id: string;
  name: string;
  prompt: string;
  repo: string;
  baseCommit: string;
  setupScript?: string;
  testCommands: string[];
  testFiles?: string[];
  referencePatch?: string;
  difficulty: "easy" | "medium" | "hard";
  tags: string[];
  rubric: Record<string, number>;   // 维度 -> 权重
}

export interface Evaluation {
  id: string;
  runId: string;
  benchmarkId: string;
  scores: Record<string, number>;   // 维度分
  total: number;                    // 0-100
  pass: boolean;
  judgeModel: string;
  timestamp: number;
}
```

### ConfigSpec（Phase 5 直接复用）

```ts
// src/contracts/config.ts
export interface PromptVersion {
  id: string;                       // semver
  content: string;
  author: string;                   // "human" | "evolution:v1"
  createdAt: number;
  metrics?: { successRate?: number; avgCostUsd?: number; sampleSize?: number };
}

export interface ConfigSpec {
  models: Record<string, ModelSpec>;
  prompts: Record<string, PromptVersion[]>;   // 同一 Prompt 多个版本
  tools: { allow: string[]; deny: string[] };
  budget: { perRunUsd: number; perDayUsd: number };
  experiment?: {                    // Phase 5
    holdoutRatio: number;           // 默认 0.1
    minSamples: number;             // 默认 30
    significanceLevel: number;      // 默认 0.05
  };
}
```

---

## 存储层规范

### SQLite（结构化指标）

- 路径：`~/.z-assistant/data/z.db`
- WAL 模式 + 索引：`(run_id)`、`(start_ts)`、`(status)`、`(benchmark_id)`
- 命名：表/列 snake_case；JSON 字段存 `attributes_json`（TEXT）

### JSONL（流式事件）

- 路径：`~/.z-assistant/traces/{runId}.jsonl`
- 每一行一个 `SpanEvent`，append-only
- 用途：Trace Viewer 流式回放、失败复现

### 统一门面

```ts
// src/infra/storage/store.ts
export interface Store {
  runs: RunRepo;
  spans: SpanRepo;
  evals: EvalRepo;
  benchmarks: BenchmarkRepo;
  traceStream(runId: string): AsyncIterable<SpanEvent>;
}
```

---

## 配置中心

- 配置源优先级：环境变量 > `~/.z-assistant/config.yaml` > 内置默认值
- 校验失败**拒绝启动**，不静默 fallback
- Prompt / Tool 列表必须从配置中心加载，**禁止硬编码**（为 Phase 5 演化铺路）
- API Key 走 OS Keychain（Windows DPAPI / macOS Keychain / Linux Secret Service）

---

## 权限与沙箱

| 维度 | 默认策略 | 可配置 |
|---|---|---|
| 文件访问 | 限制在 `workspaceRoot` 及其子目录 | allow/deny glob 列表 |
| 网络出口 | 默认 deny | 按域名白名单 |
| 工具调用 | 内置工具可用 | 第三方工具需登记签名 |
| 危险操作 | `rm -rf`、`git push --force` 默认拦截 | 需显式 enable |

> **Phase 3 Harness 复用同一套沙箱**，但允许在容器内放宽。

---

## 成本控制

- 启动时加载模型价格表（`pricing.ts`）
- 每个 Run 开始分配 budget，`TaskContext.budget` 注入
- 超过 `perRunUsd` → 立即终止 Run 并标记 `failed:budget_exceeded`
- 超过 `perDayUsd` → 拒绝启动新 Run，UI 弹提示

---

## 错误码与日志

统一错误码（`error-codes.ts`）：

| 范围 | 类别 | 示例 |
|---|---|---|
| 1xxx | LLM | `1001` rate_limit, `1002` context_overflow |
| 2xxx | Tool | `2001` not_found, `2002` permission_denied |
| 3xxx | Agent | `3001` timeout, `3002` budget_exceeded |
| 4xxx | Sandbox | `4001` container_oom |
| 5xxx | Config | `5001` schema_invalid |
| 9xxx | Unknown | `9001` unexpected |

日志格式：JSONL + 必含 `traceId`、`runId`、`spanId` 字段（便于关联）。

---

## 测试基线

- **录制回放**：用一次真实 Run 的 JSONL Trace 作为 fixture，单元/集成测试可重放
- **Golden Trace**：核心场景（单工具调用 / 多工具 / 失败重试）固化预期 Span 序列
- **契约测试**：`src/contracts/*` 任何修改必须先过 contract test

---

## 验收标准

- [ ] `src/contracts/*` 完整定义 Run/Span/Agent/Eval/Config 五类契约
- [ ] SQLite + JSONL 双写 Store 可被空实现替换（接口稳定）
- [ ] 配置中心支持 YAML + env + 启动校验
- [ ] 工具守卫 / 文件守卫 / 网络守卫三件套可独立启用
- [ ] 预算超限能正确终止 Run 并记录错误码 `3002`
- [ ] 至少 3 个 Golden Trace fixture 通过录制回放测试
- [ ] README 写明本地开发与运行 Harness 的最小步骤

---

## 阶段交付物

| 类型 | 名称 |
|---|---|
| 代码 | `src/contracts/*`、`src/infra/*` |
| 文档 | `PHASE0_FOUNDATION.md`（本文） |
| 配置 | `~/.z-assistant/config.example.yaml` |
| 测试 | ≥ 3 个 Golden Trace fixture + 契约测试套件 |
