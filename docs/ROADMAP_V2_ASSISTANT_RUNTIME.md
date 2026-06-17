# Z Assistant V2 技术路线(Ziner)

## 愿景（Vision）

V1 是一个 Coding Agent。

V2 不再是一个 VSCode 插件，而是一个：

```
Desktop AI Work Assistant
```

目标对标：

```
Marvis
WorkBuddy
OpenHands Desktop
```

但保留并强化 V1 的 Coding 能力。

------

最终形态：

```
Z Assistant

├── Coding
├── Research
├── Knowledge
├── Office
├── Automation
├── Workflow
└── Memory
```

其中：

```
Coding
```

是特色能力之一，而不是产品中心。

------

# 一、架构原则

## Principle 1

Assistant Runtime

优先于

Agent Runtime

------

不是：

```
Task
 ↓
Agent
 ↓
Tool
```

而是：

```
User
 ↓
Assistant Runtime
 ↓
Agent Ecosystem
 ↓
Tool
```

------

## Principle 2

V1 不废弃

V1 成为：

```
CodingAgent
```

------

未来：

```
Agents

├── CodingAgent (V1)
├── ResearchAgent
├── OfficeAgent
├── KnowledgeAgent
└── Future Agents
```

------

## Principle 3

VSCode 只是 Connector

不是宿主

------

V2：

```
Desktop Application
```

------

VSCode：

```
Connector
```

------

未来：

```
Connectors

├── VSCode
├── Terminal
├── Browser
├── Git
├── Filesystem
└── Future Connectors
```

------

# 二、总体架构

```
┌─────────────────────────────┐
│        Desktop App          │
└──────────────┬──────────────┘
               │
               ▼

┌─────────────────────────────┐
│     Assistant Runtime       │
└──────────────┬──────────────┘
               │

 ┌─────────────┼─────────────┐

 ▼             ▼             ▼

Memory     Workflow     Knowledge

 ▼             ▼             ▼

Trace      Evaluation   Evolution

               │

               ▼

      Agent Ecosystem

               │

 ┌─────────────┼─────────────┐

 ▼             ▼             ▼

Coding     Research      Office
Agent      Agent         Agent
```

------

# 三、Phase 6

# Runtime 解耦

目标：

```
脱离 VSCode
```

------

建立：

```
packages/runtime
```

------

迁移：

```
trace
evaluation
evolution
workflow
memory
contracts
```

------

目录：

```
packages/

runtime/
trace/
evaluation/
evolution/
workflow/
memory/

apps/

desktop/
vscode-connector/
```

------

要求：

禁止 Runtime 依赖：

```
import * as vscode from 'vscode'
```

------

最终：

```
Runtime
=
纯 Node 服务
```

------

# 四、Phase 7

# Unified Memory

当前：

```
RepoKnowledgeBase
MemoryManager
```

相互独立。

------

统一为：

```
Memory System
```

------

## 1 Episodic Memory

记录：

```
Run
Task
Result
Summary
```

------

例如：

```
上周修复JWT问题
```

------

## 2 Project Memory

记录：

```
项目结构
架构决策
约束规则
代码规范
```

------

例如：

```
Controller不能直接访问DAO
```

------

## 3 User Memory

记录：

```
用户习惯
工作模式
偏好
```

------

例如：

```
喜欢先设计后编码
```

------

## 4 Knowledge Memory

记录：

```
文档
网页
会议记录
笔记
```

------

## 5 Skill Memory

记录：

```
成功解决方案
高质量Prompt
工作流经验
```

------

# 五、Phase 8

# Workflow Engine

目标：

替代简单 Orchestrator

------

建立：

```
packages/workflow
```

------

支持：

```
Sequential
Parallel
DAG
If
Loop
Retry
Checkpoint
Human Approval
```

------

DSL：

```
workflow:

  - analyze

  - search

  - coding

  - verify

  - if:
      failed

    then:
      - retry
```

------

支持：

```
Resume
Pause
Replay
```

------

# 六、Phase 9

# Knowledge Hub

建立：

```
packages/knowledge
```

------

统一管理：

```
文件
网页
文档
代码库
会议纪要
```

------

支持：

```
Chunk
Embedding
BM25
Hybrid Search
Rerank
```

------

Agent 获取知识：

```
Knowledge API
```

而非直接读取文件。

------

# 七、Phase 10

# Agent Ecosystem

统一 Agent 接口

------

```
interface IAgent {
  canHandle(task): boolean

  execute(ctx): Promise<AgentResult>
}
```

------

Agent 分类：

## CodingAgent

来自 V1

保留：

```
Planner
Reflection
Discovery
RepoKnowledgeBase
Hybrid Retrieval
Skills
```

------

## ResearchAgent

负责：

```
信息收集
总结
分析
报告
```

------

## OfficeAgent

负责：

```
文档
表格
PPT
邮件
```

------

## KnowledgeAgent

负责：

```
知识组织
知识发现
知识维护
```

------

# 八、Phase 11

# Connectors

建立：

```
packages/connectors
```

------

VSCode Connector

负责：

```
当前文件
编辑行为
代码上下文
```

------

Browser Connector

负责：

```
网页
搜索
文章
```

------

Git Connector

负责：

```
Commit
Branch
PR
Issue
```

------

Terminal Connector

负责：

```
Shell
Logs
CLI
```

------

Filesystem Connector

负责：

```
文件变化
文档同步
```

------

# 九、Phase 12

# Full Observability

当前：

```
Trace
Run
Span
```

------

扩展：

```
Agent Trace
Workflow Trace
Memory Trace
Knowledge Trace
Connector Trace
```

------

形成：

```
User
 ↓
Workflow
 ↓
Agent
 ↓
Tool
 ↓
Memory
 ↓
Knowledge
```

全链路可观测。

------

# 十、Phase 13

# Evaluation 2.0

当前：

```
Harness
Benchmark
Rubric
```

------

升级：

```
Online Evaluation
```

------

评测对象：

```
Agent
Workflow
Prompt
Skill
Memory
```

------

指标：

```
Success Rate

Latency

Cost

Tool Calls

Token

User Satisfaction
```

------

# 十一、Phase 14

# Evolution 2.0

当前：

```
Prompt Evolution
```

------

升级：

## Prompt Evolution

------

## Workflow Evolution

自动发现：

```
失败路径
```

优化：

```
Workflow
```

------

## Skill Evolution

自动沉淀：

```
成功经验
```

------

## Memory Evolution

自动整理：

```
长期记忆
```

------

最终：

```
Observe
 ↓
Evaluate
 ↓
Optimize
 ↓
Deploy
```

闭环。

------

# 十二、最终目标

最终架构：

```
Z Assistant

├── Desktop Runtime
│
├── Workflow Engine
│
├── Unified Memory
│
├── Knowledge Hub
│
├── Trace
│
├── Evaluation
│
├── Evolution
│
├── Connectors
│
└── Agent Ecosystem
       │
       ├── CodingAgent
       ├── ResearchAgent
       ├── OfficeAgent
       └── Future Agents
```