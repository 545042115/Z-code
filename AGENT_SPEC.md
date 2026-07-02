### **📘 Coding Agent 构建实施规范**

**文档用途**：本文档是 Ziner 项目中 Coding Agent 的技术基准，描述当前已实现的三层混合架构与完整执行流水线。项目以**学习 Agent 工作流程**为核心目标，各版本迭代按里程碑逐步叠加功能，适合按版本顺序阅读代码理解演进。

**注意事项**：
- 项目**不以生产级稳定性为第一目标**，而以**可理解、可扩展、可教学**为优先
- 随着功能持续叠加，部分模块边界可能出现模糊或轻微 Bug
- 目前**缺少 MCP (Model Context Protocol) 类型的外部工具调用**，所有工具均为内置实现
- 支持多后端 LLM：SGLang（推荐本地推理）、OpenAI、Azure OpenAI、Deepseek、小米 MiMo 等

---

### **1. 核心架构原则**

在生成任何代码或设计方案前，必须严格遵守以下三条铁律：

- **推理与编排分离**：LLM 仅作为纯粹的推理后端。所有状态流转、工具执行、错误恢复逻辑必须在应用层（TypeScript）硬编码实现，禁止引入 LangChain/LangGraph 等重型通用编排框架。
- **编辑器感知优先于 RAG**：上下文获取必须优先通过 LSP（Language Server Protocol）获取精确语义（定义、引用、诊断），Tree-sitter 仅作为无 LSP 语言的兜底方案。禁止对整个代码库进行无条件向量化索引。
- **三层混合架构 + Change Planning Layer**：Agent 的核心循环采用**前置规划层（Change Planning Layer）** + 宏观 Plan-and-Execute + 微观 ReAct + 兜底 Reflection 的架构。核心 Loop 代码量控制在合理范围内，各阶段独立可替换。

---

### **2. 完整执行流水线**

当前已实现的全流程（按执行顺序）：

```
Discovery → Skill Discovery → Task Understanding → Complexity Estimation
    → Architecture Review → Change Impact Analysis → Planner
    → Execute → Verify → [条件触发] Reflection Agent → Replan
```

#### **各阶段职责**

| 阶段 | 职责 | 关键模块 |
|:---|:---|:---|
| **Discovery** | 深度代码库分析：符号检索、上下文扩展、模块/风险/范围估计 | `DiscoveryPhase` |
| **Skill Discovery** | 扫描 `.skills/**/SKILL.md`，选择 Top-K 相关 Skill 注入 Prompt | `SkillManager` |
| **Task Understanding** | 分类用户请求为 CREATE/MODIFY/REFACTOR/REPLACE/MIGRATE/ANALYZE，提取约束 | `TaskUnderstanding` |
| **Complexity Estimation** | 评估任务复杂度（LOW/MEDIUM/HIGH），决定走 Fast Path 或 Full Path | `ComplexityEstimator` |
| **Architecture Review** | 分析是否需要拆函数、拆类、新增文件、更新引用，检测单一职责原则 | `ArchitectureReview` |
| **Change Impact Analysis** | 基于 SymbolIndex + DependencyGraph + RepoGraph 静态分析变更影响范围 | `ChangeImpactAnalysis` |
| **Planner** | 根据任务类型生成差异化步骤模板，构建 ExecutionPlan | `Planner` |
| **Execute** | ReAct 工具循环：THINK → ACT → OBSERVE | `AgentCore` / `AgentLoop` |
| **Verify** | 自动运行 tsc / eslint / npm test 校验修改 | `RuntimeVerifier` |
| **Reflection Agent** | **条件触发**（仅 Verify 失败时）：根因分析、修复动作生成、决策是否继续 | `ReflectionAgent` |

---

### **3. 三层混合架构详解**

三层架构是执行层的核心组织方式，各阶段输入输出统一为 `ExecutionPlan`：

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 0: Change Planning Layer（前置规划层）                │
│  Discovery → Skill Discovery → Task Understanding            │
│  → Complexity Estimation → Architecture Review               │
│  → Change Impact Analysis                                    │
│  输出：带有任务类型、复杂度、架构建议、影响分析的 ExecutionPlan │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Planner (宏观 Plan-and-Execute)                    │
│  根据 ExecutionPlan 构建上下文，生成子任务列表                 │
│  状态: PLANNING                                              │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: ReAct Executor (微观 ReAct)                        │
│  每个子任务内：THINK → ACT → OBSERVE 循环                    │
│  THINK: 推理思考，决定工具调用                                │
│  ACT: 执行工具或编辑                                        │
│  OBSERVE: 观察结果，继续 ReAct 或提交子任务                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Reflector (兜底反思)                               │
│  仅当 Verify 失败时触发 Reflection Agent                    │
│  审查输出 → 根因分析 → 修复动作 → 决策继续/停止/重计划       │
│  状态: REFLECT                                               │
└─────────────────────────────────────────────────────────────┘
```

#### **状态流转图**

```
DISCOVERY → SKILL_DISCOVERY → TASK_UNDERSTANDING → COMPLEXITY_ESTIMATION
                                                                │
                                        ┌───────────────────────┴───────────────────────┐
                                        ▼                                               ▼
                                  [LOW: Fast Path]                                 [MEDIUM/HIGH: Full Path]
                                        │                                               │
                                        │                                    ARCHITECTURE_REVIEW
                                        │                                               │
                                        │                                    CHANGE_IMPACT_ANALYSIS
                                        │                                               │
                                        └───────────────────────┬───────────────────────┘
                                                                ▼
                                                           PLANNING
                                                                │
                                                                ▼
THINK ←─────────────────────────────────────────────────────────┐
    │                                                            │
    ▼                                                            │
ACT                                                              │  (ReAct 循环)
    │                                                            │
    ▼                                                            │
OBSERVE ──[continue]─────────────────────────────────────────────┘
    │
    │  [complete]
    ▼
VERIFY ──[passed]────────────────→ DONE
    │
    │  [failed]
    ▼
REFLECT ──[needs_revision]──→ THINK (replan)
    │
    │  [stop]
    ▼
FAILED
```

---

### **4. Fast Path vs Full Path**

**Complexity Estimator** 根据任务类型和关键词自动选择路径：

| 路径 | 触发条件 | 跳过的阶段 | 适用场景 |
|:---|:---|:---|:---|
| **Fast Path** | `analyze` 类型，或单文件 `modify`/`create` + 低复杂度关键词 | Architecture Review、Change Impact Analysis | 解释代码、改注释、重命名、修小 Bug、加日志 |
| **Full Path** | `refactor`/`replace`/`migrate` 类型，或跨模块修改，或目标文件 > 3 | 无（完整执行） | 重构、替换实现、迁移、架构调整 |

---

### **5. Skill System**

Claude Code 风格的 Skill 系统，自动注入领域特定知识到 Planner Prompt：

- **发现**：递归扫描 `.skills/**/SKILL.md`，解析 YAML frontmatter（name + tags）和 Markdown 正文
- **选择**：基于用户请求关键词、TaskType、Discovery 结果中的文件扩展名和符号名进行评分，返回 **Top-K（默认 3）**
- **加载**：仅加载选中的 Skill，禁止全量加载
- **注入**：在 Planner Prompt 前自动附加 `=== ACTIVE SKILLS ===` 块
- **缓存**：Skill 索引 30 秒 TTL，避免重复磁盘扫描

---

### **6. LLM 集成规范**

项目支持多后端，SGLang 是推荐的本地推理方案，但非唯一选择：

| 场景 | 推荐特性 | 实现要求 |
|:---|:---|:---|
| 工具调用 / 编辑指令 | `json_schema` 约束生成 | 禁止在 Prompt 中提示 JSON 格式，必须通过参数传入 Schema |
| 系统提示词 / 项目规范 | RadixAttention 前缀缓存（SGLang） | 将固定上下文标记为可缓存前缀，跨请求自动复用 KV Cache |
| Tab 补全 / 行间插入 | FIM (Fill-In-the-Middle) | 使用专用 FIM Token 格式，禁止用 Chat 模式模拟补全 |
| 多文件搜索 / 并行任务 | Parallel Generation 原语（SGLang） | 禁止串行调用，使用 SGLang 并行生成语法 |

---

### **7. 代码理解与上下文管理规范**

#### **7.1 上下文获取优先级**

1. **LSP 精确语义**：`textDocument/definition`、`textDocument/references`、`workspace/symbol`、`textDocument/diagnostic`
2. **编辑器实时状态**：当前光标位置、选中代码、最近打开/修改的文件列表
3. **Tree-sitter AST**：仅用于无 LSP 语言或 UI 层代码块折叠/高亮
4. **文件名/路径匹配**：基于项目结构的快速过滤
5. **向量语义检索**：**仅当以上 4 种方式均无法满足时**才允许使用，且必须限定检索范围

#### **7.2 禁止行为**

- 禁止对整个代码库进行无条件向量化索引
- 禁止使用固定 Chunk Size 切分代码文件（必须按函数/类/模块语义切分）
- 禁止让 Chat 模型直接生成完整文件内容来替代精准编辑
- 禁止加载全部 Skill（仅允许 Top-K）

---

### **8. AI 助手执行检查清单**

在为我生成代码或方案前，请逐项自查：

- [ ] 是否未引入任何通用 Agent 编排框架（LangChain/LangGraph）？
- [ ] Agent Loop 是否为三层混合架构（Change Planning → Planner → ReAct → 条件触发 Reflection）？
- [ ] 新增阶段是否插入在正确的流水线位置（Discovery → Skill → Task Understanding → Complexity → ...）？
- [ ] Fast Path 是否仅在 LOW 复杂度时跳过 Architecture Review + Change Impact Analysis？
- [ ] Skill 选择是否限制为 Top-K（默认 3），禁止全量加载？
- [ ] 代码理解是否优先使用了 LSP 而非向量检索？
- [ ] 每个子任务是否在完成前经历了 THINK → ACT → OBSERVE 循环？
- [ ] Reflection Agent 是否为**条件触发**（仅 Verify 失败时），而非每次执行后触发？
- [ ] 编辑操作是否实现了幂等性和流式 Diff？
- [ ] 终端执行是否强制走沙箱隔离？
- [ ] Tab 补全是否使用了 FIM 模式而非 Chat 模拟？
- [ ] 新增模块是否保持与现有 Discovery / Planner / Execution / Verify / Reflection 的兼容性？
