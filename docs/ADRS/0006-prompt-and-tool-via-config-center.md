# 0006. Prompt / Tool 禁止硬编码，必须经配置中心

- 状态：Accepted
- 日期：2026-06-17
- 决策人：@Z Assistant V2 架构组
- 影响阶段：Phase 0 / Phase 5

## 背景

V2 路线图里 Phase 5（Evolution）的核心能力是**自动改 Prompt / Tool / Skill**。
如果这些资产在代码里硬编码：
- 演化引擎无法读取、改写、回滚
- 同一 Prompt 多个版本无法共存
- A/B 测试无法实现

## 备选方案

- 方案 A：硬编码在源码（最简单）
- 方案 B：放在配置文件（YAML / JSON）
- 方案 C：配置中心 + 版本化 + 热加载（推荐）

## 决策

采用 **方案 C**：

- 所有 Prompt / Tool / Skill 描述必须从 `config-center` 加载
- 同一资产有多个 `PromptVersion`，按 `semver` 管理
- 配置中心支持热加载（重启进程或局部失效）
- 资产变更写入 `~/.z-assistant/assets/` 目录，Git 友好
- 代码内**禁止出现**完整 Prompt 文本（仅允许 placeholder）

## 后果

### 正面
- Evolution 引擎有标准接口读写
- A/B 测试可基于多版本
- 回滚简单（指定旧版本号）
- 审计清晰（谁、什么时候、改了什么）

### 负面 / 成本
- 新增 Prompt 需要走配置流程（略增成本）
- 开发者需要熟悉配置中心 API

### 缓解措施
- 提供 `pnpm z:prompt:add` 等脚手架命令
- 开发模式下允许 `local override` 覆盖配置
