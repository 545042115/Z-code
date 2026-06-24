# 已集成功能优化清单

> 当前状态：P0 已完整接入桌面端，P1 大部分已接入，Research Agent 基础循环已可用，Mermaid 渲染已集成。
> 本文档记录已落地功能中仍可继续优化的问题，按性价比排序，作为后续开发 backlog。

---

## 高优先级（改动小、效果明显）

### 1. Tool Policy 运行时真正生效

**问题**  
桌面端设置页已提供 allow/deny 列表（[settings.ts](file:///d:/mycode/Z%20Code/apps/desktop/src/renderer/settings.ts#L269-L272)），配置会保存到 `VSCodeConnectorConfig.toolPolicy`，但运行时工具调用层尚未实际拦截被禁用的工具。

**影响**  
用户配置“禁止 browser_navigate”后，agent 仍然可能调用该工具。

**修改计划**  
1. 在 [mcp-tools.ts](file:///d:/mycode/Z%20Code/apps/vscode-connector/src/mcp-tools.ts) 和 chat-agent 的工具分发处，调用前检查 `toolPolicy.deny`。
2. 如果工具在 deny 列表中，返回 `ToolResult` 错误：`{ ok: false, error: 'TOOL_DENIED_BY_POLICY', message: '...' }`。
3. allow 列表非空时，仅允许 allow 列表中的工具（deny 优先于 allow）。
4. 在 UI 中给出明确提示：哪些工具被策略禁用。

---

### 2. BudgetGuard 运行时真正生效

**问题**  
桌面端已提供 token/单次 USD/每日 USD 三个输入框，但 LLM 调用层没有实时累加和拦截。

**影响**  
预算配置只是数字，无法阻止超支。

**修改计划**  
1. 在 LLMProvider 包装层增加 `BudgetTracker`，记录每次 `generate()` 的 `tokensIn/tokensOut/costUsd`。
2. 提供三种超限行为可配置：
   - `warn`：记录审计日志但继续
   - `block`：抛出 `BUDGET_EXCEEDED` 错误
   - `fallback`：切换到更便宜的模型（如从 GPT-4o 降级到 GPT-4o-mini）
3. 每日预算在应用启动时重置，持久化当日累计到 `storageDir/budget.json`。
4. 在 chat UI 底部显示当前会话已用 token / 费用。

---

### 3. Mermaid 按需加载以减小 bundle 体积

**问题**  
集成 mermaid 后，`build:renderer` 产物从 ~600KB 涨到 **7.1MB**，拖慢首次加载。

**影响**  
启动时间变长，内存占用增加。多数对话并不包含图表。

**修改计划**  
1. 移除 [chat.ts](file:///d:/mycode/Z%20Code/apps/desktop/src/renderer/chat.ts) 顶部的静态 `import mermaid from 'mermaid'`。
2. 改成动态导入：`const mermaid = await import('mermaid')`，仅在检测到 assistant 消息包含 ````mermaid` 代码块时触发。
3. 可选：使用 CDN 加载 mermaid，不在 bundle 中打包（需处理离线场景 fallback）。
4. 对同一段 mermaid 文本缓存渲染后的 SVG，避免重复 render。

---

## 中优先级（中等改动）

### 4. 搜索结果缓存加 LRU / 容量限制

**问题**  
Research Agent 的文件缓存目前只有 24h TTL，没有总大小或条目数上限。

**影响**  
长期运行后 `<storageDir>/search-cache/` 可能无限增长。

**修改计划**  
1. 给 `SearchCache` 增加 `maxEntries` 和 `maxBytes` 配置。
2. 写入新缓存时，如果超出限制，按 `lastAccessed` 淘汰最旧的条目。
3. `get()` 时更新 `lastAccessed`，实现 LRU。
4. 启动时做一次清理，删除过期和超容的缓存文件。

---

### 5. Research Agent 与 Browser Agent 协作

**问题**  
Research Agent 对需要登录、翻页、点击 SPA 才能获取完整内容的页面无能为力。

**影响**  
遇到复杂网页时，研究报告的深度不够。

**修改计划**  
1. 在 Research Agent 抓取阶段，先判断 URL 类型：
   - 静态文章 / 百科 → 直接用 `fetchProvider`
   - 需要交互的页面 / 登录墙 / SPA → 交给 Browser Agent
2. Browser Agent 返回抓取结果后，Research Agent 继续后续步骤。
3. 通过 `SharedState` 共享页面内容。

---

### 6. Skill 加载去重

**问题**  
当前按相似度选 Top-3 skill，若多个 skill 内容高度重合，会浪费 token 并稀释注意力。

**影响**  
上下文效率下降。

**修改计划**  
1. 对候选 skill 的 body 计算简单文本相似度（或 embedding 相似度）。
2. 相似度超过阈值（如 0.85）时只保留优先级最高的一个。
3. 优先选择互补性强的 skill 组合。

---

### 7. Chat 消息流式输出

**问题**  
当前 assistant 回复要等全部生成完才一次性显示。

**影响**  
长报告/长代码时用户等待体验差。

**修改计划**  
1. LLMProvider 增加 `streamGenerate()` 接口。
2. chat-agent 的 ReAct 循环支持流式思考/工具调用展示。
3. 前端 `addMessage` 支持增量追加内容。

---

## 低优先级 / 大改动

### 8. 真正的多 Agent 协作编排

**问题**  
当前 [agent-router.ts](file:///d:/mycode/Z%20Code/apps/vscode-connector/src/agent-router.ts) 是“选一个 agent 执行一次”，不是多 agent 协作。

**影响**  
复杂任务无法拆分成子任务并行/串行执行。

**修改计划**  
1. Orchestrator 支持子任务拆分。
2. 多个 agent 并行或串行执行。
3. 最终结果由 synthesizer agent 汇总。

---

### 9. 本地模型支持（Ollama / LM Studio）

**问题**  
当前只支持远程 LLM API。

**影响**  
有隐私或成本敏感场景无法覆盖。

**修改计划**  
1. 增加 `OllamaProvider` / `LMStudioProvider`。
2. 设置页增加本地模型配置。
3. 支持本地/远程模型 fallback。

---

## 建议执行顺序

1. **Tool Policy 生效**（安全控制）
2. **BudgetGuard 生效**（成本控制）
3. **Mermaid 按需加载**（性能优化）
4. **搜索缓存 LRU**（稳定性）
5. **Research ↔ Browser 协作**（能力提升）
6. **Skill 去重**（效率提升）
7. **流式输出**（体验提升）
8. **多 Agent 编排 / 本地模型**（架构升级）
