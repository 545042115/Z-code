---
name: skill-writing-guide
description: Best practices for writing effective OpenClaw / Claude Code compatible SKILL.md files. Use when the user wants to create a new skill, improve an existing skill's triggering accuracy, or review a skill draft.
tags: [skill, meta, prompt-engineering, authoring, guidelines]
priority: 55
mode: advisory
triggers:
  keywords:
    - write a skill
    - create skill
    - skill authoring
    - skill writing
    - 写 skill
    - 创建 skill
    - skill 触发
    - skill description
---

# SKILL.md 写作指南

## Purpose

帮助用户写出高质量、易触发、可维护的 OpenClaw / Claude Code 风格 SKILL.md 文件。

## Core Principle

Skill 的核心是 **description + frontmatter**。Description 是主要触发机制，必须同时说明：

1. 这个 skill 做什么
2. 什么时候应该使用它

## Required Frontmatter

```yaml
---
name: my-skill-name          # 小写，连字符分隔
description: "做什么 + 什么时候用。描述要稍微主动一点（pushy），确保 skill 在相关场景下被触发。"
tags: [tag1, tag2]
priority: 60                 # 0-100，越高越优先
mode: advisory               # advisory | strict
triggers:
  keywords:
    - keyword1
    - keyword2
---
```

### Description 写作技巧

Claude 有 "undertrigger" 倾向：即使在相关场景也可能不用 skill。因此 description 要主动：

❌ 不好：
> "How to build a dashboard for internal data."

✅ 更好：
> "How to build a dashboard for internal data. Use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display company data, even if they don't explicitly ask for a 'dashboard.'"

## Skill Anatomy

```
skill-name/
├── SKILL.md              # 必需：YAML frontmatter + markdown 说明
├── references/           # 可选：按需加载的参考文档
├── scripts/              # 可选：确定性/重复性任务的脚本
└── assets/               # 可选：模板、图标、字体等输出资源
```

## Progressive Disclosure

1. **Metadata**（name + description）— 始终在上下文里，约 100 词
2. **SKILL.md body** — 触发时加载，理想 <500 行
3. **Bundled resources** — 按需加载，无限制

## Writing Patterns

### 1. 使用祈使句

❌ 不要：
> "You should consider using web_search first."

✅ 要：
> "First, use web_search."

### 2. 定义输出格式

```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

### 3. 提供示例

```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### 4. 分域组织

如果 skill 支持多个框架/平台，按 variant 组织：

```
cloud-deploy/
├── SKILL.md
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

## Triggers 设计

- **keywords**: 最常用，命中即加分。
- **intents**: 用于更高层的语义匹配。
- **fileGlobs**: 当用户打开特定类型文件时触发。

建议每个 skill 包含 5-15 个关键词，覆盖同义和变体。

## Common Mistakes

| 问题 | 后果 | 修复 |
|---|---|---|
| Description 只讲功能不讲场景 | skill 不被触发 | 加入 "Use when..." |
| Body 超过 500 行 | 稀释注意力 | 拆分到 references/ |
| 关键词太少 | 匹配率低 | 加同义词和场景词 |
| 指令太抽象 | agent 执行不一致 | 给具体步骤和示例 |
| 包含恶意/意外行为 | 安全风险 | 遵循 "lack of surprise" 原则 |

## Review Checklist

- [ ] name 唯一且语义清晰
- [ ] description 包含功能和触发场景
- [ ] tags 与 skill 主题相关
- [ ] priority 合理（常用 skill 可设 60-70）
- [ ] triggers 覆盖主要用户表达
- [ ] body 使用祈使句、有具体步骤
- [ ] 有必要时提供 examples
- [ ] 不依赖当前环境特有的 binary 或文件路径
