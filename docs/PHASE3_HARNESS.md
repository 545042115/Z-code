# Phase3 - Harness

## 目标

实现Agent Benchmark系统。

参考：

- SWE-Bench
- OpenHands Eval
- Manus Eval

---

## 新目录

src/harness/

```text
harness/
├── benchmark/
├── dataset/
├── evaluator/
├── runner/
└── report/
```

---

## Benchmark格式

```json
{
  "id":"task001",
  "name":"JWT Login",
  "prompt":"新增JWT登录功能",
  "repo":"demo-project"
}
```

---

## Evaluator

支持：

- Build
- Test
- Lint
- Coverage

---

## LLM Judge

支持：

- Correctness
- Quality
- Readability
- Architecture

---

## 输出

```json
{
  "score":88,
  "pass":true
}
```

---

## 验收标准

- Benchmark可运行
- 自动评分
- 自动报告