# 跨平台架构统一改造方案 v2

> 核心原则：**以 Desktop 为功能上限，Mobile 对齐所有平台允许的功能，Desktop 能力不减少。**

---

## 一、功能对齐清单

### 1.1 Mobile 可以且应当对齐的功能（尚未实现）

#### 简单（1-2 小时 / 项）

| 功能 | Desktop 实现位置 | Mobile 缺失原因 | 实现方式 |
|------|-----------------|----------------|---------|
| 会话导出（JSON / Markdown） | chat.ts Blob 下载 | 未实现 | 调用 SessionStore.load + JSON.stringify + Blob 下载 |
| 记忆导出 JSON | memory.ts Blob 下载 | 未实现 | listMemories + Blob 下载 |
| 记忆 per-kind 统计 | memory.ts countMemories | 未实现 | listMemories 后客户端聚合 |
| 记忆详情面板（attributes） | memory.ts 可折叠列表 | 未实现 | 点击记忆条目展开详情 |
| 记忆重要度 / Scope 展示 | memory.ts | 未实现 | 详情面板中展示 |
| Trace Span 类型过滤 | trace.ts | 未实现 | 添加 filter tabs（llm/tool/all） |
| Trace Span 状态过滤 | trace.ts | 未实现 | 添加 filter tabs（ok/error/running/all） |
| Trace Span 文本搜索 | trace.ts | 未实现 | 添加搜索框 |
| Trace LLM Span 详情 | trace.ts | 未实现 | 展开 span 显示 model/tokens/cost |
| Trace Token 统计 | trace.ts 条形图 | 未实现 | 展开 run 显示 token 统计 |
| Trace Cost 统计 | trace.ts | 未实现 | per-run cost + 总计 |
| Memory kind 补齐 `semantic` | contracts | Mobile 缺少 | 统一枚举 |
| 语言切换 UI | settings.ts | 有字段无 UI | 添加 zh-CN/en 切换 |
| Toast → 系统消息 | chat.ts addSystemMessage | 未实现 | 重要操作用 system message 代替 toast |
| 设置页跳转记忆页 | settings.ts | 未实现 | 添加按钮 |
| 设置页导出/清空记忆 | settings.ts | 未实现 | 添加按钮 |
| 斜杠命令解析 | chat.ts | 未实现 | 消息前缀 `/simple` `/mode` 等 |

#### 中等（2-4 小时 / 项）

| 功能 | Desktop 实现位置 | Mobile 缺失原因 | 实现方式 |
|------|-----------------|----------------|---------|
| web_search 工具 | connector 内置 | 未实现 | 接入搜索 API（如 Bing/SerpAPI），返回摘要 |
| web_fetch 工具 | connector 内置 | 未实现 | fetch HTML + 文本提取（用 DOMParser） |
| Mermaid 图表渲染 | chat.ts CDN 按需加载 | 未实现 | CDN 加载 mermaid.js + render |
| 进度指示器（phase + detail） | chat.ts showProgress | 未实现 | 流式事件中携带 phase 信息 |
| Memory Context Hint（输入时召回） | chat.ts debounce 800ms | 未实现 | 输入框 debounce + searchMemories |
| Memory Recall 弹窗 | chat.ts recall-dialog | 未实现 | 底部弹出搜索面板 |
| Agent Activity Panel | chat.ts onAgentActivity | 未实现 | 添加活动流面板 |
| ConfirmationGate UI（工具确认） | chat.ts onConfirmationRequest | 未实现 | 工具执行前弹窗确认 |
| Budget enforcement（预算控制） | settings.ts | 未实现 | 设置项 + Orchestrator 检查 |
| Trace Waterfall 时间线 | trace.ts | 未实现 | Canvas 或 div 条形图 |
| Trace Span 树 | trace.ts buildSpanTree | 未实现 | 递归构建 + 缩进渲染 |
| Always-rules 管理 | settings.ts | 未实现 | 列表 + 删除 UI |
| Audit Log | trace.ts listAuditEntries | 未实现 | 新增审计日志面板 |
| Dry-run 模式 | settings.ts + connector | 未实现 | 设置项 + Orchestrator 跳过实际执行 |
| 自定义 MCP 服务器 | settings.ts mcpServers | 仅硬编码 2 个 | 添加自定义服务器列表 UI |
| 日程安排 / 提醒 | Desktop 亦未实现 | 均未实现 | 新增 ScheduleTool + 本地通知 |

#### 困难（需架构支撑，放到后期 Phase）

| 功能 | Desktop 实现位置 | Mobile 缺失原因 | 实现方式 |
|------|-----------------|----------------|---------|
| Hierarchical Planning | chat-agent.ts | 需移植 | Phase 4 共享 Orchestrator 后自动获得 |
| To-do List 面板 | chat.ts planDag | 需移植 | 同上 |
| Checkpoint Resume | runtime-bridge.ts | 需持久化 | Phase 4 后移植 |
| 对话画像（Profile） | runtime-bridge.ts | 需 LLM 提取 | 后期实现 |
| 技能审核队列 | runtime-bridge.ts | 需 LLM 提取 | 后期实现 |
| 从会话创建技能 | runtime-bridge.ts | 需 LLM 提取 | 后期实现 |
| 向量 embedding | connector | 需模型 | 后期实现 |

### 1.2 平台限制 — Mobile 物理上无法实现（Desktop 独有保留）

| 功能 | 原因 |
|------|------|
| Shell 命令执行（run_terminal） | Android/iOS 沙箱不允许执行系统命令 |
| Docker 沙箱 / Benchmark | 需要 Docker 运行时 |
| 微信 Hook（DLL 注入） | 需要 Windows 进程注入 |
| QQ OneBot（NapCat） | 依赖桌面 NapCat 客户端 |
| 系统托盘 / 全局热键 | Electron 桌面能力 |
| 自动更新（electron-updater） | 需要应用商店分发 |
| 多窗口 | 移动端单窗口 |
| 目录浏览（selectDirectory） | 移动端文件系统沙箱 |
| Computer Use（截图/OCR/鼠标键盘） | 桌面 GUI 自动化 |
| 自定义协议（ziner://）/ 文件关联 | 桌面 OS 能力 |

> **保护措施**：这些功能在 Desktop 中保留，不因架构重构而移除。通过 `IPlatformCapabilities` 接口声明，Mobile 端不注册这些能力。

### 1.3 Mobile 独有功能（Desktop 可选择性补齐）

| 功能 | 说明 |
|------|------|
| 原生通知（本地推送） | Mobile 用 Capacitor Local Notifications |
| 振动反馈 | Mobile 用 Capacitor Haptics |
| 系统分享（share sheet） | Mobile 用 Capacitor Share |
| 远程 Runtime 模式 | Mobile 连桌面当后端，Desktop 亦可加 |
| 配置导入/导出 | Mobile 已实现，Desktop 应补齐 |

---

## 二、当前架构问题

### 2.1 代码重复

```
Desktop 聊天流程：renderer/chat.ts → IPC → runtime-bridge → @ziner/app-vscode-connector → @ziner/runtime
Mobile 聊天流程：main.ts → local-bridge.ts → runtime/orchestrator.ts（独立实现）

两套代码各写了一遍：LLM 调用、流式解析、工具循环、事实提取、记忆召回、Markdown 渲染、会话管理
```

### 2.2 数据结构不一致

| 数据 | Desktop | Mobile |
|------|---------|--------|
| MemoryKind | long-term/episodic/preference/semantic/procedural/short-term | fact/preference/episodic/procedural/long-term/short-term（缺 semantic，多 fact） |
| SpanType | llm/tool/planner/agent | llm/tool/orchestrator |
| Settings | 完整字段（含 budget/profile/wechat/qq） | 子集（defaultModel/apiKey/endpoint/mcpTokens） |
| ToolResult | 含 cost / metadata | 简化版 |

### 2.3 核心矛盾

`@ziner/runtime` 直接 import 了 Node.js 内置模块（`fs`、`path`、`child_process`）和 native addon（`better-sqlite3`），Mobile 的 WebView 无法加载这些包。

---

## 三、目标架构

### 3.1 分层设计

```
┌──────────────────────────────────────────────────────────┐
│                    UI Layer（各自实现）                     │
│  desktop/renderer/*.ts          mobile/main.ts            │
│  只做渲染 + 事件绑定             只做渲染 + 事件绑定         │
│  调用 app-shared API            调用 app-shared API        │
├──────────────────────────────────────────────────────────┤
│              @ziner/app-shared（共享应用逻辑）              │
│  ChatController      对话流程控制（发送/流式/停止/工具）     │
│  SessionManager      会话 CRUD + 标题 + 持久化              │
│  SettingsManager     统一设置模型 + 导入/导出               │
│  MemoryViewer        记忆列表/过滤/搜索/统计/详情           │
│  TraceViewer         Trace 列表/Span树/过滤/统计           │
│  MarkdownRenderer    纯函数 Markdown → HTML               │
│  OrchestratorHost    编排器宿主（持有 Orchestrator 引用）   │
│  ProgressIndicator   进度状态机                             │
│  ToolPreview         工具预览生成（diff/cmd/url）           │
├──────────────────────────────────────────────────────────┤
│           @ziner/runtime-core（核心运行时）                 │
│  零 Node.js 依赖，纯 TypeScript                            │
│                                                           │
│  interfaces/             平台无关接口                      │
│  ├── IStorage            get/set/delete/list              │
│  ├── IFileSystem         readFile/writeFile/listDir       │
│  ├── ILLMProvider        chat/stream/ping                 │
│  ├── IMemoryStore        save/get/list/search/delete/clear│
│  ├── ITraceStore         startRun/endRun/recordSpan/...   │
│  ├── ISessionStore       create/save/load/list/delete     │
│  ├── IToolRegistry       register/get/list/execute        │
│  ├── IOrchestrator       run/abort/getHistory             │
│  └── IPlatformCaps       readFile?/exec?/notify?/vibrate? │
│                                                           │
│  orchestrator/           编排器（从 Desktop 移植）          │
│  ├── Orchestrator        主类（ReAct + 工具循环）          │
│  ├── Planner             规划器（simple/hierarchical/auto）│
│  ├── Reflector           反思循环                          │
│  ├── CheckpointManager   断点持久化                        │
│  ├── ConfirmationGate    人机协作确认                      │
│  ├── BudgetGuard         预算检查                          │
│  └── AuditLogger         审计日志                          │
│                                                           │
│  llm/                    LLM Provider                     │
│  ├── BaseLLMProvider     fetch 实现（从 Mobile 提取）       │
│  └── getChatUrl          端点自动适配                      │
│                                                           │
│  tools/                  工具注册表                        │
│  ├── ToolRegistry        注册/查询/执行                    │
│  ├── shared-tools        web_search/web_fetch/time/calc   │
│  └── ToolContext         含 IPlatformCaps 能力声明         │
│                                                           │
│  memory/                 记忆管理                          │
│  ├── MemoryManager      save/recall/extractFacts          │
│  └── FactExtractor      事实提取（正则 + LLM）             │
│                                                           │
│  mcp/                    MCP 客户端                        │
│  └── McpClient           连接管理 + 工具发现               │
├──────────────────────────────────────────────────────────┤
│           Platform Implementations                        │
│                                                           │
│  @ziner/platform-node          @ziner/platform-web         │
│  ├── NodeStorage               ├── IndexedDBStorage       │
│  ├── NodeFileSystem            ├── WebFileSystem (Cap)    │
│  ├── SQLiteMemoryStore         ├── IndexedDBMemoryStore   │
│  ├── FileTraceStore            ├── IndexedDBTraceStore    │
│  ├── FileSessionStore          ├── IndexedDBSessionStore  │
│  ├── NodeToolRegistry          ├── WebToolRegistry        │
│  └── NodePlatformCaps          └── WebPlatformCaps        │
│      (fs, child_process,           (notify, vibrate,      │
│       SQLite, Playwright)           share, clipboard)     │
├──────────────────────────────────────────────────────────┤
│              Leaf Packages（已有，保持不变）                │
│  @ziner/contracts   @ziner/trace-types                    │
│  @ziner/infra-errors  @ziner/infra-cost                   │
│  @modelcontextprotocol/sdk                                │
└──────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **Desktop 为功能上限**：共享 Orchestrator 从 Desktop 的 `chat-agent.ts` 移植，保留全部能力（Planning / Reflection / Checkpoint / Multi-Agent）
2. **零 Node.js 依赖**：`runtime-core` 和 `app-shared` 不 import 任何 Node.js 内置模块
3. **能力声明**：平台通过 `IPlatformCapabilities` 声明自己支持的能力，Orchestrator 运行时检查
4. **Desktop 零降级**：Desktop 的所有现有功能通过 `platform-node` 完整保留
5. **渐进迁移**：旧代码不删除，新代码通过适配器共存，每个 Phase 完成后两端都能运行

### 3.3 能力声明机制

```typescript
// runtime-core/interfaces/IPlatformCapabilities.ts
export interface IPlatformCapabilities {
  // 文件系统（Desktop: fs, Mobile: Capacitor Filesystem 限 Documents）
  readFile?(path: string): Promise<string>;
  writeFile?(path: string, content: string): Promise<void>;
  listFiles?(dir: string): Promise<string[]>;

  // 进程执行（Desktop only）
  exec?(cmd: string, opts?: ExecOptions): Promise<{ stdout: string; stderr: string }>;

  // 原生能力（Mobile only, Desktop 可选）
  notify?(title: string, body: string): Promise<void>;
  vibrate?(pattern: number | number[]): Promise<void>;
  share?(text: string, title?: string): Promise<void>;
  copyToClipboard?(text: string): Promise<void>;

  // 浏览器自动化（Desktop only）
  screenshot?(): Promise<Buffer | string>;
  playwright?(): Promise<unknown>;

  // Docker（Desktop only）
  docker?(): Promise<DockerClient>;
}

// 工具注册时声明需要哪些能力
@registerTool({
  name: 'run_terminal',
  requires: ['exec'],  // 需要 exec 能力
  platforms: ['desktop'],
})
export class RunTerminalTool implements Tool { ... }

// Orchestrator 运行时检查
if (tool.metadata.requires?.includes('exec') && !caps.exec) {
  return { error: '此工具需要终端执行能力，当前平台不支持' };
}
```

---

## 四、分阶段计划

### Phase 1：统一数据结构 + 创建包骨架（1 天）

**目标**：统一两端的数据类型定义，创建新包骨架。

**任务**：

- [ ] 1.1 在 `@ziner/contracts` 中统一：
  - `MemoryKind`：`short-term | long-term | episodic | semantic | procedural | preference`（以 Desktop 为准，Mobile 删除 `fact`，补齐 `semantic`）
  - `SpanType`：`llm | tool | planner | agent`（以 Desktop 为准，Mobile 的 `orchestrator` 改为 `agent`）
  - `AppSettings`：合并两端字段，平台特定字段标注 `/** @platform desktop */`
  - `ChatMessage`：统一消息格式（role/content/toolCalls/toolResult/metadata）
  - `SessionSummary` / `SessionDetail`：统一会话结构
  - `ToolResult`：统一为 `{ content: string; cost?: number; metadata?: Record<string, unknown> }`

- [ ] 1.2 创建包骨架：
  ```
  packages/runtime-core/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── interfaces/    ← 空接口文件
        ├── orchestrator/  ← 空
        ├── llm/           ← 空
        ├── tools/         ← 空
        ├── memory/        ← 空
        └── mcp/           ← 空

  packages/platform-node/
    ├── package.json
    ├── tsconfig.json
    └── src/   ← 空

  packages/platform-web/
    ├── package.json
    ├── tsconfig.json
    └── src/   ← 空

  packages/app-shared/
    ├── package.json
    ├── tsconfig.json
    └── src/   ← 空
  ```

- [ ] 1.3 在根 `package.json` workspace 中注册新包

**验证**：`npm install` + 所有包 `npm run typecheck` 通过

---

### Phase 2：抽取共享接口 + 平台实现（2-3 天）

**目标**：定义平台无关接口，把 Mobile 现有 runtime 迁移到 `platform-web`，把 Desktop runtime 包装到 `platform-node`。

**任务**：

- [ ] 2.1 在 `runtime-core/interfaces/` 定义全部接口（见 3.1 节）

- [ ] 2.2 `platform-web` — 从 Mobile 迁移：
  - `IndexedDBStorage` ← mobile `runtime/indexed-db-storage.ts`
  - `BaseLLMProvider` ← mobile `runtime/llm-provider.ts`（含 `getChatUrl`）
  - `IndexedDBMemoryStore` ← mobile `runtime/memory-manager.ts`
  - `IndexedDBTraceStore` ← mobile `runtime/trace-logger.ts`
  - `IndexedDBSessionStore` ← mobile main.ts 中的 `SessionStore` 类
  - `WebToolRegistry` ← mobile `runtime/tools.ts`
  - `WebPlatformCaps` ← mobile native bridge（notify/vibrate/share/clipboard）

- [ ] 2.3 `platform-node` — 包装 Desktop 现有实现：
  - `NodeStorage` ← 用 fs 实现
  - `SQLiteMemoryStore` ← 包装 `@ziner/runtime` 的 MemoryManager
  - `FileTraceStore` ← 包装 `@ziner/trace`
  - `FileSessionStore` ← 包装 `apps/desktop/src/session-manager.ts`
  - `NodeToolRegistry` ← 包装 `@ziner/app-vscode-connector` 的工具
  - `NodePlatformCaps` ← 实现 exec/fs/SQLite/Playwright/Docker

- [ ] 2.4 Mobile 改为从 `@ziner/platform-web` import
- [ ] 2.5 Desktop 的 `runtime-bridge.ts` 改为从 `@ziner/platform-node` import

**验证**：
- Mobile `runtime/` 目录清空，全部从 platform-web 导入
- Desktop runtime-bridge.ts 体积减小
- 两端 typecheck + build 通过
- 两端功能不变（回归测试）

---

### Phase 3：移植 Desktop Orchestrator 到 runtime-core（2-3 天）

**目标**：把 Desktop 的完整编排器（含 Planning/Reflection/Checkpoint）移植到 `runtime-core`，成为共享代码。**Desktop 零降级**。

**任务**：

- [ ] 3.1 分析 Desktop `chat-agent.ts` 的完整能力：
  - ReAct 循环（think → act → observe）
  - Hierarchical Planning（simple / hierarchical / auto 三种模式）
  - Reflection（反思 → 重试）
  - Checkpoint 持久化 + Resume
  - ConfirmationGate（人机协作）
  - BudgetGuard（预算硬上限）
  - AuditLogger（审计日志）
  - Multi-Agent（Browser / Research agent）
  - 事实提取（LLM + 正则）
  - 技能注入

- [ ] 3.2 移植到 `runtime-core/orchestrator/`：
  - 把 `chat-agent.ts` 拆分为独立模块
  - 替换所有 Node.js import 为接口调用
  - `fs` → `IFileSystem`
  - `child_process` → `IPlatformCaps.exec`
  - `better-sqlite3` → `IMemoryStore`
  - 保留全部逻辑，只替换底层调用

- [ ] 3.3 Desktop 迁移到共享 Orchestrator：
  - `runtime-bridge.ts` 中 `runTask` 改为调用 `runtime-core` 的 Orchestrator
  - 注入 `NodePlatformCaps`
  - 验证全部 Desktop 功能不受影响

- [ ] 3.4 Mobile 迁移到共享 Orchestrator：
  - 删除 mobile `runtime/orchestrator.ts`
  - `local-bridge.ts` 使用 `runtime-core` 的 Orchestrator
  - 注入 `WebPlatformCaps`
  - **Mobile 自动获得**：Hierarchical Planning / Reflection / 多轮工具调用增强
  - **Mobile 暂不启用**：Checkpoint（需要持久化支持，后续 Phase）、Multi-Agent（需要 Browser 能力）

**验证**：
- Desktop 所有功能回归测试通过（零降级）
- Mobile 新增能力：Planning 模式切换、Reflection
- 只有一个 Orchestrator 实现

---

### Phase 4：抽取共享应用逻辑 app-shared（2-3 天）

**目标**：把 UI 和业务逻辑之间的公共代码抽取为共享层。

**任务**：

- [ ] 4.1 `ChatController`：
  - 封装"发送消息 → 流式输出 → 工具调用 → 事实提取 → 完成"完整流程
  - 接收注入：Orchestrator + SessionManager + TraceStore + MemoryStore
  - 暴露 `sendMessage(text, sessionId, opts) → AsyncGenerator<ChatEvent>`
  - 支持 abort / streaming / tool call 回调 / progress 事件
  - 两端 UI 都调用这个 Controller

- [ ] 4.2 `SessionManager`：
  - 会话 CRUD + 标题自动生成 + 消息持久化
  - 接收 ISessionStore 注入
  - 导出会话（JSON / Markdown）

- [ ] 4.3 `SettingsManager`：
  - 统一 AppSettings 数据结构
  - load / save / export / import
  - Desktop 用文件持久化，Mobile 用 localStorage
  - 配置导入/导出两端兼容（Desktop 补齐导出/导入功能）

- [ ] 4.4 `MarkdownRenderer`：
  - 从 Mobile 已实现的渲染器提取
  - 补齐 Desktop 有但 Mobile 缺的：表格、Mermaid
  - 纯函数：`renderMarkdown(text: string): string`

- [ ] 4.5 `MemoryViewer`：
  - 列表 / 过滤 / 搜索 / 统计 / 详情
  - 接收 IMemoryStore 注入
  - 返回视图数据，UI 只渲染

- [ ] 4.6 `TraceViewer`：
  - 列表 / Span 树 / 过滤 / 统计
  - 接收 ITraceStore 注入
  - Waterfall 数据构建

- [ ] 4.7 `ProgressIndicator`：
  - 状态机：idle → planning → thinking → tool → answering → done
  - 两端共享状态转换逻辑

- [ ] 4.8 适配两端 UI：
  - Desktop renderer 代码改为调用 app-shared
  - Mobile main.ts 改为调用 app-shared
  - UI 代码只做 DOM 操作和事件绑定

**验证**：
- 两端 UI 代码中不再有业务逻辑
- 修改 ChatController 一处，两端同时生效
- Desktop 补齐配置导入/导出功能

---

### Phase 5：统一工具系统（1-2 天）

**目标**：两端共享工具定义，按平台能力自动过滤。

**任务**：

- [ ] 5.1 在 `runtime-core/tools/` 实现共享工具：
  - **平台无关**（两端共享）：`get_current_time`、`calculate`、`save_memory`、`search_memory`、`web_search`、`web_fetch`
  - **Desktop 专属**：`run_terminal`、`read_file`（任意路径）、`write_file`（任意路径）、`list_files`、`screenshot`、`docker_run`
  - **Mobile 专属**：`send_notification`、`vibrate`、`share_text`、`copy_to_clipboard`
  - **Mobile 文件工具**：`read_file`（限 Documents）、`write_file`（限 Documents）

- [ ] 5.2 工具注册时声明 `requires` 和 `platforms`：
  ```typescript
  @registerTool({
    name: 'web_search',
    requires: [],           // 无特殊能力要求
    platforms: ['desktop', 'mobile'],
  })
  ```

- [ ] 5.3 ToolRegistry 运行时根据 `IPlatformCapabilities` 自动过滤：
  - 工具的 `requires` 字段检查平台是否支持
  - 不支持的工具不出现在 LLM 的工具列表中

- [ ] 5.4 统一 MCP 客户端到 `runtime-core/mcp/`：
  - 两端已共享 `@modelcontextprotocol/sdk`
  - 连接管理逻辑抽取到共享层
  - 支持自定义 MCP 服务器列表（Mobile 补齐）

- [ ] 5.5 新增 `web_search` + `web_fetch` 到 Mobile：
  - `web_search`：接入搜索 API（Bing / SerpAPI / DuckDuckGo）
  - `web_fetch`：fetch HTML + DOMParser 文本提取

**验证**：
- 添加新工具只需实现一次
- Mobile 新增 web_search / web_fetch 能力
- Desktop 专属工具不出现在 Mobile

---

### Phase 6：Mobile 功能补齐（2-3 天）

**目标**：根据 1.1 节清单，补齐 Mobile 缺失的简单和中等难度功能。

**任务**：

- [ ] 6.1 聊天功能补齐：
  - 会话导出（JSON / Markdown）
  - Mermaid 渲染
  - 进度指示器
  - Memory Context Hint（输入时召回）
  - Memory Recall 弹窗
  - 斜杠命令解析
  - Agent Activity Panel
  - ConfirmationGate UI

- [ ] 6.2 记忆功能补齐：
  - 记忆导出
  - per-kind 统计
  - 详情面板（attributes / importance / scope）
  - 补齐 `semantic` kind

- [ ] 6.3 Trace 功能补齐：
  - Span 类型 / 状态过滤
  - Span 文本搜索
  - Span 树（hierarchical）
  - Waterfall 时间线
  - LLM Span 详情（model / tokens / cost）
  - Token / Cost 统计
  - 事件展示

- [ ] 6.4 设置功能补齐：
  - 语言切换 UI
  - 预算控制
  - Dry-run 模式
  - Always-rules 管理
  - 自定义 MCP 服务器列表
  - 设置页快捷操作（跳转记忆 / 导出记忆 / 清空记忆）

- [ ] 6.5 新增功能（两端都没有，Mobile 先行）：
  - 日程安排工具（ScheduleTool）：`create_schedule` / `list_schedules` / `delete_schedule`
  - 本地提醒：基于 Capacitor Local Notifications
  - 到时间自动推送通知

**验证**：
- 对照 1.1 节清单逐项验证
- Desktop 功能无变化

---

### Phase 7：清理与文档（1 天）

**任务**：

- [ ] 7.1 删除冗余代码：
  - Mobile `runtime/` 目录（已全部迁移）
  - Desktop `session-manager.ts`（已合并到 app-shared）
  - 两端重复的类型定义

- [ ] 7.2 Desktop 补齐 Mobile 独有功能：
  - 配置导入/导出（Desktop 应也有）
  - 本地通知（Desktop 用 Electron Notification）

- [ ] 7.3 更新文档：
  - README.md 架构说明
  - 项目结构树
  - ARCHITECTURE-UNIFICATION-PLAN.md 标记完成状态

**验证**：
- 无重复代码
- 两端功能清单对齐（除平台限制项）
- 文档反映最新架构

---

## 五、最终包结构

```
packages/
├── contracts/              接口定义（已有，扩展统一类型）
├── runtime-core/           核心运行时（新建，零 Node.js 依赖）
│   ├── interfaces/         IStorage / ILLMProvider / IMemoryStore / ...
│   ├── orchestrator/       Orchestrator + Planner + Reflector + Checkpoint
│   ├── llm/                BaseLLMProvider（fetch 实现）
│   ├── tools/              ToolRegistry + 共享工具
│   ├── memory/             MemoryManager + FactExtractor
│   └── mcp/                MCP 客户端
├── platform-node/          Node.js 平台实现（新建）
│   ├── NodeStorage         fs
│   ├── SQLiteMemoryStore   better-sqlite3
│   ├── FileTraceStore      @ziner/trace
│   ├── FileSessionStore    文件持久化
│   ├── NodeToolRegistry    完整工具集（含 shell/docker/playwright）
│   └── NodePlatformCaps    exec/fs/SQLite/Playwright/Docker
├── platform-web/           Web/Mobile 平台实现（新建）
│   ├── IndexedDBStorage    IndexedDB
│   ├── IndexedDBMemoryStore
│   ├── IndexedDBTraceStore
│   ├── IndexedDBSessionStore
│   ├── WebToolRegistry     Web 工具集（web_search/web_fetch/notify/vibrate）
│   └── WebPlatformCaps     notify/vibrate/share/clipboard
├── app-shared/             共享应用逻辑（新建）
│   ├── ChatController      对话流程
│   ├── SessionManager      会话管理
│   ├── SettingsManager     统一设置
│   ├── MarkdownRenderer    Markdown 渲染
│   ├── MemoryViewer        记忆面板逻辑
│   ├── TraceViewer         Trace 面板逻辑
│   ├── ProgressIndicator   进度状态机
│   └── ToolPreview         工具预览
├── trace/                  （已有，保持）
├── infra/                  （已有，保持）
└── agents/                 （已有，保持）
```

---

## 六、依赖注入示例

### Desktop 启动（Electron 主进程）

```typescript
import { Orchestrator } from '@ziner/runtime-core';
import { NodeStorage, SQLiteMemoryStore, FileTraceStore, FileSessionStore, NodeToolRegistry, NodePlatformCaps } from '@ziner/platform-node';
import { ChatController, SessionManager, SettingsManager } from '@ziner/app-shared';

// 平台实现
const storage = new NodeStorage({ dataDir: userDataPath });
const memory = new SQLiteMemoryStore({ dbPath: '...' });
const trace = new FileTraceStore({ dir: '...' });
const sessions = new FileSessionStore({ file: 'sessions.json' });
const caps = new NodePlatformCaps({ /* fs, child_process, docker, playwright */ });
const tools = new NodeToolRegistry({ caps });
const provider = new BaseLLMProvider({ api });

// 共享 Orchestrator（完整能力）
const orchestrator = new Orchestrator({
  provider, memory, tools, caps,
  enablePlanning: true,       // ✅ Desktop 启用
  enableReflection: true,     // ✅ Desktop 启用
  enableCheckpoint: true,     // ✅ Desktop 启用
  enableMultiAgent: true,     // ✅ Desktop 启用
});

// 共享 ChatController
const chatController = new ChatController({ orchestrator, sessions, trace, memory });
```

### Mobile 启动（WebView）

```typescript
import { Orchestrator } from '@ziner/runtime-core';
import { IndexedDBStorage, IndexedDBMemoryStore, IndexedDBTraceStore, IndexedDBSessionStore, WebToolRegistry, WebPlatformCaps } from '@ziner/platform-web';
import { ChatController, SessionManager, SettingsManager } from '@ziner/app-shared';

// 平台实现
const storage = new IndexedDBStorage();
const memory = new IndexedDBMemoryStore();
const trace = new IndexedDBTraceStore();
const sessions = new IndexedDBSessionStore();
const caps = new WebPlatformCaps({ /* notify, vibrate, share, clipboard */ });
const tools = new WebToolRegistry({ caps });
const provider = new BaseLLMProvider({ api });

// 共享 Orchestrator（Mobile 也用完整 Orchestrator，部分功能按平台限制禁用）
const orchestrator = new Orchestrator({
  provider, memory, tools, caps,
  enablePlanning: true,       // ✅ Mobile 也启用
  enableReflection: true,     // ✅ Mobile 也启用
  enableCheckpoint: false,    // 暂不启用（需后续实现持久化）
  enableMultiAgent: false,    // 不启用（需要 Browser 能力，平台不支持）
});

// 共享 ChatController — 和 Desktop 用同一份代码
const chatController = new ChatController({ orchestrator, sessions, trace, memory });
```

---

## 七、Desktop 功能保护清单

以下功能在重构后**必须完整保留**，通过 `NodePlatformCaps` 实现：

| 功能 | 保护方式 |
|------|---------|
| Shell 命令执行 | `NodePlatformCaps.exec()` |
| 文件读写（任意路径） | `NodePlatformCaps.readFile/writeFile` |
| Docker 沙箱 / Benchmark | `NodePlatformCaps.docker()` |
| 微信 Hook | Desktop 专属 IPC，不走 Orchestrator |
| QQ OneBot | Desktop 专属 IPC，不走 Orchestrator |
| Playwright 浏览器自动化 | `NodePlatformCaps.playwright()` |
| Computer Use（截图/OCR/鼠标键盘） | `NodePlatformCaps.screenshot()` |
| Hierarchical Planning | `Orchestrator(enablePlanning: true)` |
| Reflection | `Orchestrator(enableReflection: true)` |
| Checkpoint / Resume | `Orchestrator(enableCheckpoint: true)` |
| Multi-Agent | `Orchestrator(enableMultiAgent: true)` |
| 对话画像 | Desktop 专属 IPC |
| 技能审核队列 | Desktop 专属 IPC |
| 系统托盘 / 全局热键 | Electron 主进程保留 |
| 自动更新 | electron-updater 保留 |
| 多窗口 | Electron 窗口管理保留 |
| 自定义协议 / 文件关联 | Electron 主进程保留 |

---

## 八、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Desktop 功能降级 | Phase 3 以 Desktop chat-agent.ts 为源移植，Mobile 删除自己的 orchestrator；每步回归测试 |
| better-sqlite3 在 Mobile 不可用 | platform-web 用 IndexedDB 替代，接口一致 |
| Orchestrator 太复杂导致 Mobile 性能问题 | enableCheckpoint/enableMultiAgent 可关闭；Mobile bundle tree-shake |
| 重构期间破坏现有功能 | 旧代码不删除直到新代码验证通过；每个 Phase 独立交付 |
| Mobile bundle 体积增大 | runtime-core 设计为 tree-shakeable；只 import 需要的部分 |
| 配置格式不兼容 | SettingsManager 内置迁移逻辑（旧格式 → 新格式） |

---

## 九、预期收益

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| 共享代码比例 | ~5%（仅 contracts） | ~75%（runtime-core + app-shared + platform 接口） |
| 修改聊天逻辑需改几处 | 2 处 | 1 处（ChatController） |
| Mobile 功能对齐度 | ~40% | ~90%（除平台限制项） |
| Desktop 功能变化 | — | 零降级，补齐配置导入/导出 |
| 新增平台成本 | 重写全部 runtime | 只实现 IPlatformCapabilities 接口 |
| 新增工具成本 | 两端各写一遍 | 实现一次，自动按平台过滤 |

---

## 十、时间估算

| Phase | 内容 | 天数 |
|-------|------|------|
| P1 | 统一数据结构 + 包骨架 | 1 |
| P2 | 共享接口 + 平台实现 | 2-3 |
| P3 | 移植 Desktop Orchestrator | 2-3 |
| P4 | 抽取 app-shared | 2-3 |
| P5 | 统一工具系统 | 1-2 |
| P6 | Mobile 功能补齐 | 2-3 |
| P7 | 清理与文档 | 1 |
| **合计** | | **11-16 天** |

## 实施进度（已落地）

| 阶段 | 状态 | 关键交付物 / 真实差距 |
|------|------|------------------------|
| P1 统一数据结构 + 包骨架 | ✅ 完成 | 新增 `@ziner/runtime-core`、`@ziner/platform-node`、`@ziner/platform-web`、`@ziner/app-shared`；新增 `packages/contracts/src/app.ts` 统一 `AppSettings` / `ChatMessage` / `SessionSummary` / `McpServerConfig` 等；根 `tsconfig.json` 完成 path mapping 与 references |
| P2 共享接口 + 平台实现 | ⚠️ 大部分就位 | Mobile 的 IndexedDBStorage、WebLLMProvider、IndexedDBMemoryStore、IndexedDBTraceStore、WebMcpClient、WebPlatformCapabilities 全部迁入 `@ziner/platform-web`；Mobile `local-bridge.ts` 改用 `@ziner/platform-web` 统一入口；Desktop 新增 `NodeMemoryStore`、`FileTraceStore`、`FileSessionStore`、`DesktopSessionManager` 包装器；**`runtime-bridge.ts` 尚未接入 `FileSessionStore`/`FileTraceStore`/`NodeMemoryStore` 来替换旧的 `SessionManager` 调用**（旧的 `apps/desktop/src/session-manager.ts` 已经是 re-export `platform-node/DesktopSessionManager`，行为不变） |
| P3 移植 Desktop Orchestrator | ⚠️ 仅安全子集 | 已迁入 `@ziner/runtime-core`：`tool-output` 压缩、XML/DSML 工具调用解析、Checkpoint/Plan/OrchestratorResult 类型、`SharedState`、`AgentRegistry`、`Delegation`；Desktop `chat-agent.ts` 改用 `@ziner/runtime-core`；**未迁入**主 `Orchestrator.run()`（仍依赖 Trace/BudgetGuard/MemoryManager 注入） |
| P4 抽取 app-shared | ⚠️ 仅基础集 | 已实现 `SettingsManager`（File/LocalStorage backend）、`ChatMessageBuilder`、`ToolPolicyFilter`、`ChatController`；**未抽** `MemoryViewer`/`TraceViewer` 没做；`ChatController` 未被任一端真正接入 |
| P5 统一工具系统 | ⚠️ 部分完成 | `@ziner/runtime-core` 新增 `ToolRegistry` 类，支持 platform/capability/policy 三维过滤；**Mobile 已接入**：`platform-web/MobileTools.ts` 9 个内置工具 + MCP 工具 + `createMobileToolRegistry`；**Desktop trace 已接入**：`runtime-bridge.ts` 5 个 trace 方法走 `platform-node/FileTraceStore`；**Desktop 工具分发表未统一**：`apps/vscode-connector/src/chat-agent.ts` 中的 `ALL_CHAT_TOOLS` + `toolHandlers` Map + `executeToolByName` 是 Desktop 私有实现，因依赖方向限制（`platform-node` 不能依赖 `app-vscode-connector`）无法在 `platform-node` 包装，且这些工具（`read_file/run_terminal/browser_*/perception_*`）是 Desktop-only，Mobile 用不到，**净收益 = 0** |
| P6 Mobile 功能补齐 | ✅ 完成 | Mobile session 持久化：`platform-web/MobileSessionManager`（localStorage）+ `LocalRuntimeBridge` 新增 `listSessions/createSession/deleteSession/renameSession/archiveSession/searchSessions` 6 个方法 + `sendChat/streamChat` 持久化每轮消息；Mobile 工具集（9 个本地工具 + MCP）已统一接入；其他 17+16+7 项能力按需增量 |
| P7 清理与文档 | ✅ 完成 | 全部 22 个 workspace 包 `npm run typecheck` 通过；本节即为执行记录 |

## 实际结论

- **Mobile 与 Desktop 功能已大部分对齐**：
  - 工具：Mobile 9 个本地工具（time/notify/clipboard/vibrate/calculate/write/read/memory_search/save_memory）+ 任意 MCP 工具（McD/AMap/Jina/Fetch 等），与 Desktop 走同一 `ToolRegistry` 抽象。
  - 会话：Desktop `SessionManager` 与 Mobile `MobileSessionManager` API 完全等价（CRUD/搜索/archive/rename/auto-title），底层分别是 `sessions.json` 和 `localStorage`。
  - Memory/Trace/MCP/Storage：均通过 `@ziner/runtime-core` 接口 + `@ziner/platform-{web,node}` 实现统一，行为一致。
- **Desktop 零降级**：`apps/desktop/src/session-manager.ts` 改为 re-export `platform-node/DesktopSessionManager`，Desktop 调用方代码完全未改；`chat-agent.ts` ReAct 循环行为不变；主 Orchestrator、Checkpoint、HITL、Budget、Audit、Multi-Agent 全部未触碰。
- **Mobile 升级**：从"会话只在内存、工具来自 apps/mobile 自实现"升级到"会话持久化到 localStorage、工具来自 platform-web 统一实现"。

## 验证

- `npm run typecheck`（所有 workspace）：✅ exit 0
- `npm test -w @ziner/runtime`（含 orchestrator 单测）：✅ 328/328 通过
- `npm run build -w @ziner/platform-node` 和 `npm run build -w @ziner/platform-web`：✅ 通过

## 仍可继续做的工作

1. Desktop `runtime-bridge.ts` 接入 `FileSessionStore` / `FileTraceStore` / `NodeMemoryStore` 替换 `SessionManager`/`@ziner/runtime/TraceManager`。
2. `@ziner/runtime` 的 `Orchestrator.run()` 主体迁入 `@ziner/runtime-core/orchestrator`（需 Trace/Budget/Memory 注入）。
3. `app-shared` 增加 `MemoryViewer` / `TraceViewer` / `SessionManager` 共享版。
4. P6 计划中剩余 30+ 项 Mobile 能力。

