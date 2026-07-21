# Ziner

> **品牌迁移说明 / Rebranding Notice**
> 本项目正在从旧名称 **"Z Code / Z Assistant"** 逐步迁移到 **"Ziner"**。README 与对外文档已提前使用新名称，但当前 GitHub 仓库名（`Z-code`）和本地文件夹名（`Z Code`）暂未变更，后续会统一处理。
>
> **项目定位 / Project Positioning**
> 本项目是一个**面向学习的 Agent 流程实现**，核心目标是逐步构建和理解 Coding Agent 的完整工作流。从 v0.3.0 到最新版本，每个版本的迭代都对应一个可学习的里程碑，适合**按版本顺序逐步阅读代码、理解演进过程**。
>
> **注意事项 / Caveats**
> - 随着功能持续叠加，部分模块之间可能出现边界模糊或轻微 Bug
> - 已支持 MCP (Model Context Protocol) 外部工具：在 `VSCodeConnectorConfig.mcpServers` 中配置，agent 启动时会自动连接并把 server 的工具注入到 ReAct 循环和 V2 `IToolRegistry`

---

## 📥 下载 / Download

最新版本的可执行文件已发布在 **GitHub Releases** 中，无需编译即可直接使用：

👉 [前往 Releases 页面下载](https://github.com/qinyu/Z-code/releases)

| 平台 | 格式 | 说明 |
|------|------|------|
| 🪟 **Windows** | `Ziner.exe`（绿色版） | 解压后直接运行，无需安装 |
| 📱 **Android** | `Ziner.apk` | Android 8.0+，支持 ARM64 |
| 🧩 **VSCode 扩展** | `ziner-coding-agent-x.x.x.vsix` | VS Code 1.85+，从 VSIX 安装 |

> **提示**：如果 GitHub 下载速度慢，可以尝试使用国内镜像或代理加速。

---

## 📱 移动端（Android App）

Ziner 提供 Android 移动端应用，与桌面端保持一致的 UI 和功能体验，支持随时随地与 AI 对话。

### 移动端功能特性

| 特性 | 说明 |
|------|------|
| 💬 **流式对话** | 支持 Markdown 渲染、代码高亮、流式输出 |
| 📚 **多会话管理** | 侧边栏查看历史会话，一键新建和切换 |
| 🧠 **长期记忆** | 6 种记忆子系统，自动记住重要信息 |
| 🔍 **Trace 追踪** | 实时查看 Agent 思考过程、工具调用、耗时分析 |
| ⚙️ **完整设置** | 模型配置 / MCP 服务 / 工具策略 / 记忆后端，与桌面端一致 |
| 📤 **配置同步** | 支持导出/导入 JSON 配置，手机电脑一键同步 |
| 🌐 **双运行模式** | 本地 Runtime（离线 Mock）/ 远程 Runtime（HTTP SSE 流式） |
| 📋 **点击复制** | 点击消息气泡即可复制内容 |
| 🎨 **Warm Minimal 主题** | 与桌面端一致的温暖极简浅色主题 |

### 移动端技术栈

- **Capacitor 6** — Web → Native 桥接
- **Vite 5** — 构建工具
- **TypeScript** — 类型安全
- **IndexedDB** — 本地 Trace 存储
- **LocalStorage** — 配置持久化

### 移动端构建

```powershell
cd apps/mobile
npm run build              # 构建 Web 资源
npx cap sync android       # 同步到 Android 项目
.\release-build.ps1        # 编译 Release APK
# 产物：apps/mobile/android/app/release/app-release.apk
```

---

## 演示：Agent 旅游规划

以下是一个实际运行结果：用户要求 Agent 从上海虹桥阿里中心自驾（电车）去南京旅游，三天两夜，预算 1500 元，住全季/亚朵酒店。Agent 在 **仅有高德 MCP（地图/导航/搜索）**、**没有携程/飞猪等酒店预订平台 MCP** 的情况下，通过高德 MCP 查询酒店位置和价格，结合 Web 搜索获取美食推荐，完成了完整的预算规划和行程安排。

> **完整输出见：[旅游规划.md](旅游规划.md)**

### 本次演示中 Agent 使用的工具

| 工具 | 用途 | 说明 |
|------|------|------|
| `mcp_amap_maps_text_search` | 高德 MCP 文本搜索 | 查询全季/亚朵酒店在南京的位置、价格区间 |
| `web_search` | DuckDuckGo 网页搜索 | 查询高速过路费、油费/电费、美食推荐等公开信息 |
| `web_fetch` | 网页内容抓取 | 获取具体的价格详情和店家信息 |

### 能力边界说明

| 能力 | 支持情况 |
|------|:--------:|
| 高德地图 MCP（查位置、路线、周边搜索） | ✅ 已接入 |
| 网页搜索（查公开信息） | ✅ 支持 |
| 网页内容抓取 | ✅ 支持 |
| 携程/飞猪 MCP（查实时酒店价格、空房、下单） | ❌ **未接入** |
| 美团/大众点评 MCP（查餐厅实时评价、团购） | ❌ **未接入** |

> 因此，Agent 输出的酒店价格是**基于高德 MCP 返回的参考价**，非实时可预订价；如需实时比价和预订，需接入携程/飞猪等平台的 MCP Server。

---

## MCP 配置

### 配置示例

```js
{
  mcpServers: [
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/workspace'],
    },
    {
      name: 'amap',
      transport: 'streamablehttp',
      url: 'https://mcp.amap.com/mcp?key=${env:AMAP_MAPS_API_KEY}',
    },
    {
      name: 'mcdonalds',
      transport: 'streamablehttp',
      url: 'https://mcp.mcd.cn',
      headers: {
        Authorization: 'Bearer ${env:MCD_MCP_TOKEN}',
      },
    },
  ],
}
```

每个 MCP 工具在 agent 中会被命名为 `mcp_<serverName>_<toolName>`，避免与内置工具冲突。

### 高德 MCP 配置方式

1. **Desktop 设置面板**：设置 → 高德地图 API Key（保存后自动注入为 `AMAP_MAPS_API_KEY` 环境变量，并自动连接高德 MCP Server）。
2. **环境变量**：启动前设置 `AMAP_MAPS_API_KEY=...`。

### 麦当劳 MCP Token 配置方式（三选一）

1. **Desktop 设置面板**：设置 → MCP 外部工具 → 麦当劳 MCP Token（保存后自动注入为 `MCD_MCP_TOKEN`）。
2. **环境变量**：启动前设置 `MCD_MCP_TOKEN=...`。
3. **直接替换**：把配置里的 `${env:MCD_MCP_TOKEN}` 替换为真实 token（不推荐，容易泄露）。

麦当劳中国 MCP 接入文档：`https://open.mcd.cn/mcp/doc`

---

## 仓库结构

仓库是一个 **V1 + V2 双轨 Monorepo**：
- **V1 = `extensions/coding-agent/`**：VSCode Coding Agent 扩展（v1.2.0，三层混合架构 + 完整流水线，**当前唯一可用的 Coding 能力**）
- **V2 = 仓库根 `packages/` + `apps/`**（npm workspaces）：Assistant Runtime 平台，**不再是 VSCode 扩展**，包含独立 Desktop 应用、CLI、Runtime 框架

**当前版本 / Current Versions**
- V1（VSCode 扩展）：v1.2.0
- V2（Assistant Runtime）：v2.0.0-alpha.5

---

## 项目结构 / Project Structure

```
Ziner/
├── extensions/
│   └── coding-agent/               V1：VSCode Coding Agent 扩展（v1.2.0，三层混合架构）
├── packages/                       V2：Assistant Runtime 平台
│   ├── contracts/                  跨包类型 / 接口（IAgent / IPlanner / ILLMProvider …）
│   ├── infra/                      基础设施（5 个独立包，互相不依赖）
│   │   ├── config/                 配置中心 + secrets
│   │   ├── cost/                   pricing + budget（多模型 token 计价）
│   │   ├── errors/                 错误码 + 分类器
│   │   ├── permission/             fs-guard / net-guard / tool-guard
│   │   └── storage/                JSONL Store（runs / spans / evaluations）
│   ├── trace/                      Span 生命周期 / RunTracker / Projections / Instrumenter
│   ├── runtime/                    V2 Runtime（机制层 + 框架层）
│   │   └── src/
│   │       ├── orchestrator/       多 Agent 协调（sequential/parallel/dag）
│   │       ├── planning/           DAG / sequential 调度器
│   │       ├── reflection/         反射引擎框架
│   │       ├── context/            Context Budget 管理
│   │       ├── skills/             Skill loader / selector / parser
│   │       ├── evaluation/         Benchmark runner + sandbox + rubric
│   │       ├── evolution/          失败聚类 + 启发式建议
│   │       ├── memory/             6 种记忆子系统 + 隐私 + 共享
│   │       ├── knowledge/          Project / User / Document 知识层
│   │       ├── action/             GUI 自动化（鼠标/键盘/剪贴板）
│   │       ├── perception/         Screen / OCR / Caption / Audio / Document
│   │       ├── permission/         Computer Use 安全策略
│   │       ├── storage/            Vector Store（InMemory + 余弦相似度）
│   │       └── embedding/          本地 n-gram 嵌入
│   └── agents/                     Agent 包
│       ├── browser-agent/          Browser Agent（Playwright + DOM + 决策循环）
│       ├── coding-agent/           ⚠️ stub（等待 R7 接入 V1）
│       ├── office-agent/           占位
│       └── research-agent/         占位
├── apps/                           V2 宿主入口
│   ├── cli/                        CLI（z run / z version / z help；trace 子命令 stub）
│   ├── desktop/                    Electron 桌面应用（Chat/Trace/Settings/Memory 四面板）
│   ├── mobile/                     Android 移动端应用（Capacitor 6 + Vite 5）
│   └── vscode-connector/           V2 ↔ V1 桥接 + 微信/QQ 自动回复 + Computer Use
├── docs/                           设计文档 + ADR + Phase 路线
├── coding-test/                    Trae vs Ziner 对比测试
├── AGENT_SPEC.md                   V1 Coding Agent 构建规范
├── build-all.ps1                   一键构建脚本（Python venv + TS + PyInstaller + electron-builder）
└── package.json                    Monorepo 根（npm workspaces）
```

---

## V1 — Coding Agent VSCode 扩展

> 扩展本体的安装、配置、使用说明、更新日志与发布信息，请以 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md) 为准。

### 架构

知识驱动 + 自我验证闭环架构 / Knowledge-Driven + Self-Verification Loop：

```
Discovery → Skill Discovery → Task Understanding → Complexity Estimation
  → Architecture Review → Change Impact Analysis → Planner
  → Execute → Verify → [条件触发] Reflection Agent → Replan
```

**三层混合架构**（[AGENT_SPEC.md](file:///d:/mycode/Z%20Code/AGENT_SPEC.md)）：
- **Layer 1: Planner**（宏观 Plan-and-Execute，拆解子任务）
- **Layer 2: ReAct Executor**（微观 THINK → ACT → OBSERVE 循环）
- **Layer 3: Reflector**（兜底反思，自动迭代修正）

### 特性 / Features

| 特性 | 说明 |
|---|---|
| 🧠 **Repo-Level Agent** | 多轮记忆 + Embedding 检索 + RepoGraph + Planner 管道 |
| 🔭 **Discovery Phase** | Planner 之前运行深度发现：Symbol Retrieval → Context Expansion → Module/Risk/Scope 分析 |
| 🧭 **执行模式路由** | 由 LLM 判断走轻量流程还是完整规划流程，代码侧做安全兜底 |
| 📋 **结构化计划清单** | `PLANNING` 阶段输出 JSON To-Do List，侧边栏渲染为 Checklist |
| 🗜️ **Auto-Compact** | 长对话接近上下文上限时自动压缩旧历史，保留当前计划与关键证据 |
| 🧱 **缓存友好的 Prompt 布局** | 静态上下文前置、动态上下文后置，提升前缀复用率 |
| 🧠 **长上下文支持** | 最大 128K 上下文窗口 |
| 💬 **多轮记忆系统** | 按 repo/session/intent 维度存储对话 |
| 🔄 **LLM Query Rewrite** | 中文查询自动改写为英文 Search Terms |
| 🔍 **Intent-Aware 混合检索** | BM25 + Embedding + Graph + CodeRel + FileType 五路融合 |
| 🗺️ **RepoGraph** | 模块分层 + 数据流图 + 跨模块依赖 |
| 📦 **增量上下文** | 只加载相关文件，禁止全量扫描 |
| 🤖 **Chat 侧边栏** | 多会话持久化、流式响应、Markdown 渲染、自动应用修改 + Diff / 回退 |
| 🎼 **Composer** | 多文件批量编辑 |
| ⚡ **Tab 补全** | 基于 FIM 的智能代码补全 |
| ✏️ **行内编辑** | 选中代码直接修改 |
| 🔧 **多配置管理** | 保存多个 LLM 配置，一键切换 |
| 🌐 **多后端支持** | SGLang / OpenAI / Azure OpenAI / Deepseek / 小米 MiMo |
| 📚 **Code Index** | LSP 符号索引，按名称和类型搜索 |
| ✅ **Verifier** | 自动执行 `tsc --noEmit` / `eslint` / `npm test` |
| 🔧 **局部编辑工具** | `replace_text` / `insert_before` / `insert_after` / `append_text` |
| 📊 **工具使用率分析** | 统计 Agent 调用工具的频率和覆盖率 |
| 📈 **Git 分析器** | 自动检索 `git log` / `git blame` / `git diff` |
| 🛡️ **幻觉约束** | OBSERVE 阶段检测工具返回空数据/错误，自动注入警告 |
| 🚫 **危险命令拦截** | `run_terminal` 内置危险命令检测（`rm -rf`、`git push --force` 等） |
| 🔄 **Diff 引擎** | 编辑操作幂等去重 + 模糊匹配兜底 |
| ↻ **对话重试** | 每条 assistant/error 消息右下角显示重试按钮 |
| 🛡️ **防跳过机制** | 工具调用失败后强制禁止标记子任务完成 |
| 🗑️ **文件删除感知** | 文件系统监听 + 索引同步 + 防御性 `fs.existsSync` 过滤 |
| 🌐 **Web 搜索** | `web_search` / `web_fetch` 工具（DuckDuckGo） |
| 📤 **会话导出** | 导出为 Markdown 或 JSON |
| 💭 **思考过程可视化** | Compact 模式下显示可折叠思考块（THINK / OBSERVE） |
| 🧩 **Symbol Retrieval** | 全局符号空间检索，融合文件相关性与符号匹配度 |
| 🔗 **Context Expansion Engine** | 7 种静态关系扩展（import/export/define/call/reference/implement/inherit） |
| 📚 **Repo Knowledge Base** | 长期代码库知识库：Architecture Summary / Tech Stack / Entry Points / Core Modules / Critical Files |
| 🛠️ **Skill System** | OpenClaw / Claude Code 兼容的 Skill 系统：YAML frontmatter（`name` / `description` / `argument-hint` / `user-invocable`）+ 项目扩展字段 + `references/` 目录引用 + 7 信号加权评分 + imports 递归展开 |
| 📏 **Context Budget** | 统一预算管理：按来源限制字符数，优先级驱动裁剪 |
| 🔄 **Reflection Loop** | 结构化 FailureAnalysis + RepairAction[] + ReflectionMemory，连续两轮无改善自动停止 |
| 🧩 **AgentPipeline** | 8 阶段前置分析流水线（Discovery → TaskUnderstanding → SkillSelection → ComplexityEstimation → ArchitectureReview → ChangeImpactAnalysis → Planning → ContextSetup） |
| 📦 **EditTransaction** | 编辑事务化，多文件修改绑定统一事务 ID，支持快照/冲突检测/按事务回滚 |

### 支持的后端 / Supported Backends

| Provider | 说明 | API Key |
|---|---|---|
| **SGLang** | 本地高性能推理 / Local inference | ❌ |
| **OpenAI** | GPT 系列模型 | ✅ |
| **Azure OpenAI** | Azure 托管的 OpenAI 服务 | ✅ |
| **Deepseek** | 国产大模型 | ✅ |
| **小米 MiMo** | 小米大模型 | ✅ |

### 安装 / Installation

#### 方式 1：.vsix 安装（推荐）

```powershell
.\tools\update.ps1
```

然后在 VS Code 中：`Ctrl+Shift+X` → `...` → `Install from VSIX` → 选择生成的 `.vsix` 文件

#### 方式 2：开发者模式

```bash
cd extensions/coding-agent
npm install
npm run compile
# 按 F5 启动调试
```

### 快速开始 / Quick Start

1. `Ctrl+Shift+P` → `Coding Agent: 添加配置`，按照向导配置 LLM
2. 点击左侧活动栏的 **Coding Agent 图标** 打开侧边聊天栏
3. 在底部输入框输入你的问题
4. 观察 Agent 自动生成的计划清单、运行状态提示和代码修改结果
5. 如有变更，可在侧边栏中查看 Diff、回退单文件或整批修改

### 快捷键 / Shortcuts

| Shortcut | 功能 |
|---|---|
| `Ctrl+Shift+L` | 打开 Chat 输出面板 |
| `Ctrl+Shift+I` | 弹出输入框发送消息 |
| `Ctrl+Shift+O` | 打开 Composer 面板 |
| `Ctrl+K Ctrl+I` | 行内编辑（需选中代码） |
| `Tab` | 接受代码补全 |

---

## V2 — Assistant Runtime 平台

> 配套设计：[ADR-001](docs/ADR-001-Architecture-Refactor-Revised.md)、[ADR-0007](docs/ADRS/0007-runtime-decoupling.md)、[ROADMAP_V2_ASSISTANT_RUNTIME.md](docs/ROADMAP_V2_ASSISTANT_RUNTIME.md)、[V2_VISION.md](docs/V2_VISION.md)、[ROADMAP-V2-Capability-Gap.md](docs/ROADMAP-V2-Capability-Gap.md)

### V2 定位

Ziner V2 是一个**跨 Agent 复用的运行时平台**：trace / storage / cost / errors / permission / config / budget / orchestrator / planning / reflection / context / skills / evaluation / evolution / memory 一套机制，让 Coding / Research / Office / Browser Agent 在同一 Runtime 上跑。

V1 VSCode 扩展保留并继续发版；V2 不替换 V1，而是给 V1 加一层 Adapter，并为未来非 Coding 的 Agent（Browser / Research / Office）铺好 Runtime。

### V2 包清单（代码审计后真实状态）

| 包 | 版本 | 职责 | 状态 |
|---|---|---|---|
| `@ziner/contracts` | 0.1.0 | 跨包类型 / 接口（`IAgent` / `IPlanner` / `IReflectionEngine` / `IContextProvider` / `ISkillRegistry` / `IToolRegistry` / `IVerifier` / `ILLMProvider` / `IBudgetGuard` / `AgentRun` / `Span` …） | ✅ 真实 |
| `@ziner/infra-errors` | 0.1.0 | 错误码 + 分类器（`3001-3999` 通用错误） | ✅ 真实 |
| `@ziner/infra-cost` | 0.1.0 | pricing + budget（多模型 token 计价 + 预算控制） | ✅ 真实 |
| `@ziner/infra-storage` | 0.1.0 | JSONL Store（runs / spans / evaluations / candidates） | ✅ 真实 |
| `@ziner/infra-permission` | 0.1.0 | fs-guard / net-guard / tool-guard | ✅ 真实 |
| `@ziner/infra-config` | 0.1.0 | 配置中心 + secrets | ✅ 真实 |
| `@ziner/trace` | 0.1.0 | Span 生命周期 / RunTracker / TraceManager / Projections / Instrumenter | ✅ 真实 |
| `@ziner/runtime` | 0.1.0 | orchestrator / planning / reflection / context / skills / evaluation / evolution / **memory（6 种记忆子系统）** / **knowledge（project/user/document）** / **action（GUI 自动化）** / **perception（screen/ocr/caption/audio/document）** / **permission/computer-use（安全策略）** / **storage/vector-store** / **embedding** | ✅ 真实（8 个机制层 `index.ts` 是占位，真实实现在 `infra/*`） |
| `@ziner/agent-browser` | 0.1.0 | Browser Agent（Playwright 后端 / DOM 解析 / Session 持久化 / 元素高亮 / 决策引擎 / 跨标签页操作） | ✅ 真实 |
| `@ziner/agent-coding` | 0.1.0 | Coding Agent V2 适配层 | ⚠️ **stub**（业务方法返回错误码 3001，等待 R7 接入 V1） |
| `@ziner/agent-research` | 0.1.0 | Research Agent | 🟢 占位 |
| `@ziner/agent-office` | 0.1.0 | Office Agent | 🟢 占位 |
| `@ziner/app-cli` | 0.1.0 | V2 CLI 入口（`z run` / `z version` / `z help` 真实；`z trace ls/show` stub） | ⚠️ 部分实现 |
| `@ziner/app-vscode-connector` | 0.1.0 | V2 ↔ V1 桥接 + WeChatFerry / QQ OneBot / Computer Use 微信/QQ 操控 | ✅ 真实（`AssistantRuntime.boot()` 仍是 stub） |
| `@ziner/app-desktop` | 0.1.0 | Electron 桌面应用（Chat / Trace / Settings / Memory 面板 + Tray + Hotkey + Auto Update + License） | ✅ 真实（已打包出 `Ziner.exe`） |
| `@ziner/app-mobile` | 1.8.0 | Android 移动端应用（Capacitor 6 + Vite 5，与桌面端 UI/功能一致） | ✅ 真实（已打包出 `Ziner.apk`） |

### V2 已落地能力（代码审计确认）

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 📖 **Long-Term Memory** | `packages/runtime/src/memory/` + `knowledge/` | 6 种记忆子系统（short/long/episodic/semantic/procedural/preferences）+ Knowledge 层（project/user/document）+ 隐私遗忘（GDPR）+ 写入策略 + 跨 Agent 共享 + InMemoryVectorStore + 本地 n-gram 嵌入 + JSONL 持久化 |
| 🖥️ **Desktop 独立应用** | `apps/desktop/` | Electron 30.5.1 + Main/Preload/Renderer 三进程 + Chat/Trace/Settings/Memory 四面板 + System Tray + Global Hotkey（`Ctrl+Shift+Z`）+ Auto Update + License Service（Free/Pro/Enterprise）+ File Association（`.zap`/`.zconfig`/`.zlog`）+ i18n（zh-CN/en） |
| 🤖 **Computer Use** | `packages/agents/browser-agent/` + `runtime/src/{action,perception,permission}/` | Browser Agent（Playwright + DOM 解析 + 决策循环 + Session 持久化 + 元素高亮）+ GUI 自动化（PowerShell/osascript/xdotool）+ Screen 截图 + OCR + Caption + Audio + Document 解析 + 安全策略（动作风险分级 + 危险 URL 拦截） |
| 🎯 **Orchestrator** | `packages/runtime/src/orchestrator/` | 多 Agent 协调（agent-registry 按 capability 评分 / shared-state pub/sub + 版本追踪 / sequential/parallel/dag 三模式 + fail-fast + maxAgentCalls） |
| 🪜 **框架层** | `packages/runtime/src/{planning,reflection,context,skills,evaluation,evolution}/` | planning（DAG/sequential 调度器）/ reflection（失败分类 + 反思）/ context（Budget 管理）/ skills（loader/selector/parser）/ evaluation（BenchmarkRunner + LocalSandbox + Rubric + CandidateAdapter）/ evolution（失败聚类 + 启发式建议） |
| 💚 **WeChatFerry 微信自动回复** | `apps/vscode-connector/src/wechat-hook-service.ts` | DLL 注入微信 Windows 客户端，自动回复好友私聊和群聊 @消息，支持风格模仿 |
| 💙 **QQ 自动回复（NapCat + OneBot）** | `apps/vscode-connector/src/qq-onebot-service.ts` | NapCat + OneBot v11 WebSocket 协议，自动回复 QQ 好友私聊和群聊 @消息 |
| 🖥️ **Computer Use 微信/QQ 操控** | `apps/vscode-connector/src/computer-use-{service,wechat,qq}.ts` | Windows UIAutomation（PowerShell + Win32）截图 + OCR + 鼠标键盘模拟操控微信/QQ 窗口，零封号风险 |
| 🧠 **Chat Agent** | `apps/vscode-connector/src/chat-agent.ts` | Plan+ReAct+Reflect 完整循环（memory recall → planning → ReAct loop → memory save），支持原生 tool_calls + XML fallback（兼容 DeepSeek）。**新增双模式规划**（simple/hierarchical/auto）+ **事实提取器**（规则+LLM混合提取用户事实替换硬编码偏好）+ **多模态附件预处理**（图片OCR/caption、音频转录、文档解析） |
| 🛠️ **工具集** | `apps/vscode-connector/src/{task-tools,web-tools,browser-tools,perception-tools}.ts` | 9 个文件操作工具 + DuckDuckGo 搜索 + 7 个 Playwright 工具 + 4 个感知工具，路径沙箱 + 危险命令黑名单。**新增统一 ToolInvocationPipeline**（风险分级 → 注入扫描 → 路径沙箱 → 确认门 → dry-run → 审计） |
| 🎭 **聊天风格模仿** | `apps/vscode-connector/src/chat-profile.ts` | 自动收集对话双方消息，分析 emoji / 句长 / 常用开头结尾，注入 LLM 提示 |
| 🧩 **记忆智能提取** | `packages/runtime/src/memory/fact-extractor.ts` | 规则+LLM混合事实提取器，自动从对话中提取 location/preference/constraint/identity/goal 等用户事实，存入 long-term memory。替代硬编码关键词匹配 |
| 🪜 **多层级规划** | `packages/runtime/src/planning/hierarchical-planner.ts` | 双模式规划：simple（原生 ReAct）+ hierarchical（LLM 生成 milestones+steps）。支持 auto 模式根据任务复杂度自动选择 |
| 🔒 **安全沙箱** | `packages/runtime/src/permission/path-guard.ts` | 文件系统路径隔离，限制文件工具只能操作 projectDir/storageDir 内路径，阻止 `..` 穿越。集成到 ToolInvocationPipeline |
| 🔄 **工作流编排** | `packages/runtime/src/workflow/workflow.ts` | 声明式 WorkflowEngine，支持顺序/依赖排序/模板参数/条件分支/人工审批节点。YAML 格式定义 |
| 🌱 **在线学习自动调度** | `packages/runtime/src/evolution/scheduler.ts` | BackgroundScheduler 监听 AuditLogger 失败事件，达到阈值自动触发 EvolutionEngine + AutoDiscoveryEngine，候选人审后入库 |

### V2 待落地能力（[ROADMAP-V2-Capability-Gap.md](docs/ROADMAP-V2-Capability-Gap.md)）

| 能力 | 状态 | 说明 |
|---|---|---|
| 🔴 **G1 R7: V1 Coding Agent 接入 V2** | ✅ 已完成 | `packages/agents/coding-agent/` 支持 `impl` 委托，vscode-connector 工厂函数接入 chat-agent |
| 🟡 **G2 Runtime 占位清理** | ✅ 已完成 | 7 个 `index.ts` 改为 re-export shim |
| 🟡 **G3 CLI trace 子命令** | ✅ 已完成 | `z trace ls/show` 接入 Storage |
| 🟡 **G4 AssistantRuntime.boot()** | ✅ 已完成 | 替换 stub 为真实 Runtime 聚合 |
| ⚠️ **P1-1 多模态感知** | ✅ 已通过本地预处理替代 | 感知层已就绪 + chat-agent 附件预处理（OCR/caption/transcribe/parse），纯文本 LLM 可间接消费图像/音频/文档 |
| ✅ **P1-2 Human-in-the-Loop UI** | ✅ 已完成 | Confirmation 系统 + 风险分级 + 审计日志 + Dry-run + 防 prompt injection |
| ✅ **P1-3 Skill Auto-Discovery** | ✅ 已完成 | 失败提炼 + 验证 + 版本 + 审核 + 社区 + 自动调度 |
| 🧩 **记忆智能提取** | ✅ 已完成 | 规则+LLM混合事实提取器，替换硬编码偏好匹配 |
| 🪜 **多层级规划** | ✅ 已完成 | simple/hierarchical/auto 双模式规划 |
| 🔒 **安全沙箱** | ✅ 已完成 | 文件系统路径隔离（Sandbox Layer 1-2） |
| 🔄 **工作流编排** | ✅ 已完成 | 声明式 WorkflowEngine（顺序/依赖/条件/审批） |
| 🌱 **在线学习自动调度** | ✅ 已完成 | BackgroundScheduler 自动触发 evolution + skill-discovery |

### V1 ↔ V2 桥接

V1 ↔ V2 通过 **shim 文件**双向兼容，迁移期不破坏 V1 旧 import 路径：

```typescript
// V1 旧 import 路径：extensions/coding-agent/src/contracts/index.ts
export * from '@ziner/contracts';

// V1 旧 import 路径：extensions/coding-agent/src/trace/index.ts
export { Span, TraceManager, RunTracker, ... } from '@ziner/trace';
export { TraceInstrumentation, ... } from './trace-adapter';   // V1 类型适配

// V1 旧 import 路径：extensions/coding-agent/src/infra/storage/index.ts
export * from '@ziner/infra-storage';
// ... errors / cost / permission / config 同理
```

V1 `package.json` 显式声明 9 个 `@ziner/*` 依赖；`tsconfig.json` 通过 `references` 声明增量构建。

### V2 依赖图（单向，往下）

```
                  apps/desktop
                  apps/vscode-connector     ← V2 桥接 V1
                  apps/cli
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
  @ziner           @ziner        @ziner
    /runtime        /agent-coding  /agents/{research,office,browser}
        │                               │
        │   ┌─────────┐  ┌─────────┐    │
        ├──►│ memory  │  │knowledge│◄───┤
        │   └────┬────┘  └────┬────┘    │
        │        │            │          │
        │   ┌────▼────┐  ┌────▼────┐    │
        ├──►│ action  │  │perceptn │    │
        │   └────┬────┘  └────┬────┘    │
        │   ┌────▼────┐  ┌────▼────┐    │
        ├──►│orchestr.│  │ planning│    │
        │   │reflectn │  │ skills  │    │
        │   │ context │  │evaluatn │    │
        │   │evolution│  └────┬────┘    │
        │   └────┬────┘       │          │
        └────────┼────────────┘          │
                 │                       │
                 ▼                       ▼
            ┌──────────────────────────┐
            │ @ziner/infra/*           │
            │  + @ziner/contracts      │  (叶子)
            │  + @ziner/trace          │
            └──────────────────────────┘
```

依赖规则（强制）：
- `contracts` 是叶子，任何包可依赖
- `infra/*` 互相不依赖
- `trace` 不依赖 `runtime` 框架子包
- `runtime` 依赖 `trace` + `infra/*` + `contracts`
- `agents/*` 依赖 `runtime` + `contracts`
- `apps/*` 可依赖任何 `packages/*`
- ❌ `packages/*` → `apps/*` 禁止
- ❌ `packages/*` → `vscode` 禁止（CI grep 验证）

### V2 Desktop 应用

`apps/desktop/` 是真实可运行的 Electron 桌面应用，已成功打包出 `Ziner.exe`：

```
apps/desktop/
├── src/
│   ├── main.ts                 主进程（414 行，4 个 BrowserWindow + 30 个 IPC handler）
│   ├── preload.ts              contextBridge 桥接
│   ├── runtime-bridge.ts       V2 Runtime 桥接（336 行）
│   ├── session-manager.ts      会话 CRUD + JSON 持久化
│   ├── browser-service.ts      Browser Agent 封装
│   ├── tray.ts                 系统托盘
│   ├── hotkey.ts               全局快捷键（Ctrl+Shift+Z）
│   ├── updater.ts              electron-updater 封装
│   ├── license.ts              License Service（Free/Pro/Enterprise）
│   ├── constants.ts            IPC channel 常量
│   └── renderer/               渲染进程
│       ├── index.html          HTML shell + CSP
│       ├── index.ts            视图路由
│       ├── chat.ts             聊天面板（520 行，Markdown + 记忆召回）
│       ├── trace.ts            追踪面板（340 行，Span 树 + 导出）
│       ├── settings.ts         设置面板（470 行，7 个 LLM provider + IM 连接）
│       ├── memory.ts           记忆面板（221 行，6 种 kind 过滤）
│       ├── i18n.ts             国际化（zh-CN/en，~80 key）
│       └── styles.css          Warm Minimal Light 主题（1107 行）
└── build/
    └── electron-builder.json   打包配置（macOS dmg / Windows NSIS / Linux AppImage）
```

### V2 CLI 使用

```bash
# 构建后 / After build
node apps/cli/out/index.js version
# → @ziner/runtime v0.1.0

node apps/cli/out/index.js run "fix the failing test"
# → runId=run-...  （通过 VSCodeConnector 走通端到端路径）

node apps/cli/out/index.js trace ls
# → (stub) z trace ls: not implemented in Phase 6A  ← 待 G3 实现
```

### 已知遗留 / Known Legacy

- `packages/agents/coding-agent/` 全部业务方法是 stub（返回错误码 3001），等待 G1 R7 接入 V1
- `apps/vscode-connector` 的 `AssistantRuntime.boot()` 是 stub（返回 no-op runtime），等待 G4 替换
- `apps/cli` 的 `z trace ls/show` 子命令是 stub，等待 G3 实现
- `packages/runtime/src/{workflow,trace,errors,cost,budget,config,storage,permission}/index.ts` 是 8 个占位 `export {}`，等待 G2 改为 re-export shim
- P0 三件套（Memory / Desktop / Computer Use）已完成；P1 多模态感知半完成（感知层已就绪，LLM 多模态输入待扩展）；P1-2 HITL UI / P1-3 Skill Auto-Discovery 待推进

> **2026-06-22 更新**：以上遗留项已全部解决。G1-G4、P1-2、P1-3 均已落地。新增 7 项通用 agent 能力（记忆智能提取、多层级规划、安全沙箱、多模态附件预处理、工作流编排、在线学习自动调度、统一工具调用流水线）。

---

## 测试与对比 / Tests & Comparisons

- **Trae vs Ziner 图像拼接代码生成对比**：[coding-test/image-stitching-comparison.md](coding-test/image-stitching-comparison.md) — 分析相同 Prompt 下不同 Agent 的代码生成质量、正确性与可运行性差异

---

## 开发 / Development

### 环境要求 / Requirements

- Node.js 18+
- VS Code 1.85+
- TypeScript 5.3+
- Python 3.11+（V2 感知层 sidecar 打包需要）

### V1 扩展构建 / Build V1 Extension

```bash
cd extensions/coding-agent
npm install
npm run compile
# 按 F5 启动调试
```

### V2 Monorepo 构建 / Build V2 Monorepo

```bash
# 在仓库根 / Run from repo root
npm install                              # 装全部 workspace 依赖
npm run typecheck                        # 全部 V1 + V2 包 typecheck
npm test                                 # 全部 V1 + V2 包测试
npm run build --workspaces --if-present  # 全部 V1 + V2 包构建
npm run clean --workspaces --if-present  # 清理 out/ dist/

# 单包操作 / Per-package
npm test --workspace=@ziner/runtime
npm run build --workspace=@ziner/agent-browser
```

### V2 Desktop 一键打包 / Build Desktop App

```powershell
# 完整流水线：Python venv + TS 编译 + PyInstaller sidecar + electron-builder
.\build-all.ps1

# 跳过某些步骤
.\build-all.ps1 -SkipPython -SkipDesktop
.\build-all.ps1 -Clean

# 产物位置
# apps/desktop/dist/win-unpacked/Ziner.exe
# apps/desktop/dist/Ziner Setup x.x.x.exe
```

`build-all.ps1` 完成 6 步：Clean（可选）→ Python 环境（uv/conda/系统 python）→ TypeScript 构建（contracts/runtime/browser-agent/vscode-connector/desktop）→ Typecheck → Python sidecar 打包（PyInstaller → `perception-server.exe`）→ electron-builder 打包。

---

## 文档 / Documentation

| 文档 | 说明 |
|---|---|
| [AGENT_SPEC.md](file:///d:/mycode/Z%20Code/AGENT_SPEC.md) | V1 Coding Agent 构建规范（三层混合架构 + 完整流水线） |
| [docs/V2_VISION.md](file:///d:/mycode/Z%20Code/docs/V2_VISION.md) | V2 愿景（从 Single-Agent 升级为 Desktop AI Assistant Platform） |
| [docs/ROADMAP_V2_ASSISTANT_RUNTIME.md](file:///d:/mycode/Z%20Code/docs/ROADMAP_V2_ASSISTANT_RUNTIME.md) | V2 顶层 Roadmap |
| [docs/ROADMAP-V2-Capability-Gap.md](file:///d:/mycode/Z%20Code/docs/ROADMAP-V2-Capability-Gap.md) | V2 距离 marvis 的能力差距（含 2026-06-21 代码审计状态） |
| [docs/ADR-001-Architecture-Refactor-Revised.md](file:///d:/mycode/Z%20Code/docs/ADR-001-Architecture-Refactor-Revised.md) | V2 架构重构决策（Phase 6A） |
| [docs/ADRS/0007-runtime-decoupling.md](file:///d:/mycode/Z%20Code/docs/ADRS/0007-runtime-decoupling.md) | Runtime 解耦决策（Monorepo 建立） |
| [docs/SECURITY.md](file:///d:/mycode/Z%20Code/docs/SECURITY.md) | 安全策略（5 大目标 + STRIDE 威胁模型） |
| [docs/PHASE0_FOUNDATION.md](file:///d:/mycode/Z%20Code/docs/PHASE0_FOUNDATION.md) ~ [PHASE5_EVOLUTION.md](file:///d:/mycode/Z%20Code/docs/PHASE5_EVOLUTION.md) | Phase 0~5 演进路线（地基→Trace→TraceUI→MultiAgent→Harness→Eval→Evolution） |
| [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md) | V1 扩展详细文档（安装/配置/使用/更新日志） |

---

## 更新日志 / Changelog

### v2.0.0-alpha.6 — 2026-07-02

Ziner Mobile — Android 移动端正式发布

#### ✨ 版本摘要 / Highlights

- **📱 Android 移动端正式发布**：基于 Capacitor 6 + Vite 5 构建，与桌面端保持一致的 UI 和功能体验
- **🎨 Warm Minimal Light 主题**：移动端与桌面端统一的温暖极简浅色主题设计
- **💬 流式对话界面**：支持 Markdown 渲染、代码高亮、消息点击复制、新对话按钮
- **📚 多会话管理**：侧边栏查看历史会话，一键新建和切换对话
- **🧠 长期记忆面板**：查看 6 种记忆子系统存储的内容，支持 SQLite/JSONL 双后端
- **🔍 Trace 追踪面板**：实时查看 Agent 思考过程、工具调用、Span 树和耗时分析
- **⚙️ 完整设置中心**：模型配置（8 种 provider）/ MCP 服务 / 工具策略 / 记忆后端，与桌面端数据结构完全对齐
- **📤 配置导出/导入**：JSON 格式导出导入配置，手机电脑一键同步
- **🌐 双运行模式**：本地 Runtime（离线 Mock + 流式响应）/ 远程 Runtime（HTTP SSE 流式）
- **🔌 API 端点智能适配**：自动识别 OpenAI 兼容接口的路径格式（/v1、/v1/chat/completions 等）
- **📱 原生能力**：通知权限、振动、剪贴板、系统分享、平台信息检测

### v2.0.0-alpha.5 — 2026-06-22

Ziner V2 — 通用 Agent 能力全面升级

#### ✨ 版本摘要 / Highlights

- **🧩 记忆智能提取**：新增规则+LLM混合事实提取器（`fact-extractor.ts`），自动从对话中提取 location/preference/constraint/identity/goal 等用户事实，替代硬编码关键词匹配。用户说"我在上海"后，下次对话能 recall 到
- **🪜 多层级规划**：新增 `HierarchicalPlanner`，支持双模式规划（simple/hierarchical/auto）。复杂任务自动生成 milestones+steps 结构化计划
- **🔒 安全沙箱**：新增 `PathGuard`，限制文件工具只能操作 projectDir/storageDir 内路径，阻止 `..` 穿越。集成到 ToolInvocationPipeline
- **🎨 多模态附件预处理**：chat-agent 新增 `attachments` 选项，图片/音频/文档在发给 LLM 前经 perception 层做 OCR/caption/transcribe/parse，纯文本模型也能消费多模态输入
- **🔄 工作流编排**：新增声明式 `WorkflowEngine`，支持顺序/依赖排序/模板参数/条件分支/人工审批节点。YAML 格式定义
- **🌱 在线学习自动调度**：新增 `BackgroundScheduler`，监听 AuditLogger 失败事件，达到阈值自动触发 EvolutionEngine + AutoDiscoveryEngine，候选人审后入库
- **🔧 统一工具调用流水线**：新增 `ToolInvocationPipeline`，统一风险分级 → 注入扫描 → 路径沙箱 → 确认门 → dry-run → 审计。chat-agent 和 ChatToolRegistry 均已接入

### v2.0.0-alpha.4 — 2026-06-20

Ziner V2 — QQ OneBot 集成 + 微信/QQ 双协议自动回复

#### ✨ 版本摘要 / Highlights

- **💙 QQ 自动回复（NapCat + OneBot v11）**：新增 NapCat + OneBot WebSocket 协议支持，自动回复 QQ 好友私聊和群聊 @消息
- **💚 微信 Hook DLL 注入**：从 iLink Bot API 切换为 WeChatFerry DLL 注入，直接捕获微信收发的全部消息
- **🎭 聊天风格模仿（ChatProfile）**：新增风格分析模块，自动收集对话双方消息，分析说话风格并注入 LLM 提示
- **⚡ 任务队列**：新增消息队列机制，避免并发消息导致 "Run already active" 冲突
- **📊 状态推送**：完整的状态推送链路（Service → Connector → Bridge → IPC → Preload → UI）
- **🔧 打包修复**：修复 electron-builder asar 打包导致 WeChatFerry ESM 模块加载失败的问题

### v2.0.0-alpha.3 — 2026-06-19

Ziner V2 — 微信/QQ 自动回复 + Computer Use 桌面操控

#### ✨ 版本摘要 / Highlights

- **💬 WeChatFerry 微信自动回复**：通过 DLL 注入微信 Windows 客户端，自动回复指定联系人和群聊消息
- **🖥️ Computer Use 微信/QQ 操控**：通过截图 + OCR + 鼠标键盘模拟操控微信/QQ 窗口，零封号风险
- **🤖 Computer Use Service**：底层桌面自动化引擎，支持窗口检测（Win32 API）、OCR 识别、鼠标/键盘模拟、截图
- **🗑️ 移除 QQ 协议方案**：移除 icqq 和 LLOneBot 方案，QQ 统一使用 Computer Use 方式操控
- **📋 微信联系人/群聊可视化选择**：连接微信后自动显示联系人列表和群聊列表，支持搜索、全选/取消全选

### v2.0.0-alpha.2 — 2026-06-18

Ziner V2 — P0 三重能力落地 / P0 Triple Capabilities Landed

#### ✨ 版本摘要 / Highlights

- **📖 Long-Term Memory（P0-1）**：6 种记忆子系统完整实现（Short/Long/Episodic/Semantic/Procedural/Preferences）+ Knowledge 知识层（Project/User/Document）+ InMemoryVectorStore + 本地 n-gram embedding + JSONL 持久化 + 隐私遗忘（GDPR）+ 跨 Agent 共享
- **🖥️ Desktop 独立应用（P0-2）**：Electron 桌面端完整实现：Chat/Trace/Settings/Memory 四面板 + System Tray + Global Hotkey + Auto Update + License Service + 打包配置（macOS/Windows/Linux）
- **🤖 Computer Use（P0-3）**：Browser Agent（Playwright + DOM + 决策循环 + Session 持久化 + 元素高亮）+ GUI 自动化（Win/macOS/Linux 三平台）+ Screen 截图 + 安全策略（动作风险分级 + 危险 URL 拦截）

### v2.0.0-alpha.1 — 2026-06-18

Ziner V2 — Assistant Runtime 平台（Phase 6A 落地）

#### ✨ 版本摘要 / Highlights

- **Monorepo 重组**：仓库根升级为 npm workspaces，顶层目录变为 `extensions/coding-agent/`（V1）+ `packages/{contracts, infra/*, trace, runtime, agents/*}/`（V2）+ `apps/{cli, desktop, vscode-connector}/`
- **15 个 V2 包全部落地**：contracts + 5 个 infra + trace + runtime + 4 个 agents + 3 个 apps
- **V1 ↔ V2 桥接（shim 兼容）**：V1 端 5 个 `infra/*` + `contracts` + `trace` 全部留下单行 shim 文件，V1 旧 import 路径全部继续工作
- **TypeScript Project References**：V1 `tsconfig.json` 通过 `references` 声明对 8 个 V2 包的依赖
- **Orchestrator 框架**：通用多 Agent 协调（sequential/parallel/dag 三模式 + fail-fast + maxAgentCalls）
- **CLI 入口**：`apps/cli` 已有 argv 解析与子命令分发（`z run` / `z trace` / `z version` / `z help`）
- **VSCode Connector**：`apps/vscode-connector` 提供 `VSCodeConnector` 类

### v1.2.0 — 2026-06-15

AgentPipeline + EditTransaction / Unified Pipeline & Edit Transactions

- **AgentPipeline**：提取 AgentCore 和 AgentLoop 的共享前置分析流水线为独立模块，8 阶段按序执行
- **EditTransaction**：编辑事务化，多文件修改绑定统一事务 ID，支持快照捕获、冲突检测、按事务回滚，9 种事务状态
- **AgentLoop 修复**：通过 AgentPipeline 统一修复了 AgentLoop 的 3 处参数缺失问题

### v1.1.0 — 2026-06-12

Skill 系统升级 + Context Budget

- **Skill 系统完整升级**：结构化 frontmatter（description / mode / priority / triggers / imports / stop_if / verification）+ 7 信号加权软评分 + imports 递归展开 + 循环引用检测 + Skill Validator + 4 个调试命令
- **Context Budget**：统一预算管理，按来源限制字符数，优先级驱动裁剪
- **示例 Skill**：`typescript-quality`（strict 模式）、`llm-provider`（imports typescript-quality）

### v0.7.0 — 2026-06-09

Skill System 完整落地

- **Skill System（OpenClaw / Claude Code 兼容）**：新增 `.skills/**/SKILL.md` 自动发现、解析和注入系统
- **SkillLoader / SkillSelector / SkillManager**：递归扫描 + 关键词评分 + Top-K 选择 + 30 秒 TTL 缓存
- **与现有流水线兼容**：Skill Discovery 插入在 Discovery 之后、Task Understanding 之前

### v0.6.2 — 2026-06-09

Change Planning Layer 完整落地

- **Task Understanding**：意图分类（CREATE / MODIFY / REFACTOR / REPLACE / MIGRATE / ANALYZE）+ 约束提取
- **Architecture Review**：架构审查（拆函数/拆类/新增文件/更新引用检测）
- **Change Impact Analysis**：基于 SymbolIndex + DependencyGraph + RepoGraph 静态分析影响范围
- **条件触发 Reflection Agent**：Verify 通过时不触发反射，仅失败时调用

### v0.6.1 — 2026-06-08

稳定性增强与交互优化

- 对话重试 / 防跳过机制 / 工具参数兼容 / THINK-OBSERVE 简洁约束 / 文件删除感知 / 128K 上下文参数调优

### v0.6.0 — 2026-06-07

知识驱动 + 自我验证闭环

- **Discovery Phase** / **Symbol Retrieval + Context Expansion** / **Repo Knowledge Base** / **Knowledge-driven Agent** / **Reflection Loop** / **AgentLoop 状态扩展**（PLAN → EXECUTE → VERIFY → REFLECT → REPLAN）

### v0.5.1 — 2026-06-05

Web 搜索与会话导出

- `web_search` / `web_fetch` 工具（DuckDuckGo）+ 会话导出（Markdown / JSON）

### v0.5.0 — 2026-06-05

子系统全面落地

- LLM Query Rewrite / 局部编辑工具集 / Intent-Aware 动态混合检索 / ReAct Tool Loop / Runtime Verifier / Git Analyzer / 工具使用率分析器 / 检索质量调试器 / Agent Loop 调试器

### v0.4.0 — 2026-06-04

架构升级

- 缓存友好 Prompt 布局 / 结构化 To-Do List / Auto-Compact / 轻量/完整流程决策 / 128K 上下文 / 停止按钮 / Trae 风格思考过程 / 幻觉约束 / 危险命令拦截 / Diff 幂等性

### v0.3.0 — 2026-06-03

Chat 工作流升级

- 多会话 / Markdown 渲染 / 流式展示 / 自动应用修改 + Diff / Compact Mode / 稳定性修复

### 历史版本 / Previous Versions

- 旧版本的详细更新日志，请查看 [extensions/coding-agent/README.md](file:///d:/mycode/Z%20Code/extensions/coding-agent/README.md)

---

## 许可证 / License

MIT
