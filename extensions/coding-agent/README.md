# Coding Agent - VS Code Extension

> AI 编程助手 VS Code 扩展 — 基于多后端 LLM，三层混合架构  
> AI Coding Assistant for VS Code — Multi-Backend LLM, Three-Layer Hybrid Architecture

支持 **SGLang**（本地推理）、**OpenAI**、**Deepseek**、**小米 MiMo** 等多种模型，提供类似 Cursor/Trae 的编程体验。  
Supports **SGLang** (local inference), **OpenAI**, **Deepseek**, **Xiaomi MiMo** and more, delivering a Cursor/Trae-like coding experience.

采用 **三层混合架构**：宏观 Plan-and-Execute + 微观 ReAct + 自动化验证 + 兜底 Reflection。  
Built on a **Three-Layer Hybrid Architecture**: Macro Planner → Micro ReAct → Auto Verifier → Meta Reflection.

## 特性 / Features

- 🤖 **Chat 侧边栏** - 智能代码问答，流式响应，类 Trae 侧边栏体验
- 🎼 **Composer** - 多文件批量编辑
- ⚡ **Tab 补全** - 基于 FIM 的智能代码补全
- ✏️ **行内编辑** - 选中代码直接修改
- 🔧 **多配置管理** - 保存多个 LLM 配置，一键切换
- 🌐 **多后端支持** - SGLang / OpenAI / Deepseek / 小米 MiMo
- 📚 **Code Index** - LSP 符号索引，按名称和类型搜索类/函数/接口
- ✅ **Verifier** - 子任务完成后自动运行 tsc --noEmit / eslint / npm test
- 🔍 **LSP 工具链** - 跳转定义、查找引用、关联文件发现

## 支持的后端 / Supported Backends

| 提供商 | 说明 | 需要 API Key |
|--------|------|-------------|
| **SGLang** | 本地高性能推理 | ❌ |
| **OpenAI** | GPT-4 / GPT-3.5 | ✅ |
| **Deepseek** | 国产大模型 | ✅ |
| **小米 MiMo** | 小米大模型 | ✅ |

## 安装 / Installation

### 方式 1：安装 .vsix 文件（推荐 / Recommended）

1. **获取扩展包**
   - 运行 `.\tools\update.ps1` 或获取 `coding-agent-*.vsix` 文件

2. **在 VS Code 中安装**
   - 打开 VS Code
   - 按 `Ctrl+Shift+X` 打开扩展面板
   - 点击右上角的 `...`（更多操作）
   - 选择 `Install from VSIX`
   - 选择生成的 `.vsix` 文件

3. **验证安装**
   - 扩展列表中应出现 "Coding Agent"
   - 左侧活动栏出现 Coding Agent 图标（□）

### 方式 2：开发者模式 / Dev Mode

```bash
# 1. 进入扩展目录
cd extensions/coding-agent

# 2. 安装依赖
npm install

# 3. 编译
npm run compile

# 4. 按 F5 启动调试
```

## 快速开始 / Quick Start

1. **按 `Ctrl+Shift+P` → `Coding Agent: 添加配置`**
2. 按照向导配置你的 LLM（SGLang 本地 / Deepseek / OpenAI 等）
3. **点击左侧活动栏的 Coding Agent 图标** 打开侧边聊天栏
4. 在底部输入框输入你的问题

## 配置 / Configuration

### 多配置管理 / Multi-Config Management

Coding Agent 支持保存多个 LLM 配置，方便在不同场景下快速切换。

**默认配置：**

| 配置名称 | 提供商 | 端点 | 模型 |
|---------|--------|------|------|
| SGLang 本地 | sglang | http://localhost:30000 | default |
| OpenAI GPT-4 | openai | https://api.openai.com | gpt-4 |
| Deepseek V4 | deepseek | https://api.deepseek.com | deepseek-v4-flash |
| 小米 MiMo V2 Flash | mimo | https://api.xiaomimimo.com | mimo-v2-flash |

### 配置管理命令 / Config Commands

| 命令 | 功能 |
|------|------|
| `Coding Agent: 添加配置` | 添加新 LLM 配置 |
| `Coding Agent: 切换配置` | 切换当前使用的配置 |
| `Coding Agent: 编辑配置` | 编辑已有配置 |
| `Coding Agent: 删除配置` | 删除配置 |

### 添加自定义配置 / Adding Custom Config

1. `Ctrl+Shift+P` → `Coding Agent: 添加配置`
2. 输入配置名称，例如：`DS V4`
3. 选择提供商：`Deepseek`
4. 填写 API 服务地址：`https://api.deepseek.com`（注意不要填 API Key 到地址栏）
5. 填写 API Key：`sk-xxxxx`（密钥，不是服务地址）
6. 选择模型：`deepseek-v4-flash`
7. 确认是否立即激活

### 各提供商配置示例 / Provider Config Examples

**SGLang (本地部署):**
```json
{
  "codingAgent.llm.provider": "sglang",
  "codingAgent.llm.endpoint": "http://localhost:30000",
  "codingAgent.llm.model": "default"
}
```

**OpenAI API:**
```json
{
  "codingAgent.llm.provider": "openai",
  "codingAgent.llm.endpoint": "https://api.openai.com",
  "codingAgent.llm.apiKey": "sk-your-api-key",
  "codingAgent.llm.model": "gpt-4"
}
```

**Deepseek:**
```json
{
  "codingAgent.llm.provider": "deepseek",
  "codingAgent.llm.endpoint": "https://api.deepseek.com",
  "codingAgent.llm.apiKey": "sk-your-api-key",
  "codingAgent.llm.model": "deepseek-v4-flash"
}
```

**小米 MiMo:**
```json
{
  "codingAgent.llm.provider": "mimo",
  "codingAgent.llm.endpoint": "https://api.xiaomimimo.com",
  "codingAgent.llm.apiKey": "your-mimo-api-key",
  "codingAgent.llm.model": "mimo-v2-flash"
}
```

### 高级设置 / Advanced Settings

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `codingAgent.llm.maxTokens` | `4096` | 最大生成 Token 数 |
| `codingAgent.llm.temperature` | `0.1` | 采样温度 (0-1) |
| `codingAgent.enableTabCompletion` | `true` | 启用 Tab 补全 |
| `codingAgent.tabCompletionDebounce` | `300` | 补全防抖时间(ms) |

## 使用指南 / Usage Guide

### 快捷键 / Shortcuts

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+L` | 打开 Chat 输出面板（历史记录） |
| `Ctrl+Shift+I` | 弹出输入框发送消息 |
| `Ctrl+Shift+O` | 打开 Composer 面板 |
| `Ctrl+K Ctrl+I` | 行内编辑（需要选中代码） |
| `Tab` | 接受代码补全 |

### Chat 侧边栏 / Sidebar Chat

1. **点击左侧活动栏的 Coding Agent 图标** 打开侧边栏
2. 侧边栏顶部显示当前模型名称，**点击可切换配置**
3. 在底部输入框输入问题，`Enter` 发送，`Shift+Enter` 换行
4. 或者按 `Ctrl+Shift+I` 使用全局快捷键弹出输入框
5. 对话历史自动保存，关闭侧边栏后重新打开不会丢失

**示例问题：**
   - "解释这段代码"
   - "找出潜在的 Bug"
   - "帮我写一个排序函数"

### Composer 多文件编辑 / Multi-file Editing

1. 按 `Ctrl+Shift+O` 打开
2. 添加相关的上下文文件
3. 描述你的需求，例如：
   - "将所有 console.log 替换为 logger.info"
   - "重构这个模块，提取公共逻辑"
4. 查看并应用生成的编辑计划

### 行内编辑 / Inline Editing

1. 选中要修改的代码
2. 按 `Ctrl+K Ctrl+I`
3. 输入指令，例如：
   - "Add error handling"
   - "Convert to arrow function"
   - "Add TypeScript types"
4. 代码自动替换

### Tab 补全 / Tab Completion

1. 在编辑器中输入代码
2. 等待灰色提示出现
3. 按 `Tab` 接受补全
4. 继续输入或按 `Esc` 取消

## 更新扩展 / Updating

### 方式 1：使用更新脚本（推荐 / Recommended）

```powershell
# 运行更新脚本
powershell -ExecutionPolicy Bypass -File "D:\mycode\Z Code\tools\update.ps1"
```

脚本会自动：
1. 清理旧构建
2. 编译 TypeScript
3. 更新版本号（可选）
4. 打包生成新的 .vsix
5. 自动安装到 VS Code（可选）

### 方式 2：手动更新 / Manual Update

```bash
# 1. 编译
cd extensions/coding-agent
npm run compile

# 2. 打包
vsce package

# 3. 在 VS Code 中重新安装
# Ctrl+Shift+X → ... → Install from VSIX
```

## 项目结构 / Project Structure

```
extensions/coding-agent/
├── media/
│   └── icon.svg                      # 侧边栏活动栏图标
├── src/
│   ├── agent/
│   │   ├── agent-core.ts             # 三层混合架构 Agent Core
│   │   │                            (Planner → ReAct → Verifier → Reflector)
│   │   └── verifier.ts               # 自动化验证（tsc --noEmit / eslint / npm test）
│   ├── config/
│   │   └── config-manager.ts         # 多配置管理（globalState 存储）
│   ├── llm/
│   │   └── llm-provider.ts           # 统一 LLM 接口
│   ├── context/
│   │   ├── context-manager.ts        # LSP 上下文管理
│   │   ├── symbolIndex.ts            # 符号索引
│   │   ├── retrieval.ts              # 代码检索
│   │   └── workspaceScanner.ts       # 工作区扫描
│   ├── tools/
│   │   └── tool-registry.ts          # 工具系统（含 LSP 工具链）
│   ├── panels/
│   │   ├── chat-view-provider.ts     # 侧边栏 Chat（WebviewView）
│   │   ├── chat-panel.ts             # OutputChannel 版本 Chat
│   │   └── composer-panel.ts         # Composer 面板
│   ├── inline/
│   │   └── inline-completion.ts      # Tab 补全和行内编辑
│   ├── utils/
│   │   └── diff-engine.ts            # Diff 引擎
│   └── extension.ts                  # 扩展入口
├── package.json
├── tsconfig.json
└── README.md                         # 本文件
```

## 开发 / Development

### 环境要求 / Requirements

- Node.js 18+
- VS Code 1.85+
- TypeScript 5.3+

### 构建脚本 / Build Scripts

| 脚本 | 命令 | 说明 |
|------|------|------|
| 编译 | `npm run compile` | 编译 TypeScript |
| 监听 | `npm run watch` | 监听模式编译 |
| 打包 | `vsce package` | 生成 .vsix 文件 |

### 调试

1. 在 VS Code 中打开项目
2. 按 `F5` 启动调试
3. 在新窗口中测试扩展

---

## 更新日志 / Changelog

### v0.3.0 — 2025-06-02

Code Index + Verifier 升级 / Code Index & Verifier Upgrade

#### ✨ 新特性 / New Features
- **Code Index**: LSP 符号索引系统，支持按名称和类型搜索类/函数/接口
- **Verifier**: 子任务完成后自动运行 tsc --noEmit / eslint / npm test，结果反馈给 Reflector
- **LSP 工具链**: 新增 search_symbols / get_workspace_context / get_definition / get_references / find_related_files 工具
- **VERIFIER 状态**: Agent 状态机新增状态，OBSERVE → VERIFIER → REFLECT 流转

#### 🔧 优化 / Improvements
- 状态流转图更新：PLANNING → THINK → ACT → OBSERVE → VERIFIER → REFLECT → (THINK | DONE)
- 工作区上下文信息注入 Agent 上下文
- tool-registry 重构为内聚的私有方法模式

#### 🐛 修复 / Bug Fixes
- search_symbols kind 过滤顺序修复：先 filter 再 slice，确保 kind 过滤不丢失结果

### v0.2.0 — 2025-06-02

三层混合架构升级 / Three-Layer Hybrid Architecture Upgrade

#### ✨ 新特性 / New Features
- **三层混合架构**: 宏观 Planner + 微观 ReAct + 兜底 Reflector
- **Planner**: 将复杂需求拆解为子任务列表，生成高层计划
- **ReAct Executor**: 每个子任务内 THINK → ACT → OBSERVE 循环
- **Reflector**: 子任务完成后自动审查，发现缺陷自动迭代修正
- **计划可视化**: System Prompt 实时展示子任务状态

#### 🔧 优化 / Improvements
- 服务地址和 API Key 分离配置
- 配置切换时不清除已有对话

#### 🐛 修复 / Bug Fixes
- WebviewView provider 重复注册错误处理
- JSON 解析错误修复（提取首个合法 JSON）

### v0.1.0 — 2025-05-30

初始版本 / Initial Release

#### ✨ 新特性 / New Features
- Chat 侧边栏，流式响应
- 多 LLM 后端支持（SGLang / OpenAI / Deepseek / 小米 MiMo）
- 多配置管理（添加 / 切换 / 编辑 / 删除）
- Tab 代码补全（FIM）
- 行内编辑（选中代码直接修改）
- Composer 多文件编辑
- 对话历史持久化保存
- 状态机架构 Agent Core

---

## 如何添加新的模型提供商

本文档详细说明如何为 Coding Agent 添加新的 LLM 模型提供商（例如添加 Google Gemini、Anthropic Claude 等）。

需要修改 **4 个文件**，共 **8 个位置**。以下以添加 `"google"`（Google Gemini）为例逐步说明。

### 文件 1：`package.json` — 配置 schema

在 `codingAgent.llm.provider` 的 `enum` 数组中添加新提供商名称：

```jsonc
// extensions/coding-agent/package.json
// 位置：第 124-130 行
"codingAgent.llm.provider": {
    "type": "string",
    "enum": [
        "sglang",
        "openai",
        "azure",
        "deepseek",
        "mimo",
        "google"        // <-- 1. 在这里添加
    ],
    "default": "sglang",
    "description": "LLM provider (sglang, openai, azure, deepseek, mimo, google)"  // <-- 2. 更新描述
},
```

### 文件 2：`src/config/config-manager.ts` — 配置管理

该文件需要修改 **4 个位置**：

**位置 1** — `LLMConfigProfile` 接口的 `provider` 联合类型（第 11 行）：

```typescript
export interface LLMConfigProfile {
  id: string;
  name: string;
  provider: 'sglang' | 'openai' | 'azure' | 'deepseek' | 'mimo' | 'google';
  // ...
}
```

**位置 2** — `showProfileEditor()` 中的提供商选择列表：

```typescript
const provider = await vscode.window.showQuickPick(
  [
    { label: 'SGLang', value: 'sglang' as const },
    { label: 'OpenAI', value: 'openai' as const },
    { label: 'Azure OpenAI', value: 'azure' as const },
    { label: 'Deepseek', value: 'deepseek' as const },
    { label: '小米 MiMo', value: 'mimo' as const },
    { label: 'Google Gemini', value: 'google' as const },  // <-- 添加
  ],
  { placeHolder: '选择 LLM 提供商' }
);
```

**位置 3** — `getDefaultEndpoint()` 方法：

```typescript
private static getDefaultEndpoint(provider: string): string {
  switch (provider) {
    case 'sglang':
      return 'http://localhost:30000';
    case 'openai':
      return 'https://api.openai.com';
    case 'azure':
      return 'https://your-resource.openai.azure.com/openai/deployments/your-deployment';
    case 'deepseek':
      return 'https://api.deepseek.com';
    case 'mimo':
      return 'https://api.xiaomimimo.com';
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta/openai/';
    default:
      return '';
  }
}
```

**位置 4** — `getDefaultModel()` 方法：

```typescript
private static getDefaultModel(provider: string): string {
  switch (provider) {
    case 'sglang':
      return 'default';
    case 'openai':
      return 'gpt-4';
    case 'azure':
      return 'gpt-4';
    case 'deepseek':
      return 'deepseek-v4-flash';
    case 'mimo':
      return 'mimo-v2-flash';
    case 'google':
      return 'gemini-2.0-flash';
    default:
      return '';
  }
}
```

**可选** — 在 `initDefaultProfiles()` 中添加默认配置：

```typescript
static async initDefaultProfiles(): Promise<void> {
  const profiles = this.getAllProfiles();
  if (profiles.length === 0) {
    const defaultProfiles: LLMConfigProfile[] = [
      // ... 已有配置 ...
      {
        id: 'google-gemini',
        name: 'Google Gemini',
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey: '',
        model: 'gemini-2.0-flash',
        maxTokens: 4096,
        temperature: 0.1,
      },
    ];
    // ...
  }
}
```

### 文件 3：`src/llm/llm-provider.ts` — LLM 接口

该文件需要修改 **2 个位置**：

**位置 1** — `LLMConfig` 接口的 `provider` 联合类型：

```typescript
export interface LLMConfig {
  provider: 'sglang' | 'openai' | 'azure' | 'deepseek' | 'mimo' | 'google';
  // ...
}
```

**位置 2** — `LLMProviderFactory.create()` 的 switch 语句：

```typescript
static create(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'sglang':
      return new SGLangProvider(config);
    case 'openai':
    case 'azure':
    case 'deepseek':
    case 'mimo':
    case 'google':
      return new OpenAIProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
```

> **重要**：如果新提供商的 API **不兼容** OpenAI 格式，你需要创建一个新的 Provider 类，例如 `GoogleProvider`，并在 `create()` 中添加对应的 case。

**位置 3** — `createFromVSCodeConfig()` 的类型断言：

```typescript
static createFromVSCodeConfig(): LLMProvider {
  const cfg = vscode.workspace.getConfiguration('codingAgent');
  const config: LLMConfig = {
    provider: cfg.get<string>('llm.provider') as 'sglang' | 'openai' | 'azure' | 'deepseek' | 'mimo' | 'google' || 'sglang',
    // ...
  };
  return this.create(config);
}
```

### 文件 4：`README.md` — 文档

在支持的后端表格和配置示例中添加新提供商。

### 完整修改清单

| # | 文件 | 位置 | 修改内容 |
|---|------|------|---------|
| 1 | `package.json` | `enum` 数组 | 添加提供商名称 |
| 2 | `package.json` | `description` | 更新描述字符串 |
| 3 | `config-manager.ts` | `LLMConfigProfile` 接口 | 添加 `provider` 联合类型 |
| 4 | `config-manager.ts` | `showProfileEditor()` | 添加 QuickPick 选项 |
| 5 | `config-manager.ts` | `getDefaultEndpoint()` | 添加默认端点 |
| 6 | `config-manager.ts` | `getDefaultModel()` | 添加默认模型 |
| 7 | `llm-provider.ts` | `LLMConfig` 接口 | 添加 `provider` 联合类型 |
| 8 | `llm-provider.ts` | `LLMProviderFactory.create()` | 添加 case 分支 |
| 9 | `llm-provider.ts` | `createFromVSCodeConfig()` | 更新类型断言 |

### 特殊情况：API 不兼容 OpenAI

如果新提供商（如 Anthropic Claude）使用自己的 API 格式，你需要：

1. **创建新的 Provider 类**，继承 `LLMProvider`：

```typescript
export class AnthropicProvider extends LLMProvider {
  async generate(request: GenerateRequest): Promise<string> {
    const url = `${this.config.endpoint}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: request.messages,
        max_tokens: this.config.maxTokens,
      }),
    });
  }

  async *generateStream(request: GenerateRequest): AsyncIterable<string> {
    // 实现 SSE 流式解析
  }

  async fimComplete(request: FIMRequest): Promise<string> {
    // 实现 FIM 补全
  }
}
```

2. **在 Factory 中注册**：

```typescript
static create(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'sglang':
      return new SGLangProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
    case 'azure':
    case 'deepseek':
    case 'mimo':
    case 'google':
      return new OpenAIProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
```

### 验证步骤

添加完成后，运行以下命令验证：

```bash
# 1. 编译检查（捕获类型错误）
cd extensions/coding-agent
npm run compile

# 2. 在 VS Code 中按 F5 启动调试
# 3. 测试新提供商
```

---

## 故障排除 / Troubleshooting

### 问题：无法连接到 LLM

**症状**：Chat 面板显示连接错误

**解决**：
1. 检查 LLM 服务是否运行
2. 检查配置中的端点和 API Key — 注意服务地址和密钥是两个不同字段
3. 检查网络连接和防火墙设置

### 问题：Tab 补全不工作

**症状**：输入代码时没有灰色提示

**解决**：
1. 检查 `codingAgent.enableTabCompletion` 是否启用
2. 检查当前文件类型是否支持
3. 查看 VS Code 输出面板中的日志

### 问题：编译失败

**症状**：运行 `npm run compile` 报错

**解决**：
1. 确保 Node.js 版本 >= 18
2. 删除 `node_modules` 重新安装
3. 检查 TypeScript 是否安装

## 许可证

MIT

## 致谢 / Acknowledgements

- [SGLang](https://github.com/sgl-project/sglang) - 高性能 LLM 推理框架
- [VS Code](https://github.com/microsoft/vscode) - 优秀的编辑器平台
- [小米 MiMo](https://platform.xiaomimimo.com) - 小米大模型平台