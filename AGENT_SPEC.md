### **📘 Coding Agent 构建实施规范 (SGLang + Native Loop)**

**文档用途**：本文档是构建“类 Cursor/Trae Coding Agent”的唯一技术基准。请将此文档作为系统级上下文（System Prompt / Project Rules）提供给 AI 编程助手，以确保其生成的代码严格遵循“SGLang 推理引擎 + 自研轻量级 Loop + LSP 原生集成”的技术路线，禁止引入 LangChain/LangGraph 等重型通用编排框架。

------

### **1. 核心架构原则**

在生成任何代码或设计方案前，必须严格遵守以下三条铁律：

- **推理与编排分离**：SGLang 仅作为纯粹的推理后端（负责 KV Cache 复用、结构化 JSON 生成、FIM 补全）。所有状态流转、工具执行、错误恢复逻辑必须在应用层（Python/Go/Rust）硬编码实现。
- **编辑器感知优先于 RAG**：禁止默认使用向量数据库进行代码检索。上下文获取必须优先通过 LSP（Language Server Protocol）获取精确语义（定义、引用、诊断），Tree-sitter 仅作为无 LSP 语言的兜底方案。
- **极简状态机驱动**：Agent 的核心循环必须是确定性的有限状态机（Plan → Act → Observe → Edit），状态转换由模型输出驱动，而非复杂的动态图编排。核心 Loop 代码量应控制在 300 行以内。

### **2. SGLang 集成规范**

调用 SGLang 时，禁止将其当作普通的 OpenAI 兼容 API 使用，必须利用其原生特性：

表格



| 场景                  | 必须使用的 SGLang 特性   | 实现要求                                                     |
| :-------------------- | :----------------------- | :----------------------------------------------------------- |
| 工具调用 / 编辑指令   | `json_schema` 约束生成   | 禁止在 Prompt 中提示 JSON 格式，必须通过参数传入 Schema，确保 0 格式错误率 |
| 系统提示词 / 项目规范 | RadixAttention 前缀缓存  | 将固定上下文标记为可缓存前缀，跨请求自动复用 KV Cache        |
| 多文件搜索 / 并行任务 | Parallel Generation 原语 | 禁止串行调用，使用 SGLang 并行生成语法同时处理多个子任务     |
| Tab 补全 / 行间插入   | FIM (Fill-In-the-Middle) | 使用专用 FIM Token 格式，禁止用 Chat 模式模拟补全            |
| 长对话 / 多轮修改     | Prefix Caching API       | 手动管理会话级前缀，避免重复计算已读文件的 Token             |

### **3. 自研 Agent Loop 实现标准**

禁止导入 `langchain`、`langgraph`、`autogen` 等库。Agent 核心循环必须按以下结构实现：

python



```
# ✅ 正确示范：极简状态机核心结构
class CodingAgent:
    VALID_STATES = {"PLAN", "ACT", "OBSERVE", "EDIT", "WAIT_USER", "DONE"}
    
    async def run(self, user_msg: str, editor_ctx: EditorContext):
        state = "PLAN"
        history = [SYSTEM_PROMPT, editor_ctx.to_messages(), {"role": "user", "content": user_msg}]
        
        while state != "DONE":
            # 所有模型调用必须带 json_schema 约束
            response = await sglang_client.generate(
                messages=history, 
                json_schema=STATE_SCHEMAS[state]
            )
            
            match state:
                case "PLAN":
                    plan = parse_plan(response)
                    state = "ACT"
                case "ACT":
                    tool_result = await sandbox.execute(response.tool_call)
                    history.append({"role": "tool", "content": tool_result})
                    state = "OBSERVE"
                case "OBSERVE":
                    # 由模型自主决策下一步状态，而非外部规则
                    next_state = response.next_state
                    if next_state not in self.VALID_STATES:
                        raise InvalidStateError(next_state)
                    state = next_state
                case "EDIT":
                    await diff_engine.apply(response.edit_ops)
                    state = "OBSERVE"
                case "WAIT_USER":
                    return Response(waiting_for_user=True, message=response.question)
```

#### **⚠️ Loop 关键约束**

- **编辑操作必须幂等**：Diff 应用引擎必须能识别并跳过已应用的编辑指令，防止重试导致代码损坏。
- **沙箱隔离**：所有终端命令执行必须在 Docker / E2B 沙箱中完成，禁止直接在宿主机执行。
- **流式 Diff 渲染**：EDIT 状态下，SGLang 流式返回编辑指令时，前端必须实时渲染 Diff 预览，支持用户随时中断/接受。

### **4. 代码理解与上下文管理规范**

#### **4.1 上下文获取优先级**

1. **LSP 精确语义**：`textDocument/definition`、`textDocument/references`、`workspace/symbol`、`textDocument/diagnostic`
2. **编辑器实时状态**：当前光标位置、选中代码、最近打开/修改的文件列表
3. **Tree-sitter AST**：仅用于无 LSP 语言或 UI 层代码块折叠/高亮
4. **文件名/路径匹配**：基于项目结构的快速过滤
5. **向量语义检索**：**仅当以上 4 种方式均无法满足时**才允许使用，且必须限定检索范围

#### **4.2 禁止行为**

- 禁止对整个代码库进行无条件向量化索引
- 禁止使用固定 Chunk Size 切分代码文件（必须按函数/类/模块语义切分）
- 禁止让 Chat 模型直接生成完整文件内容来替代精准编辑

### **5. AI 助手执行检查清单**

在为我生成代码或方案前，请逐项自查：

- 是否未引入任何通用 Agent 编排框架？
- SGLang 调用是否使用了 `json_schema` 而非 Prompt 提示格式？
- 代码理解是否优先使用了 LSP 而非向量检索？
- Agent Loop 是否为确定性状态机且核心代码精简？
- 编辑操作是否实现了幂等性和流式 Diff？
- 终端执行是否强制走沙箱隔离？
- Tab 补全是否使用了 FIM 模式而非 Chat 模拟？