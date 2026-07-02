# Architecture Decision Records（ADR）

本目录记录 Ziner V2 的关键架构决策。
每条 ADR 描述**一个**决策、其上下文、备选方案与后果。
**ADR 一旦确定不再修改**；如需推翻，请新增一条 ADR 并引用旧 ID（不要修改历史）。

> 编号从 `0001` 起，按写入顺序递增，不复用。
> 状态：`Proposed` → `Accepted` → `Superseded by NNNN` / `Deprecated`

---

## 索引

| 编号 | 标题 | 状态 | 影响阶段 |
|---|---|---|---|
| [0001](./0001-trace-before-multi-agent.md) | Trace 必须先于 Multi-Agent | Accepted | Phase 1/2 |
| [0002](./0002-storage-strategy-sqlite-jsonl.md) | 存储采用 SQLite + JSONL 双写 | Accepted | Phase 0/1/4 |
| [0003](./0003-otel-semantic-conventions.md) | Trace 字段遵循 OpenTelemetry 语义约定 | Accepted | Phase 0/1+ |
| [0004](./0004-evolution-requires-human-approval.md) | Evolution 阶段所有变更需人工确认 | Accepted | Phase 5 |
| [0005](./0005-harness-requires-docker-sandbox.md) | Harness 评测必须在 Docker 沙箱中执行 | Accepted | Phase 3 |
| [0006](./0006-prompt-and-tool-via-config-center.md) | Prompt / Tool 禁止硬编码，必须经配置中心 | Accepted | Phase 0/5 |

---

## 模板

新建 ADR 时复制以下骨架并按规范填写：

```markdown
# NNNN. 标题

- 状态：Proposed / Accepted / Superseded
- 日期：YYYY-MM-DD
- 决策人：@xxx
- 影响阶段：Phase X / 全局

## 背景

要解决的问题或动机。

## 备选方案

- 方案 A：...
- 方案 B：...

## 决策

选择哪个方案，为什么。

## 后果

### 正面
- ...

### 负面 / 成本
- ...

### 缓解措施
- ...
```
