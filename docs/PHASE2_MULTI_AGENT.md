# Phase2 - Multi Agent

## 目标

引入 Agent Orchestrator。

---

## 新目录

src/agent/orchestrator/

```text
orchestrator/
├── supervisor.ts
├── workflow-engine.ts
├── task-router.ts
├── agent-registry.ts
```

## Agent接口

```ts
interface IAgent {
    name:string;
    role:string;

    execute(
        context:TaskContext
    ):Promise<AgentResult>;
}
```

---

## Agent列表

### Planner Agent

负责：

- Task Decomposition
- DAG Generation

### Research Agent

负责：

- Discovery
- Retrieval
- Web Search

### Coding Agent

负责：

- Code Editing
- Refactoring

### Review Agent

负责：

- Code Review
- Architecture Review

### Test Agent

负责：

- Verification
- Regression Test

---

## Supervisor

执行流：

User

↓

Planner

↓

Research

↓

Coding

↓

Review

↓

Test

↓

Done

---

## 验收标准

- 支持Agent注册
- 支持Agent调度
- 支持Agent Trace
- 支持Agent失败重试