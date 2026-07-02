---
name: web-summarize
description: 使用 summarize CLI 总结 URL、PDF、图片、音频、YouTube 视频。给定一个 URL 或本地文件，返回简洁的摘要。
tags: [summarize, fetch, url, pdf, youtube, media]
priority: 75
mode: advisory
triggers:
  intents:
    - 总结这个网页
    - 总结一下
    - 这个 PDF 讲什么
    - 视频讲什么
    - 总结内容
    - 摘要
    - 概括
  keywords:
    - summarize
    - 总结
    - 摘要
    - 概括
    - tldr
    - PDF
    - YouTube
    - 网页
    - 文章
    - audio
    - 音频
stopIf: []
imports: []
toolsAllow: []
---

## Purpose

把长内容（网页、PDF、图片、音频、YouTube）压缩成简短摘要，节省用户时间。

## Use When

用户分享一个 URL 或文件，并说"总结"、"摘要"、"这个讲什么"等。

支持：
- 网页 URL（HTML）
- PDF 文件
- 图片（OCR 提取文字）
- 音频文件（语音转文字）
- YouTube 视频（提取字幕）

## Workflow

1. 检测用户输入是 URL 还是本地文件
2. 调用 `fetch_url` 工具（基于 Jina Reader）抓取内容
3. 提取核心信息（标题、作者、关键观点）
4. 用 3-5 句话总结，必要时分点
5. 如有需要，列出"延伸阅读"建议

## Do

- 先抓取再总结，不要靠记忆
- 总结要包含：核心论点 / 关键数据 / 行动建议（如有）
- 引用来源 URL
- 对中文内容用中文总结
- 长内容（> 5000 字）分章节总结

## Do Not

- 不要对内容做价值判断（"这篇文章写得好"）
- 不要在总结里添加未在原文出现的信息
- 不要省略数据 / 数字
- 不要把广告 / 推荐链接混入总结

## Examples

### 例 1：用户说"总结一下 https://example.com/article"

→ 流程：
1. fetch_url("https://example.com/article")
2. 提取标题、作者、发布时间
3. 总结 3-5 个核心观点
4. 输出格式：
   ```
   📄 标题：...
   ✍️ 作者：...
   📅 发布：...
   
   核心观点：
   1. ...
   2. ...
   3. ...
   ```

### 例 2：用户说"这个 YouTube 视频讲什么 https://youtu.be/xxx"

→ 流程：
1. fetch_url 抓取字幕
2. 按时间轴分段总结
3. 输出关键时间点 + 核心观点

## Verification

总结长度应为原文 10-20%，包含原文核心信息。
