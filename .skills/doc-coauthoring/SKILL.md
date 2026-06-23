---
name: doc-coauthoring
description: Guide users through a structured workflow for co-authoring documentation, proposals, technical specs, decision docs, or similar structured content. Use when the user mentions writing docs, drafting a proposal, creating a spec, writing a PRD/RFC, or starting a substantial writing task.
tags: [writing, docs, collaboration, proposal, spec, prd, rfc]
priority: 60
mode: advisory
triggers:
  keywords:
    - write a doc
    - draft a proposal
    - create a spec
    - 写文档
    - 写 PRD
    - 写需求文档
    - 写设计文档
    - 写方案
    - 写提案
    - 写 RFC
    - documentation
    - 文档
---

# 文档共创工作流

## Purpose

引导用户通过结构化流程协作完成文档、提案、技术方案、决策文档等。分为三个阶段：

1. **Context Gathering（收集上下文）**
2. **Refinement & Structure（打磨与结构化）**
3. **Reader Testing（读者测试）**

## When to Offer

当用户提到以下任何内容时，主动提供这个工作流：

- "写文档"、"写 PRD"、"写设计文档"、"写方案"、"写提案"
- "draft a proposal"、"create a spec"、"write a doc"、"RFC"
- 看起来要开始一个较大的写作任务

先简要说明三个阶段，询问用户想尝试结构化流程还是自由发挥。如果用户拒绝，就自由发挥。

## Stage 1: Context Gathering

### Initial Questions

1. 这是什么类型的文档？（技术方案、决策文档、提案、PRD...）
2. 主要读者是谁？
3. 希望读者读完有什么行动或认知？
4. 是否有模板或格式要求？
5. 还有其他约束或背景吗？

### Info Dumping

鼓励用户把所有相关信息倒出来，包括但不限于：

- 项目/问题背景
- 相关讨论或文档链接
- 为什么没选其他方案
- 组织架构、过往事件、利害关系
- 时间压力或约束
- 技术架构或依赖
- 利益相关者关切

### Clarifying Questions

用户完成初步信息倾倒后，基于缺失信息提出 5-10 个编号问题。用户可以用简写回答，例如：

> 1: 是，2: 看 #频道，3: 因为兼容性问题

当问题能涉及边界情况和权衡时，说明上下文已足够。

## Stage 2: Refinement & Structure

### Document Structure

根据文档类型建议 3-5 个章节。例如：

- **决策文档**: 背景、问题、可选方案、推荐方案、风险、下一步
- **技术方案**: 目标、现状、方案设计、实现步骤、风险、验收标准
- **PRD**: 背景、目标用户、需求列表、功能描述、验收标准、发布计划

先用 `write_file` 创建一个只有标题和占位符的 scaffold 文件，例如 `decision-doc.md`。

### Per Section Workflow

对每个章节：

1. **Clarifying Questions**: 问 5-10 个关于该章节要包含什么的问题。
2. **Brainstorming**: 给出 5-20 个可选要点。
3. **Curation**: 让用户选择保留/删除/合并哪些要点。
4. **Gap Check**: 问是否遗漏重要内容。
5. **Drafting**: 用 `replace_text` 把占位符替换为实际内容。
6. **Iterative Refinement**: 根据用户反馈继续用 `replace_text` 修改。

### Quality Check

完成 80% 以上章节后，重新通读全文，检查：

- 章节间逻辑一致性
- 冗余或矛盾
- 是否有"废话"或泛泛而谈
- 每句话是否有信息量

## Stage 3: Reader Testing

桌面端没有 sub-agent，因此改为引导用户手动测试：

1. **预测读者问题**: 生成 5-10 个读者可能会问的问题。
2. **手动测试**: 让用户把文档贴到一个新对话里，用这些问题提问。
3. **检查歧义**: 让读者（或用户自己）回答：
   - "文档里哪里可能不清楚？"
   - "文档假设读者已经知道什么？"
   - "有没有内部矛盾？"
4. **修复**: 把发现的问题回到 Stage 2 修复。

## Tool Mapping

| Claude Code | 桌面端 |
|---|---|
| `create_file` | `write_file` |
| `str_replace` | `replace_text` |
| artifacts | 直接写入 `.md` 文件 |
| sub-agent reader testing | 用户手动在新对话中测试 |

## Best Practices

- 让用户用简写、链接、文件路径提供上下文。
- 不要一次性输出整篇文档；逐节打磨。
- 每次修改后确认文件路径。
- 如果用户直接编辑了文件，用 `read_file` 读取最新内容再继续。
- 写作风格直接、 procedural，不过度推销这个方法。
