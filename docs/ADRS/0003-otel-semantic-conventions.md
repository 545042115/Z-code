# 0003. Trace 字段遵循 OpenTelemetry 语义约定

- 状态：Accepted
- 日期：2026-06-17
- 决策人：@Z Assistant V2 架构组
- 影响阶段：Phase 0 / 1 及之后所有阶段

## 背景

Trace 的字段命名有两种思路：
- 自创一套（自由度高，但生态不兼容）
- 遵循 OTel 语义约定（`gen_ai.*` / `tool.*` 等，可对接 Langfuse/Datadog/Honeycomb）

## 备选方案

- 方案 A：自创字段（如 `tokensIn` / `llm.model`）
- 方案 B：完全遵循 OTel `gen_ai.*` 标准
- 方案 C：OTel 为主 + 业务字段扩展

## 决策

采用 **方案 C**：

- 必含 OTel 字段：`traceId` / `spanId` / `parentSpanId` / `name` / `startTime` / `endTime` / `status` / `attributes`
- 必含 `gen_ai.*`：`gen_ai.system` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
- 必含 `tool.*`：`tool.name` / `tool.call.id` / `tool.call.arguments`
- 业务扩展字段放 `attributes` 内，命名空间加 `z.*`（如 `z.task.id`）

## 后果

### 正面
- 未来对接 Langfuse / Datadog / Honeycomb 零成本
- 生态工具可直接消费 Z Assistant 的 Trace

### 负面 / 成本
- 团队需学习 OTel 语义约定
- 字段映射需维护（业务字段 → OTel）

### 缓解措施
- Phase 0 提供 `attributes.ts` 帮助函数，封装 OTel 字段构造
- 在 `PHASE0_FOUNDATION.md` 中给出字段对照表
