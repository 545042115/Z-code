# Z Assistant 桌面端能力补齐规划

> 状态：草案（2026-06-23）
> 目标：把当前已在 runtime / connector 层实现、但桌面端 Chat Agent 尚未接入的能力补齐，同时明确下一阶段需要新建的功能。

---

## 一、当前桌面端真实状态

桌面端 `apps/desktop` 已落地：

- Electron 主窗口 + Chat / Trace / Settings / Memory 四面板
- System tray、全局热键、自动更新骨架、License 服务
- 通过 `RuntimeBridge` 接入 `VSCodeConnector`
- Chat Agent 可用工具：web_search / web_fetch / get_location / 文件工具 / 终端 / 浏览器 / 感知 / MCP
- Long-term / Episodic / Semantic / Preference Memory（可展示、删除、导出）
- Confirmation Gate + Audit Logger + Dry-run 模式
- MCP 自动连接（McDonald's / AMap 等）

但以下能力**只在 runtime 或 vscode-connector 中存在，桌面端 Chat Agent 没有真正用起来**：

---

## 二、未接入桌面端的功能（按优先级）

### P0 — 立刻补齐（用户可感知、阻塞体验）

| # | 功能 | 现状 | 未接入表现 | 预期收益 |
|---|---|---|---|---|
| P0-1 | **Skill System 接入 Chat Agent** | `packages/runtime/src/skills/` + `extensions/coding-agent/src/skills/` 已实现加载、解析、索引、选择 | 桌面端 `.skills/` 目录被忽略；OpenClaw/Claude Code 格式的 SKILL.md 放进来不生效 | 按需加载外部 skill，避免 system prompt 规则膨胀 |
| P0-2 | **长对话总结为 Skill** | `AutoDiscoveryEngine` 只从失败案例生成 skill；History/*.md 中的成功但曲折对话未被利用 | 用户需要反复纠正同类问题（如“先确认我的位置再查路线”） | 把成功经验沉淀为 skill，减少重复纠正 |
| P0-3 | **Skill Review Queue UI** | `JsonFileSkillReviewQueue` 已存在 | 自动发现的 skill 候选入了队，但桌面端没有审核面板 | 用户可批准/拒绝/编辑自动生成的 skill |

### P1 — 中短期（提升可控性与多 agent 能力）

| # | 功能 | 现状 | 未接入表现 | 预期收益 |
|---|---|---|---|---|
| P1-1 | **真正的多 Agent 编排** | V2 Orchestrator 已存在，但桌面端调用时 `maxAgentCalls=1` | 复杂任务不会分派给 Research / Coding / Browser 等专用 agent | 复杂任务自动拆解到最合适的 agent |
| P1-2 | **Tool Policy UI** | `ChatToolRegistry` 支持 allow/deny list | 设置页没有工具允许/禁止配置 | 用户可禁用高风险或不需要的工具 |
| P1-3 | **BudgetGuard 配置** | `BudgetGuard` 在 runtime 中存在 | 桌面端无预算/成本上限设置 | 控制单次运行的 token/成本上限 |
| P1-4 | **审计日志 UI** | `AuditLogger` 已记录到 JSONL | 没有审计面板查看历史操作 | 可追溯 agent 行为 |
| P1-5 | **Always-Rules 管理 UI** | Always-Rules 持久化到 JSON | 没有界面查看/删除已保存的 Always-Allow/Always-Deny 规则 | 避免规则堆积或误设 |

### P2 — 长期（新 agent 与基础设施）

| # | 功能 | 现状 | 说明 |
|---|---|---|---|
| P2-1 | **Research Agent 实现** | `packages/agents/research-agent/` 纯占位 `export {}` | 深度搜索、报告生成 |
| P2-2 | **Office Agent 实现** | `packages/agents/office-agent/` 纯占位 `export {}` | Word/Excel/PPT 处理 |
| P2-3 | **社区 Skill 库** | `LocalCommunitySkillStore` 是本地 stub | 可共享/拉取 skill |
| P2-4 | **向量存储持久化后端** | 当前 `InMemoryVectorStore` | 接入 LanceDB/ChromaDB |
| P2-5 | **嵌入模型升级** | 当前本地 n-gram | 接入 sentence-transformers / OpenAI embedding |

---

## 三、还没做的功能（无论接入与否，当前缺失）

这些功能在 runtime / connector 中也没有完整实现：

| # | 功能 | 说明 |
|---|---|---|
| F-1 | **成功驱动的 Skill 发现** | 现有 `AutoDiscoveryEngine` 只扫描失败；需要新增从“曲折但成功”对话中提炼 skill 的能力 |
| F-2 | **Workflow Engine 原生 UI** | `packages/runtime/src/workflow/` 已存在声明式引擎，但桌面端没有 workflow 编辑/触发界面 |
| F-3 | **多模态 LLM 原生输入** | 当前图片/音频/文档经 perception 层预处理后转成文本喂给 LLM；未原生支持 vision/audio LLM |
| F-4 | **macOS / Linux 打包验证** | 仅 Windows 已产出 `.exe` |
| F-5 | **代码签名与自动更新 publish 源** | 当前为占位配置 |
| F-6 | **检索延迟压测** | 千条记忆规模下未验证 <100ms |
| F-7 | **Red-Team / Prompt Injection 测试套件** | 防注入规则已实现，但缺少持续 red-team 回归测试 |

---

## 四、建议执行顺序

### 阶段 1：Skill 系统接入桌面端（2-3 天）

1. 在 `chat-agent.ts` 中接入 `SkillIndex` + `selectSkills`
2. 从 `projectDir` 或 `storageDir/.skills/` 加载 SKILL.md
3. 根据用户 task 选择 Top-K skill，注入到 system prompt / user message
4. 保留 system prompt 核心元规则，把业务规则下沉到 skill
5. 验证 OpenClaw / Claude Code 格式的 skill 可用

### 阶段 2：长对话总结为 Skill（3-4 天）

1. 新增 `SuccessDrivenSkillDiscovery`
2. 扫描 `History/*.md`，识别“多轮 + 修正 + 最终成功”的对话
3. 提取：
   - 长期记忆（位置、偏好等事实）
   - workflow skill（正确的处理步骤）
4. 候选 skill 入队 `JsonFileSkillReviewQueue`
5. 桌面端新增“待审核 Skill”面板

### 阶段 3：控制面板补齐（2-3 天）

1. Skill Review Queue UI
2. Tool Policy 配置
3. BudgetGuard 配置
4. 审计日志 UI
5. Always-Rules 管理

### 阶段 4：多 Agent 编排（5-7 天）

1. 实现 `ResearchAgent` 基础循环（搜索 → 读取 → 总结 → 报告）
2. 桌面端调用 Orchestrator 时移除 `maxAgentCalls=1` 限制
3. 根据 task 意图分派 agent
4. 在 Trace UI 中展示多 agent 协作

### 阶段 5：基础设施升级（长期）

1. LanceDB/ChromaDB 向量后端
2. sentence-transformers 嵌入
3. macOS/Linux 打包与签名
4. 社区 Skill 库

---

## 五、相关文档索引

| 文档 | 状态 | 说明 |
|---|---|---|
| `ADR-001-Architecture-Refactor-Revised.md` | 有效 | V2 架构基础 |
| `ROADMAP_V2_ASSISTANT_RUNTIME.md` | 有效 | 顶层 Phase 路线图 |
| `V2_VISION.md` | 有效 | 产品愿景 |
| `PROJECT-GUIDE.md` | 有效 | 项目指南 |
| `SECURITY.md` | 有效 | 安全策略 |
| `ROADMAP-V2-Capability-Gap.md` | **建议归档/删除** | 声称大量能力“已完成”，但桌面端实际未接入，状态与实际严重不符，且被后续规划覆盖 |

---

## 六、即时下一步

建议先做 **P0-1 Skill System 接入桌面端 Chat Agent**：

- 改动范围集中（主要在 `apps/vscode-connector/src/chat-agent.ts`）
- 立即解决 system prompt 膨胀问题
- 为 P0-2 长对话总结提供落地载体
- 用户可立即导入 OpenClaw / Claude Code skill 使用
