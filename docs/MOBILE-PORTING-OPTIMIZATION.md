# Android 移植与跨平台优化规划

> 规划日期：2026-07-01
> 状态：进行中（Phase 1）

## 一、目标与范围

### 1.1 总体目标
将当前基于 Node.js/Electron 的 Ziner Agent 系统移植到 Android 平台，同时优化 Windows/桌面端的底层架构，实现真正的跨平台能力。

### 1.2 范围
- **跨平台优化**：Windows 端和 Android 端都能受益的底层优化（存储、性能、架构）
- **Android 专属**：Android 平台特有的适配工作（UI、权限、生命周期）
- **不在范围**：iOS 移植（后续规划）

---

## 二、Harness 八大组件状态

| 组件 | 桌面端状态 | Android 影响 | 优先级 |
|-----|-----------|-------------|--------|
| 系统提示词 | ✅ 完整 | 低（直接复用） | P3 |
| 工具调用 | ⚠️ 接口完整，实现为骨架 | 中（需移动端工具适配） | P2 |
| 文件系统 | ⚠️ 间接实现（沙箱） | 高（Scoped Storage 适配） | P1 |
| 沙箱环境 | ✅ Docker + Local | 高（Docker 不可用，需替代方案） | P1 |
| 编排逻辑 | ✅ 完整 | 中（需协程/后台调度适配） | P2 |
| 钩子中间件 | ✅ Pipeline 完整 | 低（逻辑可直接复用） | P3 |
| 反馈回路 | ✅ 框架完整 | 中（需后台任务调度） | P2 |
| 约束机制 | ✅ 完整 | 中（需 Android 权限模型适配） | P2 |

---

## 三、分阶段实施计划

### Phase 1：存储层重构（SQLite 替代 JSONL）
**目标**：用 SQLite 替代 JSONL 作为记忆存储后端，同时兼容 Windows 和 Android。

**为什么先做这个？**
- JSONL 在移动端性能差，全量加载内存压力大
- SQLite 是 Android 原生支持的数据库，Windows 端也能受益
- 这是所有后续优化的基础

**任务清单：**
- [x] 1.1 设计 SQLite 数据库 schema（记忆表、向量表、元数据表）
- [x] 1.2 实现 `SqliteMemoryProvider`，实现 `IMemoryProvider` 接口
- [x] 1.3 保留 `JsonlMemoryProvider` 作为向后兼容
- [x] 1.4 实现数据迁移工具（JSONL → SQLite）
- [x] 1.5 向量搜索：用 SQLite FTS5 + 余弦相似度计算替代独立向量库
- [x] 1.6 单元测试覆盖（33 个测试全部通过）
- [ ] 1.7 与现有 MemoryManager 集成，可配置切换后端

**验收标准：**
- 1000 条记忆的 recall 延迟 < 20ms（JSONL 当前约 400ms）
- 内存占用降低 60% 以上
- 所有现有记忆测试通过
- 数据迁移工具可正确导入历史数据

**技术选型：**
- Windows/Linux：`better-sqlite3`（同步 API，性能好）
- Android（未来）：SQLite + Room（Kotlin）
- 共享：SQL 逻辑和 schema 设计

---

### Phase 2：记忆系统性能优化
**目标**：优化记忆检索性能，适应移动端资源限制。

**任务清单：**
- [ ] 2.1 实现记忆分页加载（list/recall 都支持 offset/limit）
- [ ] 2.2 降低向量维度（可配置 384/768/1536）
- [ ] 2.3 实现 LRU + TTL 双层淘汰策略
- [ ] 2.4 查询嵌入缓存优化（当前已有，增强命中率）
- [ ] 2.5 记忆压缩/摘要机制（旧记忆自动压缩）

**验收标准：**
- 冷启动加载时间 < 500ms（10000 条记忆）
- 内存峰值 < 50MB（10000 条记忆）

---

### Phase 3：沙箱环境多后端支持
**目标**：抽象沙箱接口，支持多种后端实现。

**任务清单：**
- [ ] 3.1 完善 `SandboxExecutor` 接口（已定义，需增强）
- [ ] 3.2 沙箱能力探测（运行时检测可用的沙箱后端）
- [ ] 3.3 Android 端：应用沙箱 + WebView JS 执行
- [ ] 3.4 Windows 端：保留 Docker + Local 双后端
- [ ] 3.5 Benchmarks 服务端运行模式（移动端只展示结果）

**验收标准：**
- 同一套 Benchmark 测试在各平台都能运行
- 沙箱降级策略清晰（Docker → Local → 服务端）

---

### Phase 4：Orchestrator 移动端适配
**目标**：适配移动端的资源限制和生命周期。

**任务清单：**
- [ ] 4.1 任务优先级和后台调度
- [ ] 4.2 低内存/低电量时自动降级
- [ ] 4.3 任务持久化（App 被杀后可恢复）
- [ ] 4.4 流式输出的前后台切换处理

**验收标准：**
- 任务可在 App 退到后台后继续执行
- 系统内存不足时自动暂停非关键任务
- 任务中断后可从 checkpoint 恢复

---

### Phase 5：Android UI 适配
**目标**：移动端友好的用户界面。

**任务清单：**
- [ ] 5.1 底部导航栏（替代侧边栏）
- [ ] 5.2 聊天界面优化（气泡、语音输入、快捷回复）
- [ ] 5.3 Trace / Memory 面板改为二级页面
- [ ] 5.4 通知系统集成（任务完成提醒）
- [ ] 5.5 深色模式适配

---

### Phase 6：离线与弱网支持
**目标**：在网络不佳或无网络时仍能提供基础能力。

**任务清单：**
- [ ] 6.1 请求队列与自动重试
- [ ] 6.2 响应缓存（相同问题直接返回缓存结果）
- [ ] 6.3 小模型 on-device 推理（可选，ML Kit / ONNX）
- [ ] 6.4 离线记忆检索（完全本地，不依赖云端）

---

## 四、架构演进

### 当前架构（桌面端）
```
┌─────────────────────────────┐
│   Electron Renderer (UI)    │
├─────────────────────────────┤
│   IPC / Preload             │
├─────────────────────────────┤
│   Main Process (Node.js)    │
│  ┌───────────────────────┐  │
│  │  Orchestrator         │  │
│  │  Memory (JSONL)       │  │
│  │  Tools / Sandbox      │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

### 目标架构（跨平台）
```
┌─────────────────────────────────────────────┐
│  UI Layer                                    │
│  (Electron / Android Compose / iOS SwiftUI)  │
├─────────────────────────────────────────────┤
│  Platform Bridge                             │
│  (IPC / JNI / MethodChannel)                 │
├─────────────────────────────────────────────┤
│  Core Runtime (可移植层)                     │
│  ┌───────────────────────────────────────┐  │
│  │  Orchestrator                         │  │
│  │  Memory (SQLite 抽象层)               │  │
│  │  Skills / Reflection / Evolution      │  │
│  └───────────────────────────────────────┘  │
├─────────────────────────────────────────────┤
│  Platform Adapter                            │
│  (Windows / Linux / macOS / Android / iOS)  │
│  - SQLite 实现                               │
│  - 沙箱实现                                  │
│  - 网络/文件系统                              │
└─────────────────────────────────────────────┘
```

---

## 五、跨平台共享策略

### 可直接复用（逻辑层）
- Orchestrator 编排逻辑
- MemoryManager 记忆管理
- Skill 系统
- Evolution 进化引擎
- Reflection 反思框架
- ToolInvocationPipeline 权限管道

### 需要抽象适配（平台层）
- 存储后端（JSONL → SQLite 抽象）
- 沙箱后端（Docker / Local / Android 沙箱）
- LLM Provider（HTTP 客户端不同）
- 文件系统 API
- 通知系统

### 需要重写（UI 层）
- 界面布局与交互
- 导航系统
- 生命周期管理
- 权限请求

---

## 六、风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|-----|------|------|---------|
| SQLite 向量搜索性能不足 | 高 | 中 | 小数据量用内存向量库，大数据量用 FAISS |
| Android 后台执行限制 | 高 | 高 | WorkManager + Foreground Service |
| 移动端内存不足 | 中 | 高 | 分页加载 + LRU 淘汰 + 低内存降级 |
| 数据迁移丢失 | 高 | 低 | 迁移工具双写验证 + 备份机制 |

---

## 七、当前进度

- **Phase 1**：✅ 已完成（核心功能 + 测试 + 迁移工具）
  - [x] Schema 设计（memories 表 + FTS5 全文索引 + metadata 表）
  - [x] SqliteMemoryProvider 实现（IMemoryProvider 接口完整实现）
  - [x] 数据迁移工具（JSONL → SQLite，幂等、进度回调）
  - [x] 33 个单元测试全部通过
  - [ ] 与 MemoryManager / Desktop 集成（可配置切换后端）

- **Phase 2**：待开始
- **Phase 3**：待开始
- **Phase 4**：待开始
- **Phase 5**：待开始
- **Phase 6**：待开始

---

## 八、相关文档

- [ADR-0002: 存储策略](file:///d:/mycode/Z%20Code/docs/ADRS/0002-storage-strategy-sqlite-jsonl.md)
- [ADR-0005: Harness 沙箱](file:///d:/mycode/Z%20Code/docs/ADRS/0005-harness-requires-docker-sandbox.md)
- [项目规划](file:///d:/mycode/Z%20Code/docs/PROJECT-PLAN-DESKTOP.md)
