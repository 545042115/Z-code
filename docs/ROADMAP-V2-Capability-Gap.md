# ROADMAP-V2: Capability Gap（V2 距离 marvis 的能力差距）

## 背景

ADR-001 完成 Phase 6A 后，V2 = "跨 Agent 通用 Runtime + 标准化接口 + 多宿主入口" 的**框架**。本文件列出 **V2 距离 marvis 这种"完整通用 Agent 产品" 还缺的关键能力**，按优先级 P0 / P1 组织。

**目标读者**：V2 维护者、贡献者、产品规划者。

**P0 能力** = 不实现 V2 仍可发布，但 marvis 核心差异化能力缺失；用户能明显感知"不如其他 Agent"。
**P1 能力** = 不实现 V2 仍可用，但 marvis 同类产品的关键能力缺失；高级用户感知。

---

## 〇、状态总览（2026-06-21 代码审计 + 阶段 1-3 实施后更新）

> 本节由一次完整的代码审计得出，区分"README 声称"与"代码真实状态"。阶段 1-3 实施后同步更新。

### 已落地（代码审计确认）

| 能力 | 状态 | 审计结论 |
|---|---|---|
| **P0-1 Long-Term Memory** | ✅ 完成 | `packages/runtime/src/memory/` 14 个文件全部真实实现：6 种记忆子系统（short/long/episodic/semantic/procedural/preferences）+ `knowledge/`（project/user/document）+ `privacy.ts`（GDPR）+ `policy.ts`（写入策略）+ `shared.ts`（跨 Agent）+ `storage/vector-store.ts`（余弦相似度）+ `embedding/`（本地 n-gram） |
| **P0-2 Desktop 独立应用** | ✅ 完成 | `apps/desktop/` 33 个 .ts 文件真实实现：Main/Preload/Renderer 三进程 + Chat/Trace/Settings/Memory 四面板 + Tray + Hotkey + Updater + License + RuntimeBridge + SessionManager + BrowserService。`dist/win-unpacked/Z Assistant.exe` 已存在，证明打包链路通 |
| **P0-3 Computer Use** | ✅ 完成 | `packages/agents/browser-agent/` 6 文件真实（Playwright 后端 + DOM 解析 + 决策循环 + Session 持久化 + 元素高亮）+ `runtime/src/action/gui.ts`（跨平台 GUI）+ `runtime/src/perception/screen.ts`（截屏）+ `runtime/src/permission/computer-use.ts`（动作风险分级） |

### 部分落地

| 能力 | 状态 | 审计结论 |
|---|---|---|
| **P1-1 多模态感知** | ⚠️ 半完成 | `runtime/src/perception/` 已有 6 文件真实实现（screen/ocr/caption/audio/document/python-bridge），但 `packages/contracts/llm.ts` 的 `LLMMessage.content` 仍是 `string`，**不支持图像/音频/视频输入**。感知层能采集，但无法喂给 LLM |

### 未落地

| 能力 | 状态 | 审计结论 |
|---|---|---|
| **P1-2 Human-in-the-Loop UI** | ❌ 未开始 | 无 Confirmation 系统、无风险分级 UI、无审计日志 |
| **P1-3 Skill Auto-Discovery** | ❌ 未开始 | `runtime/src/skills/` 只有静态 loader/selector/parser，无 auto-discovery / validator / composition / obsolescence |

### 审计新发现的缺口（原 ROADMAP 未提及）

| 缺口 | 位置 | 严重度 | 说明 |
|---|---|---|---|
| **R7: V1 Coding Agent 接入 V2** | `packages/agents/coding-agent/` | 🔴 高 | 9 个文件全部 stub，`execute`/`buildPlan`/`reflect`/`verify`/`invoke` 统一返回错误码 `3001`。V2 的 Coding Agent 包名存实亡，实际 Coding 能力仍在 V1 `extensions/coding-agent/` |
| **Runtime 机制层占位** | `packages/runtime/src/{workflow,trace,errors,cost,budget,config,storage,permission}/index.ts` | 🟡 中 | 8 个 `index.ts` 是 `export {}` 占位。其中 errors/cost/budget/config/permission/storage 的真实实现已在 `packages/infra/` 下，runtime 内的占位是"re-export shim 未填充"；trace 和 workflow 完全未实现 |
| **CLI trace 子命令** | `apps/cli/src/index.ts` | 🟡 中 | `z run`/`z version`/`z help` 真实可用，但 `z trace ls`/`z trace show` 显式打印 "not implemented in Phase 6A" |
| **AssistantRuntime.boot() stub** | `apps/vscode-connector/src/index.ts` | 🟡 中 | 返回 no-op runtime + 错误码 3001，未替换为真实实现 |
| **office-agent / research-agent** | `packages/agents/{office,research}-agent/` | 🟢 低 | 纯占位 `export {}`，未开始实现（原计划就是占位） |

---

# 一、P0 能力（3 项）— 已全部落地 ✅

## P0-1: 跨 Session Long-Term Memory ✅

### 现状（已实现）

`packages/runtime/src/memory/` 14 个文件 + `knowledge/` 4 个文件全部真实实现：

| 子能力 | 实现位置 | 状态 |
|---|---|---|
| Short-Term Memory | `memory/short-term.ts` | ✅ |
| Long-Term Memory | `memory/long-term.ts` | ✅ |
| Episodic Memory | `memory/episodic.ts` | ✅ |
| Semantic Memory | `memory/semantic.ts` | ✅ |
| Procedural Memory | `memory/procedural.ts` | ✅ |
| User Profile / Preferences | `memory/preferences.ts` | ✅ |
| Project / User / Document Knowledge | `knowledge/{project,user,document}.ts` | ✅ |
| Vector Store 抽象 | `storage/vector-store.ts`（InMemoryVectorStore，余弦相似度） | ✅ |
| Memory 检索接口 | `memory/recall.ts` + `memory-manager.ts` | ✅ |
| Memory 写入策略 | `memory/policy.ts`（白名单 + 重要性阈值 + 频率限制 + 去重） | ✅ |
| Memory 共享（跨 Agent） | `memory/shared.ts`（发布/读取 + 冲突解决） | ✅ |
| 隐私与遗忘（GDPR） | `memory/privacy.ts`（view/delete/purge/export） | ✅ |
| 嵌入模型 | `embedding/index.ts`（本地 n-gram hash + L2 归一化，零外部依赖） | ✅ |
| 持久化 | `memory/provider.ts`（JsonlMemoryProvider，JSONL 文件持久化） | ✅ |

### 待优化（非阻塞）

- [ ] 向量存储目前是 `InMemoryVectorStore`，未接入 LanceDB / ChromaDB 等持久化后端
- [ ] 嵌入模型是本地 n-gram，未接入 sentence-transformers / OpenAI embedding
- [ ] 检索延迟未压测到 < 100ms（千条规模）

---

## P0-2: Desktop 实际实现 ✅

### 现状（已实现）

`apps/desktop/` 完整 Electron 应用，已成功打包出 `Z Assistant.exe`：

| 子能力 | 实现位置 | 状态 |
|---|---|---|
| GUI 框架 | Electron 30.5.1（非 Tauri，决策时选了 Electron） | ✅ |
| 进程模型 | `main.ts`（414 行）+ `preload.ts`（contextBridge）+ `renderer/`（sandboxed） | ✅ |
| Chat UI | `renderer/chat.ts`（520 行，会话侧栏 + Markdown 渲染 + 记忆召回） | ✅ |
| Trace UI | `renderer/trace.ts`（340 行，Span 树 + 过滤 + 导出） | ✅ |
| Settings UI | `renderer/settings.ts`（470 行，7 个 LLM provider + WeChat/QQ 连接） | ✅ |
| Memory UI | `renderer/memory.ts`（221 行，6 种 kind 过滤 + 搜索 + 删除） | ✅ |
| System Tray | `tray.ts`（5 项菜单） | ✅ |
| Global Hotkey | `hotkey.ts`（`Ctrl+Shift+Z`） | ✅ |
| File Association | `electron-builder.json`（`.zap`/`.zconfig`/`.zlog`） | ✅ |
| Auto Update | `updater.ts`（electron-updater 完整封装） | ✅ |
| 打包 | `electron-builder.json`（macOS dmg / Windows NSIS / Linux AppImage） | ✅ |
| License 服务 | `license.ts`（Free / Pro / Enterprise 三级 + 文件持久化） | ✅ |
| Runtime 桥接 | `runtime-bridge.ts`（336 行，VSCodeConnector + Memory CRUD + Session） | ✅ |
| 国际化 | `renderer/i18n.ts`（zh-CN / en，~80 个 key） | ✅ |

### 待优化（非阻塞）

- [ ] macOS / Linux 实际打包未验证（仅 Windows 已产出）
- [ ] 代码签名未配置（`CSC_IDENTITY_AUTO_DISCOVERY=false`）
- [ ] Auto Update 的 publish 源未配置（`electron-builder.json` 用 generic provider 占位）

---

## P0-3: Computer Use ✅

### 现状（已实现）

| 子能力 | 实现位置 | 状态 |
|---|---|---|
| Browser Automation | `packages/agents/browser-agent/src/backend.ts`（Playwright，452 行） | ✅ |
| GUI Automation | `packages/runtime/src/action/gui.ts`（PowerShell/osascript/xdotool，210 行） | ✅ |
| 截屏 | `packages/runtime/src/perception/screen.ts` | ✅ |
| 跨平台 GUI 后端 | `action/gui.ts` 内部分支处理 macos/windows/linux | ✅ |
| Browser 后端 | `browser-agent/src/backend.ts`（Playwright） | ✅ |
| DOM 解析 | `browser-agent/src/dom.ts`（buildDOMTree + pageToText） | ✅ |
| Browser Agent 决策 | `browser-agent/src/agent.ts`（observe→LLM→act 循环，164 行） | ✅ |
| 元素高亮 | `browser-agent/src/overlay.ts`（注入 CSS+JS） | ✅ |
| Browser Agent 持久化 | `browser-agent/src/session.ts`（Cookie/Storage 基于 IMemoryProvider） | ✅ |
| Action 安全策略 | `runtime/src/permission/computer-use.ts`（动作风险分级 + 危险 URL 拦截，161 行） | ✅ |
| Windows UIAutomation | `apps/vscode-connector/src/computer-use-service.ts`（497 行，PowerShell + Win32） | ✅ |
| 微信/QQ 桌面操控 | `computer-use-wechat.ts` / `computer-use-qq.ts` | ✅ |

### 待优化（非阻塞）

- [ ] Browser Agent 决策循环未与 Long-Term Memory 联动（Session 状态已持久化，但跨 Session 学习未做）
- [ ] GUI 自动化在 macOS / Linux 未实际测试

---

# 二、P1 能力（3 项）

## P1-1: 多模态感知（⚠️ 半完成）

### 现状

**感知层已实现**（`packages/runtime/src/perception/`）：

| 子能力 | 实现位置 | 状态 |
|---|---|---|
| 屏幕截取 | `perception/screen.ts`（screencapture/PowerShell/import） | ✅ |
| 图像理解（OCR） | `perception/ocr.ts`（通过 PythonBridge） | ✅ |
| 图像描述生成 | `perception/caption.ts`（通过 PythonBridge + fallback） | ✅ |
| 音频录制 / 语音识别 | `perception/audio.ts`（transcribeAudio，通过 PythonBridge） | ✅ |
| PDF / Office 文档解析 | `perception/document.ts`（Python sidecar + Node fallback） | ✅ |
| Python 桥接 | `perception/python-bridge.ts`（spawn 子进程 + JSON-lines RPC，173 行） | ✅ |

**LLM 多模态输入未实现**（`packages/contracts/llm.ts`）：

```typescript
// 当前 LLMMessage.content 仍是 string，不支持图像/音频/视频
export interface LLMMessage {
  role: MessageRole;
  content?: string;  // ❌ 仅文本
  // 缺少：images?: ImageAttachment[]
  // 缺少：audio?: AudioAttachment[]
}
```

### 缺什么

| 子能力 | 说明 | 建议位置 | 状态 |
|---|---|---|---|
| **图像输入** | LLM 接收 `images: ImageAttachment[]` | `packages/contracts/llm.ts` 扩展 `LLMMessage` | ❌ |
| **音频输入** | LLM 接收 `audio: AudioAttachment[]` | `packages/contracts/llm.ts` 扩展 | ❌ |
| **视频输入** | LLM 接收视频流 | `packages/contracts/llm.ts` 扩展 | ❌ |
| **多模态 LLM 后端** | GPT-4V / Claude 3 Vision / Gemini Vision | `packages/llm/multimodal.ts`（新建） | ❌ |
| **多模态 Skill** | "看图写代码" / "听写代码" | `packages/agents/coding-agent/src/skills/multimodal.ts` | ❌ |
| 摄像头 / 视频流 | "看" 现实 | `packages/runtime/src/perception/camera.ts` | ❌ |

### 验收标准

- [ ] `ILLMProvider` 标准接口支持多模态（`LLMMessage.content` 支持 `string | ContentPart[]`）
- [ ] Agent 能接收用户截图并理解
- [ ] Agent 能 "看" 屏幕并给出建议
- [ ] Agent 能 "读" PDF 并提取关键信息
- [ ] Agent 能 "听" 语音指令

### 依赖

- `packages/contracts/llm.ts` 扩展（向后兼容：`content: string | ContentPart[]`）
- 已有的 `perception/` 层（无需重写）

---

## P1-2: Human-in-the-Loop UI（❌ 未开始）

### 现状（已完成）\n\nV1 `extensions/coding-agent/src/infra/permission/` 有基础权限控制（fs-guard / net-guard / tool-guard，代码层面拒绝危险操作），但**无 UI**。V2 `packages/infra/permission/` 同样只有基础设施。

`apps/desktop/` 虽然有完整 UI，但没有 Confirmation 弹窗系统。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **Confirmation Prompt 系统** | Agent 执行敏感操作前问用户 | `packages/runtime/src/permission/confirmation.ts` |
| **风险分级** | 读 vs 写 vs 删 vs 联网 vs 付款 | `packages/runtime/src/permission/risk-levels.ts` |
| **操作预览** | 用户看到 Agent 想做什么（diff / 命令预览）| `packages/runtime/src/permission/preview.ts` |
| **Allow / Deny / Always Allow / Always Deny** | 用户 4 选项 | `packages/runtime/src/permission/decisions.ts` |
| **Confirmation UI（Desktop Modal）** | Electron 弹窗阻塞 | `apps/desktop/src/renderer/modal/` |
| **Confirmation UI（Chat 内）** | 在 Chat 流中显示 | `apps/{cli, desktop, vscode-connector}/src/ui/confirmation.ts` |
| **危险操作拦截** | rm -rf / 删数据库 / 改密码 | `packages/runtime/src/permission/policy.ts` |
| **Dry-run / 模拟执行** | 试运行看会发生什么 | `packages/runtime/src/permission/dry-run.ts` |
| **操作审计日志** | 事后查看 Agent 做了什么 | `packages/runtime/src/audit/logger.ts` |
| **Red-Team / 防 prompt injection** | 防 jailbreak | `packages/runtime/src/security/` |

### 验收标准

- [ ] Agent 执行 `rm -rf` 前弹出确认
- [ ] 用户能"始终允许"某类操作
- [ ] 用户能"预览" Agent 想运行的命令
- [ ] 所有 Agent 操作都有审计日志
- [ ] Dry-run 模式可启用

### 依赖

- P0-2 Desktop（Confirmation UI 需 Desktop）✅ 已就绪

---

## P1-3: Skill Auto-Discovery（❌ 未开始）

### 现状

V1 `extensions/coding-agent/src/skills/` 有 Skill 框架（loader / selector / validator），V2 `packages/runtime/src/skills/` 也有（skills.ts + skill-parser.ts，静态加载）。但 **Skill 全部是预定义的**（写在 `.skills/**/SKILL.md` 文件里），Agent **不能从失败中学到新 Skill**。

`packages/runtime/src/evolution/` 是"失败聚类 + 启发式建议"，但**不是"自动学 Skill"**。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **Skill Auto-Discovery** | 从失败案例中提取通用 Skill | `packages/runtime/src/skills/auto-discovery.ts` |
| **Skill 验证** | 自动生成的 Skill 是否正确 | `packages/runtime/src/skills/validator.ts`（已有框架，需扩展）|
| **Skill 合成** | 把多个基础 Skill 组合成复合 Skill | `packages/runtime/src/skills/composition.ts` |
| **Skill 失效检测** | 旧 Skill 不再有效 | `packages/runtime/src/skills/obsolescence.ts` |
| **Skill 索引** | 何时使用哪个 Skill | `packages/runtime/src/skills/indexer.ts` |
| **Skill 版本管理** | Skill v1 / v2 / rollback | `packages/runtime/src/skills/versions.ts` |
| **Skill 共享（跨用户）** | 用户 A 学到的 Skill 用户 B 也能用 | `packages/runtime/src/skills/community.ts` |
| **Skill 审查（人类审核）** | 敏感 Skill 需要用户确认 | `packages/runtime/src/skills/review.ts` |
| **失败案例记录** | Agent 失败时被记录为候选 Skill | `packages/runtime/src/skills/failure-cases.ts` |
| **LLM 提炼 Skill** | 用 LLM 把失败提炼成 Skill 模板 | `packages/runtime/src/skills/llm-extract.ts` |

### 验收标准

- [ ] Agent 失败 3 次同类问题后自动生成 Skill
- [ ] 自动生成的 Skill 经用户审核后加入库
- [ ] 旧 Skill 失效时自动降级到 fallback
- [ ] 用户能看到 Skill 索引

### 依赖

- P0-1 Long-Term Memory ✅ 已就绪（Skill 提炼需要历史失败案例）
- `packages/runtime/src/evolution/` 框架 ✅ 已就绪

---

# 三、审计新发现缺口（原 ROADMAP 未覆盖）

## G1: R7 — V1 Coding Agent 接入 V2 🔴 ✅ 已完成

### 现状（已完成）

`packages/agents/coding-agent/` 的 7 个 sub-adapter 全部支持 `impl` 注入委托。修复了 2 个委托 BUG，并为 `CodingAgent` 添加了完整的 `impl?: IAgent` 委托（execute / canHandle / rollback / health）。

在 `apps/vscode-connector/src/coding-agent-factory.ts` 新增工厂函数 `createCodingAgentFromChat`，把 connector 已有的 chat-agent（Plan+ReAct+Reflect 完整循环）和 24 个工具（web/file/shell/browser/perception）接入 V2 `CodingAgentLoop`：

- `agent.impl` → chat-agent IAgent（完整 Plan+ReAct+Reflect 循环 + Memory）
- `tools.impl` → `ChatToolRegistry`（V2 IToolRegistry，包装 chat 工具为 V2 ITool）
- `planner` / `reflection` / `context` / `skills` / `verifier` → 保留 stub（chat-agent 内部自有循环，待 V1 模块解耦 vscode 后单独接入）

### 已完成

- [x] `CodingAgent.execute` 支持 `impl` 委托（新增 `impl?: IAgent`）
- [x] `CodingToolRegistry.invoke` 修复委托 BUG（原先不检查 `impl`）
- [x] `CodingSkillRegistry.select` 修复委托 BUG（原先不检查 `impl`）
- [x] `CodingAgent.canHandle` / `rollback` / `health` 支持 `impl` 委托
- [x] vscode-connector 工厂函数 `createCodingAgentFromChat` 接入 chat-agent + tools

### 优先级

🔴 **高** — ✅ 已完成。V2 Coding Agent 包不再是空壳，可通过工厂函数获得完整 Coding 能力。

---

## G2: Runtime 机制层占位清理 🟡

### 现状

`packages/runtime/src/` 下 8 个 `index.ts` 是 `export {}` 占位：

| 占位文件 | 真实实现位置 | 处理方式 |
|---|---|---|
| `errors/index.ts` | `packages/infra-errors/` | 改为 re-export shim |
| `cost/index.ts` | `packages/infra-cost/` | 改为 re-export shim |
| `budget/index.ts` | `packages/infra-cost/`（BudgetGuard） | 改为 re-export shim |
| `config/index.ts` | `packages/infra-config/` | 改为 re-export shim |
| `permission/index.ts` | `packages/infra-permission/` + `runtime/permission/computer-use.ts` | 改为 re-export shim |
| `storage/index.ts` | `packages/infra-storage/` + `runtime/storage/vector-store.ts` | 改为 re-export shim |
| `trace/index.ts` | `packages/trace/` | 改为 re-export shim |
| `workflow/index.ts` | 无 | 保留占位，标注 "Phase 8+" |

### 优先级

🟡 **中** — 不影响功能（消费者直接 import `@z-assistant/infra-*`），但增加认知负担。

---

## G3: CLI trace 子命令 🟡

### 现状

`apps/cli/src/index.ts` 的 `z trace ls` / `z trace show` 显式打印 "not implemented in Phase 6A"。

### 缺什么

- [ ] `z trace ls` 接入 `@z-assistant/infra-storage` 的 RunRepo
- [ ] `z trace show <runId>` 接入 SpanRepo + 树形渲染

### 优先级

🟡 **中** — CLI 是 V2 的核心入口之一，trace 子命令缺失影响可观测性。

---

## G4: AssistantRuntime.boot() stub 🟡

### 现状

`apps/vscode-connector/src/index.ts` 的 `AssistantRuntime.boot()` 返回 no-op runtime + 错误码 3001。

### 缺什么

- [ ] 替换为真实 Runtime 实现（聚合 Memory / Orchestrator / Trace / Skills）

### 优先级

🟡 **中** — 当前 Desktop/Connector 通过 `VSCodeConnector` 绕过此 stub 直接调子模块，但长期需要统一入口。

---

## G5: office-agent / research-agent 🟢

### 现状

`packages/agents/office-agent/` 和 `research-agent/` 是纯占位 `export {}`。

### 优先级

🟢 **低** — 原计划就是占位，等 P1 能力完成后再说。

---

# 四、依赖关系图（更新后）

```text
P0-1 Long-Term Memory ✅ ─────────────┐
                                       │
P0-2 Desktop 实际实现 ✅ ───┐           │
                           │           │
P0-3 Computer Use ✅ ───────┼───────────┤
                           │           │
G1 R7 Coding Agent 接入 ───┼───────────┤  (新增，阻塞 V2 Coding 统一)
                           │           │
P1-1 多模态感知（半完成）───┼───────────┤  (只需扩展 contracts/llm.ts)
                           │           │
P1-2 Human-in-the-Loop UI ─┼───────────┤
                           │           │
P1-3 Skill Auto-Discovery ─┼───────────┘
                           │
                           ↓
        marvis 级别"完整通用 Agent 产品"
```

**关键路径（更新后）**：

1. **G1 R7** 是新发现的关键阻塞 — 不完成，V2 Coding Agent 包是空壳
2. P0-2 Desktop ✅ 已就绪，是 P1-2 HITL UI 的物理载体
3. P0-1 Memory ✅ 已就绪，是 P1-3 Skill 提炼的基础
4. P1-1 多模态感知**只需扩展 `contracts/llm.ts`**（感知层已就绪）

---

# 五、建议执行顺序（调整后）

## 阶段 1：补齐 V2 内部缺口（先做）✅ 已全部完成

1. **G1 R7: V1 Coding Agent 接入 V2** ✅ —— 7 个 sub-adapter 支持 `impl` 委托；修复 2 个委托 BUG；vscode-connector 新增 `createCodingAgentFromChat` 工厂函数
2. **G2 Runtime 占位清理** ✅ —— 7 个 `index.ts` 改为 re-export shim（workflow 保留占位）
3. **G3 CLI trace 子命令** ✅ —— `z trace ls/show` 接入 Storage + Trace projections
4. **G4 AssistantRuntime.boot()** ✅ —— 聚合 Memory + AgentRegistry + Trace + Store；新增 `createOrchestrator()` 工厂方法

## 阶段 2：保证桌面端功能  已完成

5. **桌面端功能保障**（约 2-3 周）—— 确保桌面端核心链路真实可用：
   - 修复桌面端现有测试失败（settings 默认值不一致等）
   - 桌面端接入 G1/G4 成果（`createCodingAgentFromChat` / `AssistantRuntime.createOrchestrator`）
   - 验证 Chat / Trace / Settings / Memory 四面板端到端可用
   - 修复 RuntimeBridge / SessionManager 与新 Runtime 的对接

## 阶段 3：交互与安全  核心已完成

6. **P1-2 Human-in-the-Loop UI**（约 6 周）—— Confirmation 系统 + 风险分级 + 审计日志 + Dry-run

## 阶段 4：自适应

7. **P1-3 Skill Auto-Discovery**（约 8 周）—— 失败提炼 + 验证 + 社区

## 阶段 5：多模态感知（推迟，等 API 支持）

8. **P1-1 多模态感知**（约 3 周）—— **推迟到后续阶段**，当前主要使用的 API 不支持多模态输入。等切换到支持多模态的 API（GPT-4V / Claude 3 Vision / Gemini Vision）后再做：
   - 扩展 `packages/contracts/llm.ts`：`LLMMessage.content: string | ContentPart[]`
   - 新建 `packages/llm/multimodal.ts`：Vision 适配
   - 在 `apps/desktop/` Chat UI 支持图片粘贴 / 截图发送

**总周期**：约 16 周（阶段 1 已完成，阶段 2-4 约 16 周，P1-1 多模态推迟到 API 支持后）。

---

# 六、关键决策点（更新后）

| 决策 | 选项 | 建议 | 影响 |
|---|---|---|---|
| **Desktop 框架** | ~~Electron / Tauri~~ | **Electron（已选定）** | 已落地，不重写 |
| **向量存储** | LanceDB / ChromaDB / FAISS / InMemory | LanceDB（本地优先）+ 抽象接口 | 当前 InMemory，需升级 |
| **嵌入模型** | OpenAI / Cohere / 本地 n-gram / sentence-transformers | 本地默认（sentence-transformers） + 云 API | 当前 n-gram，需升级 |
| **Browser 后端** | ~~Playwright / Puppeteer / CDP~~ | **Playwright（已选定）** | 已落地 |
| **GUI 后端** | ~~系统级 / 跨平台库~~ | **PowerShell/osascript/xdotool（已选定）** | 已落地 |
| **多模态 LLM** | GPT-4V / Claude 3 / Gemini / 开源 | 抽象接口 + 多后端 | 待实现 |
| **Skill 共享** | 中心化 / 联邦 / 端到端 | 中心化（用户 opt-in）| 待实现 |
| **License 模式** | ~~免费 / Pro / Enterprise~~ | **三级（已实现）** | 已落地 |
| **R7 接入方式** | V1 直接 import V2 / V2 包装 V1 | V2 包装 V1（Adapter 模式） | 待实现 |

---

# 七、成功标准（更新后）

## 7.1 Long-Term Memory ✅

- [x] Agent 能记住用户偏好（PreferencesMemory 已实现）
- [x] 跨 Session 检索（JsonlMemoryProvider 持久化）
- [x] 用户能查看 / 删除 / 导出 Memory（PrivacyManager）
- [x] 跨 Agent 共享 Memory（SharedMemory）
- [ ] 检索延迟 < 100ms（千条规模）—— 待压测
- [ ] 接入 LanceDB 持久化向量存储 —— 待升级

## 7.2 Desktop 实际实现 ✅

- [x] Windows .exe 能跑（`Z Assistant.exe` 已产出）
- [ ] macOS .dmg / Linux .AppImage —— 待验证
- [x] Chat / Trace / Settings / Memory UI 完整
- [x] Auto Update 集成（publish 源待配置）
- [x] License Service（Free / Pro / Enterprise）

## 7.3 Computer Use ✅

- [x] Agent 能自动化 Browser 任务（Playwright）
- [x] Agent 能操作 GUI App（PowerShell/osascript/xdotool）
- [x] 危险操作检测（computer-use.ts 风险分级）
- [x] 实时元素高亮（overlay.ts）
- [ ] 危险操作触发确认 UI —— 依赖 P1-2

## 7.4 多模态感知（⚠️ 半完成）

- [x] 感知层：screen / ocr / caption / audio / document
- [ ] `ILLMProvider` 支持图像 / 音频 / 视频 —— 待扩展 contracts
- [ ] Agent 能"看图写代码" —— 待实现
- [ ] Agent 能"听写代码" —— 待实现
- [x] Agent 能"读 PDF"（perception/document.ts）

## 7.5 Human-in-the-Loop UI  核心完成❌

- [ ] 6 类风险操作都有 Confirmation
- [ ] 4 选项 UI（Allow / Deny / Always Allow / Always Deny）
- [ ] 完整审计日志
- [ ] Dry-run 模式可启用
- [ ] 防 prompt injection

## 7.6 Skill Auto-Discovery ❌

- [ ] 失败 3 次同类问题自动生成 Skill
- [ ] 用户审核流程
- [ ] Skill 版本管理
- [ ] 社区 Skill 库（opt-in）

## 7.7 V2 内部统一  已完成

- [x] G1 R7: packages/agents/coding-agent/ 支持 impl 委托，不再返回 3001
- [x] G2: 7 个 runtime 占位 index.ts 改为 re-export shim（workflow 保留占位）
- [x] G3: z trace ls/show 真实可用（接入 Storage + Trace projections）
- [x] G4: AssistantRuntime.boot() 返回真实 Runtime（聚合 Memory + AgentRegistry + Trace + Store）

---

# 八、相关文档

- **ADR-001-Architecture-Refactor-Revised.md**：V2 架构基础（Phase 6A 完成的范围）
- **ROADMAP_V2_ASSISTANT_RUNTIME.md**：V2 顶层 Roadmap（不同视角）
- **V2_VISION.md**：V2 愿景（产品定位）
- **SECURITY.md**：安全策略
- **AGENT_SPEC.md**：V1 Coding Agent 构建规范（三层混合架构）

**本文件**专注于"距离 marvis 的能力差距"，是 V2 路线图的下半部分。2026-06-21 审计后新增"〇、状态总览"与"三、审计新发现缺口"两节，并调整执行顺序（P0 已落地，重点转向 G1-G4 内部缺口 + P1 能力）。
