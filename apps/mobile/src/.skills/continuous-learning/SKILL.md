---
name: continuous-learning
description: 持续学习：自动记录错误、用户纠正和外部 API 失败，避免重复犯错。当用户说"记住错误"、"我之前说过"、"不要重复犯"时使用。
tags: [memory, learning, error-tracking, feedback]
priority: 80
mode: advisory
triggers:
  intents:
    - 记住
    - 别再
    - 不要重复
    - 不要犯
    - 学习了
    - 上次
    - 之前
  keywords:
    - 错误
    - 失败
    - 纠正
    - 不对
    - 错了
    - remember
    - error
    - mistake
    - feedback
stopIf: []
imports: []
toolsAllow: []
---

## Purpose

记录学习、错误和更正，以实现持续改进。让 Agent 跨会话保留经验，避免重复犯错。

## Use When

1. 某个命令或操作意外失败
2. 用户纠正了你（例如："不，那是错的..."、"实际上..."、"应该是..."）
3. 用户请求一个不存在的功能
4. 外部 API 或工具失败
5. 你意识到你的知识过时或不正确
6. 发现了完成某任务的更好方法
7. 在执行重要任务前应回顾这些学习

## Workflow

1. 检测到学习信号（错误、纠正、用户反馈）
2. 调用 `record_learning` 工具保存到长期记忆
   - category: error / correction / api_failure / user_info / best_practice
   - summary: 简短的标题
   - details: 详细上下文
   - tags: 用于检索的标签
3. 在执行重要任务前，调用 `search_learnings` 检索相关历史经验
4. 基于经验调整当前行为

## Do

- 立即记录，不要等到对话结束
- 用清晰的 category 分类
- summary 要简短（1-2 句话）
- details 要包含足够的上下文（什么场景、为什么失败、怎么修）
- 给每条学习打 tags，方便以后检索
- 在重要决策前先 search_learnings

## Do Not

- 不要记录一次性、不重要的小错误
- 不要把用户隐私信息记录到长期记忆
- 不要在 details 里包含敏感数据（密码、token、身份证号等）
- 不要过度概括（"用户不喜欢 X"），要具体（"用户不喜欢在回答里加 emoji"）

## Examples

### 例 1：用户纠正

用户：不，你搞错了。我不是要算 1+1=2，是要解释为什么 1+1=2。

→ 调用 `record_learning`：
- category: "correction"
- summary: "用户问'1+1='时，期望的是哲学/数学解释，不是直接给答案"
- details: "用户问'1+1等于几'时，更深层的意图是想讨论数学基础或哲学含义。直接说'等于 2'会被认为回避问题。"
- tags: ["math", "user-preference", "explanation-style"]

### 例 2：API 失败

调用 Jina Search API 返回 401

→ 调用 `record_learning`：
- category: "api_failure"
- summary: "Jina Search API key 失效时返回 401"
- details: "错误码 401 = 认证失败，需要用户重新配置 API key。建议提示用户在设置中重新输入。"
- tags: ["jina", "search", "auth", "api"]

## Verification

调用 `search_learnings` 能找到相关历史记录即为成功。
