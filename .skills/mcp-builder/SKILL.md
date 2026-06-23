---
name: mcp-builder
description: Guide for creating high-quality MCP (Model Context Protocol) servers. Use when the user wants to build an MCP server to integrate an external API or service with TypeScript (MCP SDK) or Python (FastMCP). Trigger on phrases like "build MCP server", "create MCP tool", "MCP integration", or "wrap API as MCP".
tags: [mcp, api, integration, typescript, python, server]
priority: 70
mode: advisory
triggers:
  keywords:
    - mcp
    - mcp server
    - model context protocol
    - build mcp
    - create mcp
    - wrap api
    - 封装 mcp
    - mcp 工具
---

# MCP Server 开发指南

## Overview

帮助用户创建高质量的 MCP (Model Context Protocol) server，让 LLM 能够通过设计良好的 tool 与外部服务交互。MCP server 的质量取决于它让 LLM 完成真实任务的能力。

## When to Use

- 用户想把某个外部 API/服务封装成 MCP tool。
- 用户说 "build MCP server" / "create MCP tool" / "MCP integration" / "封装 mcp"。
- 用户已有 HTTP API，希望 agent 能调用它。

## High-Level Workflow

### Phase 1: 调研与规划

1. **理解 API**
   - 用 `web_search` / `web_fetch` 查看目标服务的 API 文档。
   - 确认认证方式（API key、OAuth、token）。
   - 列出核心端点和数据模型。

2. **选择技术栈**
   - **TypeScript**: 推荐用于需要强类型和良好生态的场景。
     - SDK: `@modelcontextprotocol/sdk`
     - 传输: Streamable HTTP（远程）或 stdio（本地）
   - **Python**: 推荐用于快速原型和数据科学场景。
     - SDK: `fastmcp` 或 `mcp`
     - 传输: Streamable HTTP 或 stdio

3. **Tool 设计原则**
   - 使用一致的前缀命名，例如 `github_create_issue`、`github_list_repos`。
   - 提供清晰、简洁的 tool description。
   - 输入 schema 用 Zod（TS）或 Pydantic（Python）定义，包含约束和示例。
   - 输出尽量结构化；返回文本内容时附上可操作的错误信息。
   - 支持分页（limit/offset 或 cursor）。

### Phase 2: 实现

#### TypeScript 项目结构示例

```
my-mcp-server/
├── src/
│   ├── index.ts          # server 入口
│   ├── client.ts         # API client
│   ├── tools/
│   │   ├── search.ts
│   │   └── create.ts
│   └── types.ts
├── package.json
├── tsconfig.json
└── README.md
```

#### Python 项目结构示例

```
my_mcp_server/
├── server.py
├── client.py
├── tools/
│   ├── search.py
│   └── create.py
├── pyproject.toml
└── README.md
```

#### Tool 必备字段

- `name`: 动作式命名，例如 `amap_direction_driving`
- `description`: 一句话说明功能、参数、返回值
- `inputSchema`: 参数结构 + 字段描述
- `annotations`:
  - `readOnlyHint`: 是否只读
  - `destructiveHint`: 是否有副作用
  - `idempotentHint`: 是否幂等
  - `openWorldHint`: 是否影响外部系统

### Phase 3: 测试

1. **本地构建/语法检查**
   - TypeScript: `npm run build`
   - Python: `python -m py_compile server.py`

2. **用 MCP Inspector 测试**
   ```bash
   npx @modelcontextprotocol/inspector node dist/index.js
   # 或 Python
   npx @modelcontextprotocol/inspector python server.py
   ```

3. **手动端到端测试**
   - 在桌面端设置里配置 `mcpServers`，指向本地 server URL。
   - 启动后问 agent 一个能触发该 tool 的问题，验证是否能正确调用。

### Phase 4: 部署

- **stdio**: 适合本地 server，桌面端 `mcpServers` 配置为 `{ "command": "node", "args": ["dist/index.js"] }`。
- **Streamable HTTP**: 适合远程/多用户，配置为 `{ "url": "https://..." }`。

## Best Practices

- 优先覆盖完整 API，而不是只做一个高层 workflow tool。
- Error message 要具体，告诉 agent 下一步该做什么。
- 不要返回过长的原始 JSON；必要时做摘要或分页。
- 不要把 API key 硬编码进代码，使用环境变量或运行时配置。
- 敏感操作（删除、修改）加 `destructiveHint: true`。

## Common Pitfalls

| 问题 | 原因 | 建议 |
|---|---|---|
| Tool 名太泛 | LLM 选错 tool | 用 `<service>_<action>_<resource>` 格式 |
| 返回超大 JSON | 超出上下文 | 分页 + 摘要 |
| 错误信息模糊 | agent 无法修复 | 包含状态码、建议重试条件 |
| 缺少 input schema 约束 | 参数错误 | 用 Zod/Pydantic 加必填、类型、范围 |
