# Z Code

AI 编程助手集合 —— 基于多后端 LLM 的 VS Code 扩展。

支持 **SGLang**（本地推理）、**OpenAI**、**Deepseek**、**小米 MiMo** 等多种模型后端，提供类似 Cursor/Trae 的编程体验。

## 项目结构

```
├── extensions/
│   └── coding-agent/       VS Code 扩展（核心项目）
│       ├── src/
│       │   ├── agent/          确定性状态机 Agent Core
│       │   ├── config/         多配置管理（globalState 存储）
│       │   ├── llm/            统一 LLM 接口
│       │   ├── context/        LSP 上下文管理
│       │   ├── tools/          工具系统
│       │   ├── panels/         Chat / Composer 面板
│       │   └── inline/         Tab 补全和行内编辑
│       └── package.json
├── tools/                     开发工具脚本
│   ├── update.ps1             更新/打包脚本
│   ├── compile.ps1            编译脚本
│   └── package.ps1            打包脚本
├── AGENT_SPEC.md              状态机设计规范
└── .gitignore
```

## Coding Agent — VS Code Extension

### 特性

- **Chat 侧边栏** — 智能代码问答，流式响应，类 Trae 侧边栏体验
- **Composer** — 多文件批量编辑
- **Tab 补全** — 基于 FIM 的智能代码补全
- **行内编辑** — 选中代码直接修改
- **多配置管理** — 保存多个 LLM 配置，一键切换

### 支持的后端

| 提供商 | 说明 | 需要 API Key |
|--------|------|-------------|
| **SGLang** | 本地高性能推理 | ❌ |
| **OpenAI** | GPT-4 / GPT-3.5 | ✅ |
| **Deepseek** | 国产大模型 | ✅ |
| **小米 MiMo** | 小米大模型 | ✅ |

### 安装

#### 方式 1：安装 .vsix 文件（推荐）

```powershell
# 运行打包脚本生成 .vsix
.\tools\update.ps1
```

然后在 VS Code 中：`Ctrl+Shift+X` → `...` → `Install from VSIX` → 选择生成的 `.vsix` 文件。

#### 方式 2：开发者模式

```bash
cd extensions/coding-agent
npm install
npm run compile
# 按 F5 启动调试
```

### 快速开始

1. `Ctrl+Shift+P` → `Coding Agent: 添加配置`，按照向导配置 LLM
2. 点击左侧活动栏的 **Coding Agent 图标** 打开侧边聊天栏
3. 在底部输入框输入你的问题

### 配置管理

支持保存多个 LLM 配置，方便在不同场景下快速切换。

| 命令 | 功能 |
|------|------|
| `Coding Agent: 添加配置` | 添加新 LLM 配置 |
| `Coding Agent: 切换配置` | 切换当前使用的配置 |
| `Coding Agent: 编辑配置` | 编辑已有配置 |
| `Coding Agent: 删除配置` | 删除配置 |

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+L` | 打开 Chat 输出面板（历史记录） |
| `Ctrl+Shift+I` | 弹出输入框发送消息 |
| `Ctrl+Shift+O` | 打开 Composer 面板 |
| `Ctrl+K Ctrl+I` | 行内编辑（需要选中代码） |
| `Tab` | 接受代码补全 |

### 添加新的模型提供商

Coding Agent 支持扩展新的 LLM 提供商（如 Google Gemini、Anthropic Claude 等）。

只需修改以下文件即可：

| # | 文件 | 修改内容 |
|---|------|---------|
| 1 | `package.json` | `enum` 数组添加提供商名称 |
| 2 | `config-manager.ts` | 添加提供商类型、QuickPick 选项、默认端点、默认模型 |
| 3 | `llm-provider.ts` | 添加提供商类型和 Factory case 分支 |

详细步骤请参考 [extensions/coding-agent/README.md](extensions/coding-agent/README.md) 中的「如何添加新的模型提供商」章节。

## 开发

### 环境要求

- Node.js 18+
- VS Code 1.85+
- TypeScript 5.3+

### 构建

```bash
cd extensions/coding-agent
npm install
npm run compile
```

### 打包

```powershell
.\tools\update.ps1
```

## 许可证

MIT