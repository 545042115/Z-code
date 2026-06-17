# Phase1 - Run Trace

## 目标

构建完整可观测系统。

参考：

- LangSmith
- OpenTelemetry
- Manus Trace

---

## 新目录

src/trace/

```text
trace/
├── trace-manager.ts
├── trace-store.ts
├── trace-types.ts
├── span.ts
└── run-tracker.ts
```

## 数据结构

### AgentRun

```ts
interface AgentRun {
    id:string;
    task:string;
    startTime:number;
    endTime:number;
    duration:number;

    totalTokens:number;
    totalCost:number;

    status:
      | "running"
      | "success"
      | "failed";

    spans:AgentSpan[];
}
```

### AgentSpan

```ts
interface AgentSpan {
    id:string;
    parentId?:string;

    agent:string;

    type:
      | "llm"
      | "tool"
      | "planner"
      | "verify"
      | "reflection";

    startTime:number;
    endTime:number;

    input:any;
    output:any;
}
```

---

## 接入点

所有以下模块必须记录 Span：

- Discovery
- Planner
- Tool Call
- Verification
- Reflection

---

## UI

新增：

Run Timeline

显示：

Run
 ├─ Planner
 ├─ Retrieval
 ├─ Tool
 ├─ Verify
 └─ Reflection

---

## 验收标准

- Agent运行可生成Run
- Tool调用生成Span
- LLM调用生成Span
- Timeline正确显示
- 支持Run历史查看