### **📘 Coding Agent 构建实施规范 (SGLang + 三层混合架构)**

**文档用途**：本文档是构建"类 Cursor/Trae Coding Agent"的唯一技术基准。请将此文档作为系统级上下文（System Prompt / Project Rules）提供给 AI 编程助手，以确保其生成的代码严格遵循"SGLang 推理引擎 + 自研三层混合架构 + LSP 原生集成"的技术路线，禁止引入 LangChain/LangGraph 等重型通用编排框架。

---

### **1. 核心架构原则**

在生成任何代码或设计方案前，必须严格遵守以下三条铁律：

- **推理与编排分离**：SGLang 仅作为纯粹的推理后端（负责 KV Cache 复用、结构化 JSON 生成、FIM 补全）。所有状态流转、工具执行、错误恢复逻辑必须在应用层（TypeScript）硬编码实现。
- **编辑器感知优先于 RAG**：禁止默认使用向量数据库进行代码检索。上下文获取必须优先通过 LSP（Language Server Protocol）获取精确语义（定义、引用、诊断），Tree-sitter 仅作为无 LSP 语言的兜底方案。
- **三层混合架构**：Agent 的核心循环采用宏观 Plan-and-Execute + 微观 ReAct + 兜底 Reflection 的三层混合架构。核心 Loop 代码量应控制在 500 行以内。

### **2. 三层架构详解**

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Planner (宏观 Plan-and-Execute)                    │
│  将复杂需求拆解为子任务列表，生成高层计划                    │
│  状态: PLANNING                                              │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: ReAct Executor (微观 ReAct)                        │
│  每个子任务内：THINK → ACT → OBSERVE 循环                    │
│  THINK: 推理思考，决定工具调用                                │
│  ACT: 执行工具或编辑                                        │
│  OBSERVE: 观察结果，继续 ReAct 或提交子任务                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Reflector (兜底反思)                               │
│  子任务完成后审查输出，发现缺陷后自动迭代修正                │
│  状态: REFLECT                                               │
└─────────────────────────────────────────────────────────────┘
```

#### **状态流转图**

```
PLANNING
    │
    ▼
THINK ←──────────┐
    │             │
    ▼             │
ACT               │  (ReAct 循环)
    │             │
    ▼             │
OBSERVE ──[continue]──┘
    │
    │  [complete]
    ▼
REFLECT ──[needs_revision]──→ THINK
    │
    │  [pass]
    ▼
THINK (next sub-task) 或 DONE
```

### **3. 三层状态 Schema**

#### **PLANNING — 生成子任务计划**
```json
{
  "state": "PLANNING",
  "content": "分析用户需求",
  "plan": {
    "title": "添加用户登录功能",
    "subTasks": [
      { "id": "task-1", "description": "调研现有鉴权逻辑", "goal": "了解当前鉴权实现" },
      { "id": "task-2", "description": "编写登录 API 接口", "goal": "POST /api/login 可用" },
      { "id": "task-3", "description": "修改前端路由", "goal": "登录页路由正常" }
    ]
  },
  "nextState": "THINK"
}
```

#### **THINK — ReAct 推理思考**
```json
{
  "state": "THINK",
  "subTaskId": "task-1",
  "content": "需要先读取 auth.config.ts 了解当前鉴权配置",
  "subTaskPlan": "1. 读取 auth.config.ts, 2. 检查中间件, 3. 记录发现"
}
```

#### **ACT — 执行动作**
```json
{
  "state": "ACT",
  "subTaskId": "task-1",
  "toolCall": {
    "name": "read_file",
    "params": { "path": "src/auth/config.ts" }
  }
}
```

#### **OBSERVE — 观察结果**
```json
{
  "state": "OBSERVE",
  "subTaskId": "task-1",
  "content": "读到了 auth 配置，使用 JWT 鉴权",
  "subTaskStatus": "complete",
  "nextState": "REFLECT"
}
```

#### **REFLECT — 反思审查**
```json
{
  "state": "REFLECT",
  "subTaskId": "task-2",
  "content": "审查登录接口实现",
  "reflection": {
    "verdict": "needs_revision",
    "feedback": "缺少输入验证和错误处理",
    "issues": ["未校验空字段", "错误响应格式不统一"]
  },
  "nextState": "THINK"
}
```

### **4. SGLang 集成规范**

调用 SGLang 时，禁止将其当作普通的 OpenAI 兼容 API 使用，必须利用其原生特性：

| 场景 | 必须使用的 SGLang 特性 | 实现要求 |
| :--- | :--- | :--- |
| 工具调用 / 编辑指令 | `json_schema` 约束生成 | 禁止在 Prompt 中提示 JSON 格式，必须通过参数传入 Schema，确保 0 格式错误率 |
| 系统提示词 / 项目规范 | RadixAttention 前缀缓存 | 将固定上下文标记为可缓存前缀，跨请求自动复用 KV Cache |
| 多文件搜索 / 并行任务 | Parallel Generation 原语 | 禁止串行调用，使用 SGLang 并行生成语法同时处理多个子任务 |
| Tab 补全 / 行间插入 | FIM (Fill-In-the-Middle) | 使用专用 FIM Token 格式，禁止用 Chat 模式模拟补全 |
| 长对话 / 多轮修改 | Prefix Caching API | 手动管理会话级前缀，避免重复计算已读文件的 Token |

### **5. 代码理解与上下文管理规范**

#### **5.1 上下文获取优先级**

1. **LSP 精确语义**：`textDocument/definition`、`textDocument/references`、`workspace/symbol`、`textDocument/diagnostic`
2. **编辑器实时状态**：当前光标位置、选中代码、最近打开/修改的文件列表
3. **Tree-sitter AST**：仅用于无 LSP 语言或 UI 层代码块折叠/高亮
4. **文件名/路径匹配**：基于项目结构的快速过滤
5. **向量语义检索**：**仅当以上 4 种方式均无法满足时**才允许使用，且必须限定检索范围

#### **5.2 禁止行为**

- 禁止对整个代码库进行无条件向量化索引
- 禁止使用固定 Chunk Size 切分代码文件（必须按函数/类/模块语义切分）
- 禁止让 Chat 模型直接生成完整文件内容来替代精准编辑

### **6. AI 助手执行检查清单**

在为我生成代码或方案前，请逐项自查：

- 是否未引入任何通用 Agent 编排框架？
- SGLang 调用是否使用了 `json_schema` 而非 Prompt 提示格式？
- 代码理解是否优先使用了 LSP 而非向量检索？
- Agent Loop 是否为三层混合架构（Planner → ReAct Executor → Reflector）？
- 每个子任务是否在完成前经历了 THINK → ACT → OBSERVE 循环？
- 子任务完成后是否自动进入 REFLECT 审查？
- 编辑操作是否实现了幂等性和流式 Diff？
- 终端执行是否强制走沙箱隔离？
- Tab 补全是否使用了 FIM 模式而非 Chat 模拟？