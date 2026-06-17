# ROADMAP-V2: Capability Gap（V2 距离 marvis 的能力差距）

## 背景

ADR-001 完成 Phase 6A 后，V2 = "跨 Agent 通用 Runtime + 标准化接口 + 多宿主入口" 的**框架**。本文件列出 **V2 距离 marvis 这种"完整通用 Agent 产品" 还缺的关键能力**，按优先级 P0 / P1 组织。

**目标读者**：V2 维护者、贡献者、产品规划者。

**P0 能力** = 不实现 V2 仍可发布，但 marvis 核心差异化能力缺失；用户能明显感知"不如其他 Agent"。
**P1 能力** = 不实现 V2 仍可用，但 marvis 同类产品的关键能力缺失；高级用户感知。

---

# 一、P0 能力（3 项）

## P0-1: 跨 Session Long-Term Memory

### 现状

V2 仅有 `packages/runtime/src/memory/` **占位目录**，无任何实现。V1 内部 `src/memory/` 是 VSCode Memento 适配（与通用 Memory 无关）。

V1 `src/memory/repoKnowledgeBase.ts`（Repository Knowledge）是 **Coding 专用**，留 V1；通用 Knowledge 还没占位。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **Short-Term Memory** | 当前 Session 对话历史 | `packages/runtime/src/memory/short-term.ts` |
| **Long-Term Memory** | 跨 Session 用户偏好、历史任务、错误教训 | `packages/runtime/src/memory/long-term.ts` |
| **Episodic Memory** | 任务级"我做过什么"（时间线）| `packages/runtime/src/memory/episodic.ts` |
| **Semantic Memory** | 概念级"我知道什么"（知识图谱）| `packages/runtime/src/memory/semantic.ts` |
| **Procedural Memory** | 技能级"我会做什么"（与 Skill 框架对接）| `packages/runtime/src/memory/procedural.ts` |
| **User Profile / Preference Learning** | 用户习惯、风格、技能水平 | `packages/runtime/src/memory/preferences.ts` |
| **Project / User / Document Knowledge** | 跨项目知识沉淀 | `packages/runtime/src/knowledge/{project, user, document}.ts` |
| **Vector Store 抽象** | 嵌入向量检索 | `packages/runtime/src/storage/vector-store.ts` |
| **Memory 检索接口** | `recall(query, scope)` | `packages/runtime/src/memory/recall.ts` |
| **Memory 写入策略** | 何时写 / 写什么 / 何时遗忘 | `packages/runtime/src/memory/policy.ts` |
| **Memory 共享（跨 Agent）** | 多 Agent 共享上下文 | `packages/runtime/src/memory/shared.ts` |
| **隐私与遗忘（GDPR / 用户删除）** | 用户能清空自己数据 | `packages/runtime/src/memory/privacy.ts` |

### 验收标准

- [ ] Agent 能记住上次对话内容（同一用户）
- [ ] Agent 能记住用户偏好（如"我喜欢 TypeScript"）
- [ ] Agent 能从历史任务中检索相似 case 做 few-shot
- [ ] 用户能查看 / 删除自己的 Memory
- [ ] Memory 检索延迟 < 100ms（千条规模）
- [ ] 跨 Agent 共享 Memory 一致性

### 依赖

- `packages/contracts/` 新增 `IMemoryProvider` / `MemoryRecord` / `MemoryScope`
- `packages/runtime/src/storage/vector-store.ts`（向量存储后端可插拔：lancedb / chromadb / faiss）
- `packages/runtime/src/embedding/` 通用嵌入接口

---

## P0-2: Desktop 实际实现

### 现状

`apps/desktop/` 仅占位目录，无任何实现。V2 顶层承诺 "V2 = 独立程序（CLI / Desktop）"，但 Desktop 是 V2 的核心承诺之一，目前完全没动工。

V1 VSCode 扩展是当前**唯一**宿主。V2 已有 `apps/cli/` 入口设计但未实现。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **GUI 框架选型** | Electron / Tauri / Native？ | `apps/desktop/README.md` 决策文档 |
| **进程模型** | Main / Renderer / Worker 划分 | `apps/desktop/src/main.ts` / `renderer/` |
| **Chat UI** | 类似 VSCode `chat-panel` 但在独立窗口 | `apps/desktop/src/renderer/chat/` |
| **Trace UI** | 类似 V1 `trace-ui/` 但在独立窗口 | `apps/desktop/src/renderer/trace/` |
| **Settings UI** | 模型配置 / 权限 / Memory 管理 | `apps/desktop/src/renderer/settings/` |
| **System Tray** | 后台常驻 | `apps/desktop/src/tray.ts` |
| **Global Hotkey** | 全局快捷键唤醒 | `apps/desktop/src/hotkey.ts` |
| **File Association** | 关联文件类型（如 `.z-assistant-prompt`）| `apps/desktop/package.json` config |
| **Auto Update** | 自动更新 | `apps/desktop/src/updater.ts` |
| **打包** | `.exe` / `.dmg` / `.AppImage` | `apps/desktop/build/` |
| **签名** | macOS / Windows 代码签名 | `apps/desktop/certs/` |
| **License 服务** | Pro / Free 分级 | `apps/desktop/src/license.ts` |

### 验收标准

- [ ] 独立安装包能跑（macOS .dmg / Windows .exe / Linux .AppImage）
- [ ] Chat 窗口能调 V2 Runtime
- [ ] Trace 窗口能看 V2 Agent 全流程
- [ ] 用户能在 Settings 配模型 / 权限 / Memory
- [ ] Auto Update 能正常更新

### 依赖

- `apps/cli/` 必须先实现（Desktop 调用 CLI 暴露的接口）
- `packages/runtime/` 完整

### 决策点

需要先决定：**Electron vs Tauri**：

- **Electron**：成熟、生态大、包大（~150MB）
- **Tauri**：轻量（~10MB）、Rust 后端、跨平台

V1 VSCode 已是 Webview，可借鉴。**建议先选 Tauri**（轻量优先），后端逻辑共用 `apps/cli/`。

---

## P0-3: Computer Use

### 现状

V2 完全没有 Computer Use 能力。Agent 不能"操作"屏幕 / 浏览器 / GUI App，仅能"看"日志 / 文件 / Git 状态。

V1 Coding 工具（`src/tools/`）能做文件操作、Shell 命令，但不能操作 GUI（VSCode API 限制）。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **Browser Automation** | 点击 / 输入 / 滚动 / 表单提交 / 截图 | `packages/agents/browser-agent/`（占位已有，需实现）|
| **GUI Automation** | 跨平台鼠标 / 键盘 / 截屏 | `packages/runtime/src/action/gui.ts` |
| **截屏 + 图像识别** | "看到" 屏幕内容 | `packages/runtime/src/perception/screen.ts` + 多模态 LLM |
| **跨平台 GUI 后端** | macOS / Windows / Linux | `packages/runtime/src/action/gui/{macos, windows, linux}.ts` |
| **Browser 后端** | Playwright / Puppeteer / Chrome DevTools Protocol | `packages/agents/browser-agent/src/backend/` |
| **DOM 解析** | 解析 HTML / 提取结构 | `packages/agents/browser-agent/src/dom.ts` |
| **Browser Agent 决策** | 下一步点击哪里 / 输入什么 | `packages/agents/browser-agent/src/agent.ts` |
| **元素高亮 + 标注** | 用户能看到 Agent 在做什么 | `packages/agents/browser-agent/src/overlay.ts` |
| **Browser Agent 持久化** | Cookie / Session / 登录态 | `packages/agents/browser-agent/src/session.ts` |
| **Action 安全策略** | 白名单 / 黑名单 / 危险操作拦截 | `packages/runtime/src/permission/computer-use.ts` |

### 验收标准

- [ ] Agent 能打开网页、点击按钮、填写表单
- [ ] Agent 能跨标签页操作
- [ ] Agent 能处理登录态（持久化 Cookie）
- [ ] Agent 危险操作（删除、付款）触发确认 UI
- [ ] 用户能看到 Agent 实时高亮正在操作的元素

### 依赖

- P0-2 Desktop 实际实现（GUI 后端在 Desktop 进程内）
- P0-1 Long-Term Memory（Browser Session 状态需要持久化）
- 多模态 LLM（V2 `ILLMProvider` 需支持图像输入）

---

# 二、P1 能力（3 项）

## P1-1: 多模态感知

### 现状

V2 `ILLMProvider`（`packages/contracts/llm.ts`）仅支持**文本**输入 / 输出。V1 内部没有多模态能力。

Agent 完全"聋哑"——不能看图、不能听音、不能读 PDF。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **图像输入** | LLM 接收 `images: ImageAttachment[]` | `packages/contracts/llm.ts` 扩展 `LLMRequest` |
| **音频输入** | LLM 接收 `audio: AudioAttachment[]` | `packages/contracts/llm.ts` 扩展 |
| **视频输入** | LLM 接收视频流 | `packages/contracts/llm.ts` 扩展 |
| **PDF / Office 文档解析** | "读" 文档 | `packages/runtime/src/perception/document.ts` |
| **屏幕截取** | "看" 屏幕 | `packages/runtime/src/perception/screen.ts` |
| **摄像头 / 视频流** | "看" 现实 | `packages/runtime/src/perception/camera.ts` |
| **音频录制 / 语音识别** | "听" 现实 | `packages/runtime/src/perception/audio.ts` |
| **多模态 LLM 后端** | GPT-4V / Claude 3 Vision / Gemini Vision | `packages/llm/multimodal.ts` |
| **图像理解（OCR）** | 从图像提取文字 | `packages/runtime/src/perception/ocr.ts` |
| **图像描述生成** | 给视障用户 / 自动化 | `packages/runtime/src/perception/caption.ts` |
| **多模态 Skill** | "看图写代码" / "听写代码" | `packages/agents/coding-agent/src/skills/multimodal.ts` |

### 验收标准

- [ ] Agent 能接收用户截图并理解
- [ ] Agent 能 "看" 屏幕并给出建议
- [ ] Agent 能 "读" PDF 并提取关键信息
- [ ] Agent 能 "听" 语音指令
- [ ] `ILLMProvider` 标准接口支持多模态

### 依赖

- `packages/contracts/llm.ts` 扩展（向后兼容）
- P0-2 Desktop（屏幕截取需 Desktop 进程）

---

## P1-2: Human-in-the-Loop UI

### 现状

V1 内部 `src/permission/` 有**基础权限控制**（代码层面拒绝危险操作），但**无 UI**。用户无法在操作前看到 Agent 想做什么并确认。

V2 `packages/runtime/src/permission/` 仅基础设施，无 Confirmation UI。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **Confirmation Prompt 系统** | Agent 执行敏感操作前问用户 | `packages/runtime/src/permission/confirmation.ts` |
| **风险分级** | 读 vs 写 vs 删 vs 联网 vs 付款 | `packages/runtime/src/permission/risk-levels.ts` |
| **操作预览** | 用户看到 Agent 想做什么（diff / 命令预览）| `packages/runtime/src/permission/preview.ts` |
| **Allow / Deny / Always Allow / Always Deny** | 用户 4 选项 | `packages/runtime/src/permission/decisions.ts` |
| **Confirmation UI（Chat 内）** | 在 Chat 流中显示 | `apps/{cli, desktop, vscode-connector}/src/ui/confirmation.ts` |
| **Confirmation UI（Modal）** | 弹窗阻塞 | `apps/desktop/src/renderer/modal/` |
| **Confirmation UI（Webview）** | V1 VSCode Webview | `extensions/coding-agent/src/panels/confirmation/` |
| **危险操作拦截** | rm -rf / 删数据库 / 改密码 | `packages/runtime/src/permission/policy.ts` |
| **Dry-run / 模拟执行** | 试运行看会发生什么 | `packages/runtime/src/permission/dry-run.ts` |
| **操作审计日志** | 事后查看 Agent 做了什么 | `packages/runtime/src/audit/logger.ts` |
| **Red-Team / 防 prompt injection** | 防 jailbreak | `packages/runtime/src/security/` |

### 验收标准

- [ ] Agent 执行 `rm -rf` 前弹出确认
- [ ] 用户能"始终允许"某类操作
- [ ] 用户能"预览" Agent 想运行的命令
- [ ] 所有 Agent 操作都有审计日志
- [ ] 用户能事后回放 Agent 操作
- [ ] Dry-run 模式可启用

### 依赖

- P0-2 Desktop（Confirmation UI 需 Desktop）

---

## P1-3: Skill Auto-Discovery

### 现状

V1 内部 `src/skills/` 已有 Skill 框架（loader / selector / validator），**V2 也有占位**（`packages/runtime/src/skills/`）。但 **Skill 全部是预定义的**（写在文件里），Agent **不能从失败中学到新 Skill**。

V1 `src/evolution/` 是"自动改代码"，但**不是"自动学 Skill"**。

### 缺什么

| 子能力 | 说明 | 建议位置 |
|---|---|---|
| **Skill Auto-Discovery** | 从失败案例中提取通用 Skill | `packages/runtime/src/skills/auto-discovery.ts` |
| **Skill 验证** | 自动生成的 Skill 是否正确 | `packages/runtime/src/skills/validator.ts`（已有框架）|
| **Skill 合成** | 把多个基础 Skill 组合成复合 Skill | `packages/runtime/src/skills/composition.ts` |
| **Skill 失效检测** | 旧 Skill 不再有效 | `packages/runtime/src/skills/obsolescence.ts` |
| **Skill 索引** | 何时使用哪个 Skill | `packages/runtime/src/skills/indexer.ts` |
| **Skill 版本管理** | Skill v1 / v2 / rollback | `packages/runtime/src/skills/versions.ts` |
| **Skill 共享（跨用户）** | 用户 A 学到的 Skill 用户 B 也能用 | `packages/runtime/src/skills/community.ts` |
| **Skill 审查（人类审核）** | 敏感 Skill 需要用户确认 | `packages/runtime/src/skills/review.ts` |
| **失败案例记录** | Agent 失败时被记录为候选 Skill | `packages/runtime/src/skills/failure-cases.ts` |
| **LLM 提炼 Skill** | 用 LLM 把失败提炼成 Skill 模板 | `packages/runtime/src/skills/llm-extract.ts` |
| **A/B 测试 Skill** | 多个 Skill 候选效果对比 | `packages/runtime/src/skills/ab-test.ts` |

### 验收标准

- [ ] Agent 失败 3 次同类问题后自动生成 Skill
- [ ] 自动生成的 Skill 经用户审核后加入库
- [ ] 旧 Skill 失效时自动降级到 fallback
- [ ] 用户能看到 Skill 索引（哪些 Skill 何时用）
- [ ] 社区 Skill 库可订阅
- [ ] 危险 Skill（删数据库）需要人类双签

### 依赖

- P0-1 Long-Term Memory（Skill 提炼需要历史失败案例）
- `packages/runtime/src/evolution/` 框架（自动改 Skill）

---

# 三、依赖关系图

```text
P0-1 Long-Term Memory ─────────────┐
                                    │
P0-2 Desktop 实际实现 ───┐          │
                          │          │
P0-3 Computer Use ────────┼──────────┤
                          │          │
P1-1 多模态感知 ──────────┼──────────┤
                          │          │
P1-2 Human-in-the-Loop UI ┼──────────┤
                          │          │
P1-3 Skill Auto-Discovery ┼──────────┘
                          │
                          ↓
        marvis 级别"完整通用 Agent 产品"
```

**关键路径**：

- P0-2 Desktop 是 P0-3 / P1-1 / P1-2 的物理载体
- P0-1 Memory 是 P0-3 Browser Session / P1-3 Skill 提炼的基础
- P0-3 Computer Use 是 P1-3 自动化学习的执行环境

---

# 四、建议执行顺序

## 阶段 1：基础设施（先做）

1. **P0-1 Long-Term Memory**（约 8 周）—— 6 大子能力 + 向量存储 + 隐私
2. **P0-2 Desktop 实际实现**（约 12 周）—— Tauri 选型 + 4 个 UI + 打包签名

## 阶段 2：行动能力（其次）

3. **P0-3 Computer Use**（约 10 周）—— Browser Agent + GUI 后端 + 安全策略

## 阶段 3：感知 / 交互

4. **P1-1 多模态感知**（约 6 周）—— `ILLMProvider` 扩展 + 5 种感知器
5. **P1-2 Human-in-the-Loop UI**（约 6 周）—— 6 种 UI + 审计日志

## 阶段 4：自适应

6. **P1-3 Skill Auto-Discovery**（约 8 周）—— 失败提炼 + 验证 + 社区

**总周期**：约 50 周（约 12 个月）可达到 marvis 同类产品水平。

---

# 五、关键决策点

| 决策 | 选项 | 建议 | 影响 |
|---|---|---|---|
| **Desktop 框架** | Electron / Tauri / Native | Tauri | 轻量、跨平台、Rust 后端可复用 |
| **向量存储** | LanceDB / ChromaDB / FAISS / Pinecone | LanceDB（本地优先） + 抽象接口 | 本地默认 + 云可扩展 |
| **嵌入模型** | OpenAI / Cohere / 本地 | 本地默认（llama.cpp / sentence-transformers） + 云 API | 离线可用 + 隐私 |
| **Browser 后端** | Playwright / Puppeteer / CDP | Playwright | 跨浏览器 + 稳定 |
| **GUI 后端** | 系统级（macOS Quartz / Win32 / X11） / 跨平台库 | 跨平台库（如 Tauri 内置）| 实现成本 |
| **多模态 LLM** | GPT-4V / Claude 3 / Gemini / 开源 | 抽象接口 + 多后端 | 避免 vendor lock-in |
| **Skill 共享** | 中心化 / 联邦 / 端到端 | 中心化（用户 opt-in）| 信任 / 隐私 |
| **License 模式** | 免费 / Pro / Enterprise | 免费 + Pro 高级 | 商业化 |

---

# 六、成功标准（6 项 P0+P1 全部完成时）

## 6.1 Long-Term Memory ✅

- [ ] Agent 能记住用户偏好 30 天
- [ ] 跨 Session 检索 < 100ms
- [ ] 用户能查看 / 删除 / 导出 Memory
- [ ] 跨 Agent 共享 Memory 一致

## 6.2 Desktop 实际实现 ✅

- [ ] macOS .dmg / Windows .exe / Linux .AppImage 都能跑
- [ ] Auto Update 正常
- [ ] Chat / Trace / Settings UI 完整

## 6.3 Computer Use ✅

- [ ] Agent 能自动化 Browser 任务
- [ ] Agent 能操作 GUI App
- [ ] 危险操作触发确认 UI
- [ ] 实时元素高亮

## 6.4 多模态感知 ✅

- [ ] `ILLMProvider` 支持图像 / 音频 / 视频
- [ ] Agent 能"看图写代码"
- [ ] Agent 能"听写代码"
- [ ] Agent 能"读 PDF"

## 6.5 Human-in-the-Loop UI ✅

- [ ] 6 类风险操作都有 Confirmation
- [ ] 4 选项 UI（Allow / Deny / Always Allow / Always Deny）
- [ ] 完整审计日志
- [ ] Dry-run 模式可启用
- [ ] 防 prompt injection

## 6.6 Skill Auto-Discovery ✅

- [ ] 失败 3 次同类问题自动生成 Skill
- [ ] 用户审核流程
- [ ] Skill 版本管理
- [ ] 社区 Skill 库（opt-in）

---

# 七、相关文档

- **ADR-001-Architecture-Refactor-Revised.md**：V2 架构基础（Phase 6A 完成的范围）
- **ROADMAP_V2_ASSISTANT_RUNTIME.md**：V2 顶层 Roadmap（不同视角）
- **V2_VISION.md**：V2 愿景（产品定位）
- **SECURITY.md**：安全策略

**本文件**专注于"距离 marvis 的能力差距"，是 V2 路线图的下半部分。
