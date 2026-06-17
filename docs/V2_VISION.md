# Z Assistant V2

## 项目定位

当前项目为：

Single-Agent Coding Assistant

目标升级为：

Desktop AI Assistant Platform

对标：

- WorkBuddy
- Manus
- Marvis
- OpenHands Cloud

---

## 当前能力

- Discovery
- Retrieval
- Planner
- Tool Use
- Memory
- Verification
- Reflection
- Skill System

---

## V2新增能力

### 1. Observability

实现完整 Agent Run Trace。

能力：

- Run History
- Span Timeline
- Tool Trace
- LLM Trace
- Cost Tracking
- Token Tracking

---

### 2. Multi-Agent

实现：

Supervisor Agent

协调：

- Planner Agent
- Research Agent
- Coding Agent
- Review Agent
- Test Agent

---

### 3. Harness

实现：

Agent Benchmark Framework

支持：

- Dataset
- Benchmark
- Evaluator
- Report

---

### 4. Evaluation

实现：

Metrics Dashboard

支持：

- Success Rate
- Pass@K
- Cost
- Runtime
- Tool Usage

---

### 5. Evolution

实现：

Self-Learning Layer

支持：

- Feedback Analysis
- Prompt Optimization
- Tool Optimization
- Skill Optimization

---

## 开发顺序

> 以磁盘上的 `PHASE*.md` 文件名为准。下文顺序已与各 PHASE 文档对齐。

Phase0 Foundation          // 契约/存储/配置/权限/成本/类型
Phase1 Trace                // Run/Span 落盘 + 接入点埋点
Phase1.5 Trace UI           // 独立的时间线与历史查看（Multi-Agent 之前的调试基线）
Phase2 Multi-Agent          // Orchestrator + Supervisor + 共享状态
Phase3 Harness              // 沙箱 + Benchmark + 多 Judge
Phase4 Evaluation           // Dashboard + Trace Drill-down + 回归检测
Phase5 Evolution            // A/B + 版本化 + 人类审核门 + 自动回滚

禁止跨阶段开发。
所有阶段必须遵守 OTel `gen_ai.*` / `tool.*` 语义约定与统一类型契约（见 PHASE0）。
Evolution 阶段所有 Prompt/Tool/Skill 改动默认只生成建议、必须经人工确认后方可落地。