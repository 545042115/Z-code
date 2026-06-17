# Phase5 - Self Evolution

## 目标

构建Agent学习能力。

---

## 新目录

src/evolution/

```text
evolution/
├── feedback-engine.ts
├── prompt-optimizer.ts
├── tool-optimizer.ts
├── skill-optimizer.ts
└── learning-memory.ts
```

---

## Feedback Engine

分析：

- 最近100次运行
- 常见失败原因
- Tool失效率
- Prompt失效率

---

## Prompt Optimizer

支持：

A/B Testing

指标：

- Success Rate
- Cost
- Runtime

---

## Tool Optimizer

统计：

- Tool Usage
- Success Rate

生成：

Dead Tool Report

---

## Skill Optimizer

统计：

- Skill Hit Rate
- Skill Success Rate

生成：

Skill Ranking

---

## 验收标准

- 自动生成优化建议
- 自动统计性能变化