# Contracts — V2 共享类型

本目录是 V2 所有阶段的**唯一类型来源**（Single Source of Truth for Types）。
所有 `src/agent/`、`src/trace/`、`src/harness/` 等模块都从这里 `import` 类型，
**禁止**复制或扩展出第二套字段定义。

> 详细设计与字段定义见 [docs/PHASE0_FOUNDATION.md](../../../docs/PHASE0_FOUNDATION.md)；
> 关键决策见 [docs/ADRS/](../ADRS/)。

---

## 目录

| 文件 | 内容 | 何时使用 |
|---|---|---|
| `run.ts` | `AgentRun` / `AgentSpan` / `SpanEvent` | 任何记录或查询执行轨迹的地方 |
| `agent.ts` | `IAgent` / `TaskContext` / `SharedState` / `AgentResult` | 实现具体 Agent / Orchestrator 时 |
| `eval.ts` | `Benchmark` / `Evaluation` / `Rubric` | Harness 评测 / Dashboard 展示 |
| `config.ts` | `ConfigSpec` / `PromptVersion` / `ToolPolicy` | 读取 / 修改任何运行时配置 |

---

## 导入约定

```ts
// ✅ 正确：从 barrel 统一导入
import {
  AgentRun,
  AgentSpan,
  IAgent,
  ok,
  fail,
  ConfigSpec,
  DEFAULT_CONFIG,
  matchGlob,
  isToolAllowed,
  computeDuration,
} from './contracts';

// ❌ 错误：直接从子模块导入（增加重构阻力）
import { AgentRun } from './contracts/run';
```

---

## 用法示例

### 1. 构造一个 Run

```ts
import {
  AgentRun,
  computeDuration,
} from './contracts';

const run: AgentRun = {
  id: crypto.randomUUID(),
  traceId: traceId(),                  // W3C 16-byte hex
  sessionId: 'session-2026-06-17-001',
  task: '在 src/foo.ts 加一个导出函数',
  model: { provider: 'openai', name: 'gpt-4o' },
  startTime: Date.now(),
  status: 'running',
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalCostUsd: 0,
  tags: ['session:demo', 'mode:composer'],
  metadata: { 'z.task.complexity': 'medium' },
};

// 结束时：
run.endTime = Date.now();
run.duration = computeDuration(run.startTime, run.endTime);
run.status = 'success';
```

### 2. 构造一个 Span

```ts
import { AgentSpan, SpanEvent } from './contracts';

const span: AgentSpan = {
  id: crypto.randomUUID(),
  traceId: run.traceId,
  runId: run.id,
  parentSpanId: parent?.id,
  name: 'tool:edit_file',
  type: 'tool',
  startTime: Date.now(),
  status: 'ok',
  input: { path: 'src/foo.ts', content: 'export const x = 1;' },
  output: { ok: true },
  attributes: {
    'tool.name': 'edit_file',
    'tool.call.id': 'call_abc',
  },
  events: [
    { ts: Date.now(), name: 'tool.start' },
    { ts: Date.now(), name: 'tool.end', attributes: { ok: true } },
  ],
};
```

### 3. 实现一个 Agent

```ts
import { IAgent, TaskContext, AgentResult, ok, fail } from './contracts';

export const ResearchAgent: IAgent = {
  name: 'research',
  role: 'Researcher',
  capabilities: ['web.search', 'doc.fetch', 'fact.check'],
  dependencies: [],
  modelPreference: { provider: 'openai', name: 'gpt-4o', temperature: 0.2 },

  canHandle(ctx) {
    return /搜索|查一下|search/i.test(ctx.task) ? 0.9 : 0.1;
  },

  async execute(ctx: TaskContext): Promise<AgentResult> {
    try {
      const result = await webSearch(ctx.task);
      return ok(result, {
        artifacts: { 'research.findings': result },
        metrics: { tokensIn: 120, tokensOut: 80, costUsd: 0.001, durationMs: 1200, llmCalls: 1, toolCalls: 1 },
      });
    } catch (e: any) {
      return fail('2001', e?.message ?? 'unknown');
    }
  },
};
```

### 4. 多 Agent 共享状态

```ts
import { TaskContext, SharedState } from './contracts';

function plannerAgent(ctx: TaskContext) {
  ctx.sharedState.set('plan.dag', { steps: ['research', 'code', 'review'] });
}

function codeAgent(ctx: TaskContext) {
  const plan = ctx.sharedState.get<{ steps: string[] }>('plan.dag');
  if (!plan) throw new Error('planner did not run');
  // ...
}

// 订阅式协作
const unsubscribe = ctx.sharedState.subscribe('plan.dag', (v) => {
  console.log('plan updated:', v);
});
unsubscribe();   // 清理
```

### 5. Benchmark + Evaluation

```ts
import { Benchmark, Evaluation, combineScores, decidePass } from './contracts';

const bench: Benchmark = {
  id: 'swe-bench:lang-42',
  name: 'Fix integer overflow',
  prompt: '...',
  repo: 'example/repo',
  baseCommit: 'abc123',
  testCommands: ['npm test'],
  difficulty: 'medium',
  tags: ['fix', 'math'],
  rubric: { test: 0.6, 'llm-judge': 0.4 },
};

// 跑完 harness 拿到 results:
const { total, scores } = combineScores(
  [
    { name: 'test', scores: {}, score: 100 },
    { name: 'llm-judge', scores: {}, score: 80 },
  ],
  bench.rubric
);

const ev: Evaluation = {
  id: crypto.randomUUID(),
  runId: run.id,
  benchmarkId: bench.id,
  scores,
  total,
  pass: decidePass(total),
  timestamp: Date.now(),
  durationMs: 0,
};
```

### 6. 读取 / 校验配置

```ts
import {
  ConfigSpec,
  DEFAULT_CONFIG,
  getActivePrompt,
  isToolAllowed,
  toolRequiresConfirm,
} from './contracts';

const config: ConfigSpec = {
  ...DEFAULT_CONFIG,
  // 覆盖默认：
  budget: { ...DEFAULT_CONFIG.budget, perRunUsd: 0.5 },
};

const prompt = getActivePrompt(config, 'agent.planner');
if (!prompt) throw new Error('missing prompt: agent.planner');

if (isToolAllowed(config.tools, 'shell_exec:read_ls')) {
  if (toolRequiresConfirm(config.tools, 'shell_exec')) {
    // 弹窗确认...
  }
  // 执行
}
```

---

## 写新代码时

| 场景 | 应该 | 不应该 |
|---|---|---|
| 需要 LLM 调用元数据 | 用 `AgentSpan` + `attributes['gen_ai.*']` | 自己造 `{model, tokens}` 字段 |
| 需要 Agent 输出 | 用 `AgentResult` + `artifacts` | 返回裸对象 |
| 需要工具权限判断 | 用 `isToolAllowed` | 自己写正则 |
| 需要评分 | 用 `combineScores` + `decidePass` | 自己写加权 |
| 需要 Prompt | 从 `getActivePrompt` 读 | 在代码里写字符串 |

---

## 变更规则

1. **新增字段** → 默认 `optional`（`?`），避免下游编译失败
2. **删除字段** → 先标 `@deprecated`，下一个 major 再删
3. **重命名字段** → 保留旧字段做 alias，标 `@deprecated`
4. **破坏性变更** → 同步更新 `ConfigSpec.schemaVersion`
5. **每次改动** → 必须过 `tsc --noEmit` + 单元测试
