# Z Assistant V2 架构优先重构路线图

## 核心原则

当前阶段停止新增大型功能（Memory、Workflow、Research Agent 等）。

优先目标：

> 先解决架构问题，再继续扩展能力。

当前项目最大风险不是功能缺失，而是：

- V1 与 V2 并行发展
- Runtime 与 Coding 强耦合
- VSCode 成为系统宿主
- 模块职责边界逐渐模糊
- 后续 Desktop Assistant 演化成本越来越高

因此本阶段定义为：

# Phase 6A — Architecture First

---

# 一、总体目标

将项目从：

```text
Coding Agent + Trace + Eval + Evolution
```

重构为：

```text
Assistant Runtime
    +
Expert Agents
```

但暂不实现新的 Agent。

仅完成架构梳理。

---

# 二、本阶段禁止事项

禁止新增：

- Long-Term Memory
- Workflow Engine
- Research Agent
- Office Agent
- Browser Connector
- Desktop App

禁止：

- 大规模功能开发
- 新业务模块

禁止：

- 直接 Monorepo 化
- packages/apps 拆分

禁止：

- 重写 AgentLoop
- 重写 Planner
- 重写 ContextManager

目标是低风险重构。

---

# 三、V1 与 V2 重新定位

## V1

定位：

```text
Coding Expert Agent
```

包含：

- AgentLoop
- Repo Editing
- Verifier
- Code Actions
- Coding Skills

---

## V2

定位：

```text
Assistant Runtime
```

负责：

- Planning
- Reflection
- Discovery
- Trace
- Evaluation
- Evolution
- Context
- Future Memory
- Future Workflow

---

# 四、能力抽取计划

## 4.1 Planner

当前位置：

```text
src/planner
```

目标：

```text
src/runtime/planning
```

原因：

规划能力属于所有 Agent。

---

## 4.2 Reflection

当前位置：

```text
reflection/
verifier/
```

目标：

```text
src/runtime/reflection
```

原因：

复盘能力属于平台能力。

---

## 4.3 Skill

当前位置：

```text
src/skills
```

目标：

```text
src/runtime/skills
```

原因：

未来 Evolution 将直接依赖 Skill。

---

## 4.4 Discovery

当前位置：

代码发现相关模块

目标：

```text
src/runtime/discovery
```

原因：

属于环境理解能力。

---

## 4.5 ContextManager

当前位置：

```text
src/context
```

目标：

```text
src/runtime/context
```

原因：

未来不仅服务 Coding。

---

# 五、保留在 Coding Agent 内部的能力

以下能力不抽离。

## AgentLoop

保留：

```text
agents/coding-agent
```

---

## Repo Editor

保留：

```text
agents/coding-agent
```

---

## Verifier

保留：

```text
agents/coding-agent
```

---

## Code Actions

保留：

```text
agents/coding-agent
```

---

# 六、目标目录结构（逻辑结构）

```text
src/

contracts/

runtime/
├── planning/
├── reflection/
├── discovery/
├── skills/
├── context/
├── trace/
├── evaluation/
├── evolution/

agents/
├── coding-agent/

connectors/
├── vscode/

legacy/
```

注意：

此阶段允许逻辑归类。

不要求一次性移动全部文件。

---

# 七、Trace/Eval/Evolution 归位

以下模块统一视为 Runtime：

```text
multi-agent/
trace/
evaluation/
evolution/
harness/
```

长期目标：

```text
runtime/
├── trace
├── evaluation
├── evolution
├── workflow
```

但本阶段先完成依赖梳理。

---

# 八、VSCode 定位调整

当前：

```text
VSCode = 宿主
```

未来：

```text
Assistant Runtime
        ↑
        │
VSCode Connector
```

因此：

extension.ts

未来属于：

```text
connectors/vscode
```

但暂不迁移。

---

# 九、Trae 执行要求

第一步不要修改业务逻辑。

先完成：

## Architecture Review

输出：

- 当前模块分类
- Runtime 分类
- Agent 分类
- Connector 分类

---

## Dependency Review

输出：

- Runtime → Agent
- Agent → Runtime
- Connector → Runtime

依赖关系图

---

## Refactor Plan

拆分：

Phase 6A-1

能力分类

Phase 6A-2

依赖梳理

Phase 6A-3

目录迁移

Phase 6A-4

接口抽象

---

# 十、成功标准

完成后：

Planning

Reflection

Skill

Discovery

能够被任意 Agent 复用。

Coding Agent 不丢失现有能力。

项目完成从：

```text
Coding Agent + 附加功能
```

向：

```text
Assistant Runtime + Expert Agents
```

的架构转型。
