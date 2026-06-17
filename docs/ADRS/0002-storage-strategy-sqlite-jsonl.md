# 0002. 存储采用 SQLite + JSONL 双写

- 状态：Accepted
- 日期：2026-06-17
- 决策人：@Z Assistant V2 架构组
- 影响阶段：Phase 0 / 1 / 4

## 背景

Trace 数据具有两种典型访问模式：
- 结构化查询（按时间、状态、模型、标签筛选与聚合）
- 流式回放（按时间顺序追加、重放运行过程）

单一存储方案难以同时高效满足两者。

## 备选方案

- 方案 A：仅 SQLite
- 方案 B：仅 JSONL 文件
- 方案 C：SQLite（结构化指标） + JSONL（流式事件）双写
- 方案 D：嵌入式时序库（DuckDB / QuestDB）

## 决策

采用 **方案 C**：双写。

- **SQLite** 存结构化指标：`AgentRun` / `AgentSpan` / `Evaluation` / `Benchmark`。
- **JSONL** 存流式事件：`SpanEvent[]`，append-only，每个 Run 一个文件。

理由：

- SQLite 桌面端零运维，WAL 模式性能足够，索引成熟。
- JSONL 流式追加 O(1)，可被 UI 实时消费。
- 两份数据可独立演进（Phase 4 切 DuckDB 不影响流式）。

## 后果

### 正面
- 结构化查询与流式回放各自最优路径
- Run 结束后 SQLite 完整，JSONL 可保留也可压缩归档
- 重放测试（Golden Trace）有现成 fixture

### 负面 / 成本
- 双写需保证一致性（事务/补偿）
- JSONL 长期占用空间，需要归档策略

### 缓解措施
- Phase 0 Store 门面统一封装，调用方无感
- 归档策略：30 天前的 JSONL 压缩为 `.jsonl.zst`，90 天后可选删除
