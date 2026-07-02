# 0001. Trace 必须先于 Multi-Agent

- 状态：Accepted
- 日期：2026-06-17
- 决策人：@Ziner V2 架构组
- 影响阶段：Phase 1 / Phase 2

## 背景

V2 路线图存在两个相互冲突的排序：
- V2_VISION.md 旧版：Phase1 Trace → Phase2 Harness → Phase3 Multi-Agent
- 实际 PHASE 文档：Phase1 Trace → Phase2 Multi-Agent → Phase3 Harness

Multi-Agent 会显著放大系统的并发、嵌套与回滚复杂度。
没有可观测性（Trace）兜底，多 Agent 的失败定位几乎不可行。

## 备选方案

- 方案 A：Trace → Harness → Multi-Agent（旧 VISION 顺序）
- 方案 B：Trace → Multi-Agent → Harness（PHASE 文件实际顺序）
- 方案 C：Trace → Trace UI → Multi-Agent → Harness（推荐）

## 决策

采用 **方案 C**：在 Trace 完成后再补一个独立的 Trace UI 阶段（Phase 1.5），
然后才进入 Multi-Agent。

理由：

1. Multi-Agent 的并发 Span、嵌套 Span 必须有可视化工具，否则无法调试。
2. Harness 评测 Multi-Agent 的失败归因强依赖 Trace Viewer。
3. 先有 Trace + Viewer，后续阶段的开发与排错效率显著提升。

## 后果

### 正面
- Multi-Agent 阶段有完整的运行黑盒记录与可视化
- Harness 失败归因可下钻到具体 Span
- 后续所有阶段共享同一套可观测设施

### 负面 / 成本
- 总工期增加约 1 个阶段
- Trace UI 需要先于多 Agent 排期

### 缓解措施
- Trace UI 范围克制：只做"看"，不做"分析"（分析留给 Phase 4 Dashboard）
