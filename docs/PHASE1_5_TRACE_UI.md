# Phase 1.5 — Trace UI（可观测界面原型）

## 目标

在进入多 Agent（Phase 2）之前，**先把 Trace 的可视化闭环跑通**。
没有 Viewer，Multi-Agent 的并发、嵌套、回滚行为会变成"看不见的黑盒"，
后面 Harness 和 Evaluation 也无从排错。

参考：

- LangSmith Runs / Threads
- Jaeger UI
- Honeycomb BubbleUp
- Manus Trace 时间线

> 本阶段**不**做指标 Dashboard（那是 Phase 4），只做单 Run 与历史的"看"。

---

## 为什么必须有这个阶段

| 痛点 | 没有 Viewer | 有 Viewer |
|---|---|---|
| 失败定位 | 翻 JSONL / SQL | 时间线 + Span 详情直接看 |
| 多 Agent 调试（Phase 2） | 几乎不可行 | 可视化嵌套 + 并行分支 |
| Harness 失败归因（Phase 3） | 只能跑分 | 失败 Run 一键下钻 |
| 用户演示 | 不可信 | 真实可点的时间线 |

---

## 新目录

```text
src/ui/trace/
├── TracePage.tsx                # 入口
├── RunList/                     # 历史 Run 列表
│   ├── RunList.tsx
│   ├── filters.ts               # 时间/状态/标签筛选
│   └── columns.tsx
├── Timeline/                    # 单 Run 时间线
│   ├── Timeline.tsx
│   ├── SpanBar.tsx
│   ├── SpanDetail.tsx
│   └── tree.ts                  # parentId -> 嵌套树
├── SpanInspector/               # 单 Span 详情
│   ├── SpanInspector.tsx
│   ├── KVTable.tsx              # attributes / events
│   └── IOView.tsx               # input / output 折叠
├── hooks/
│   ├── useRun.ts
│   ├── useSpans.ts
│   └── useTraceStream.ts        # 订阅 JSONL 流
└── styles/
    └── timeline.css
```

---

## 视图设计

### 1. Run List（历史列表）

字段：

| 列 | 来源 | 说明 |
|---|---|---|
| 时间 | `AgentRun.startTime` | 按天分组 |
| 任务 | `AgentRun.task` | 截断 60 字 |
| 状态 | `status` | ✅ / ❌ / ⏳ / ⊘ |
| 耗时 | `duration` | `1.2s` / `342ms` |
| Tokens | `totalTokensIn + totalTokensOut` | `12.3k` |
| 成本 | `totalCostUsd` | `$0.0123` |
| 模型 | `model.provider/name` | 缩写 |

筛选：时间范围、状态、模型、标签（`AgentRun.tags`）。

### 2. Timeline（单 Run 时间线）

```
Run #abc123  ·  3.42s  ·  12.3k tokens  ·  $0.012  ·  success
┌─────────────────────────────────────────────────────────────┐
│ Planner           ████░░░░           420ms  llm             │
│   ├─ LLM step 1  ██░░                180ms                   │
│   └─ LLM step 2  ███                  240ms                   │
│ Retrieval        ░░██████░░           680ms  tool             │
│ Tool: edit_file  ░░░░██████░░░░       310ms  tool   success  │
│ Verify           ░░░░░░░░░░████       290ms  verify           │
│ Reflection       ░░░░░░░░░░░░░██     180ms  reflection       │
└─────────────────────────────────────────────────────────────┘
[展开所有 Span]  [只看 error]  [只看 LLM]  [只看 tool]
```

**关键交互**：

- 鼠标悬停 Span → 同步右侧详情
- 点击 Span → 定位到详情
- 嵌套 Span 用缩进 + 树状连接线
- 并发 Span（Phase 2 准备）用泳道（swimlane）布局

### 3. Span Detail（右侧详情）

- Header：`name` / `type` / `status` / `agent?` / 时长
- **I/O 折叠区**：`input` / `output`（JSON 折叠树，截断 > 100KB）
- **Attributes 表**：OTel 风格 key/value
- **Events 时间轴**：`SpanEvent[]` 流式事件
- **Token & Cost**：`tokensIn` / `tokensOut` / `costUsd`
- **Error**：错误码 + message + stack（折叠）
- **跳转**：从 LLM Span 跳到对应 Prompt 版本（Phase 5 准备）

---

## 数据加载

```ts
// 历史列表（SQLite）
const runs = await store.runs.list({
  from: ts,
  to: ts,
  status: ["failed"],
  limit: 50,
});

// 单 Run 元数据
const run = await store.runs.get(runId);

// 全部 Span（SQLite）
const spans = await store.spans.listByRun(runId);

// 流式事件（JSONL，按需）
for await (const ev of store.traceStream(runId)) {
  // 实时追加
}
```

> **流式优先**：运行中的 Run 通过 JSONL 流追加，已结束 Run 从 SQLite 拉取。

---

## 性能要求

| 项 | 目标 |
|---|---|
| 列表加载 1k Run | < 300ms |
| 时间线渲染 5k Span | < 500ms（虚拟滚动） |
| 单 Span 详情打开 | < 50ms |
| 流式事件落盘到 UI | < 100ms |

实现要点：

- 列表分页 + 索引（已在 Phase 0 建好）
- 时间线用虚拟滚动（`@tanstack/virtual`）
- 大 JSON I/O 默认折叠，点击再展开
- Web Worker 解析 JSONL（不阻塞主线程）

---

## 验收标准

- [ ] 可看到任意历史 Run 的时间线
- [ ] Span 嵌套关系正确（parentId -> 树）
- [ ] 点击 Span 同步显示详情
- [ ] 运行中 Run 能看到 Span 实时追加
- [ ] 列表支持按时间/状态/模型/标签筛选
- [ ] 5k Span 时间线渲染 < 500ms
- [ ] Error Span 在时间线上一眼可见（红色高亮）
- [ ] 可从 Span 详情跳转到对应 Prompt 版本（为 Phase 5 留 hook）

---

## 阶段交付物

| 类型 | 名称 |
|---|---|
| 代码 | `src/ui/trace/*` |
| 文档 | `PHASE1_5_TRACE_UI.md`（本文） |
| 测试 | 时间线 / 详情 / 列表三个核心组件的 RTL 测试 |
| 演示 | ≥ 3 张截图：列表、嵌套时间线、错误 Span 高亮 |

---

## 阶段出口（Definition of Done）

完成本阶段后，团队必须能用 Trace UI：

1. 复现一次失败的 Run
2. 定位到具体 Span 与错误码
3. 查看该 Span 的 input/output 与 attributes

**满足以上三点，才允许启动 Phase 2 Multi-Agent。**
