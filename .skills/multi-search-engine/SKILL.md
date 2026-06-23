---
name: multi-search-engine
description: 聚合 16 个搜索引擎（7 国内 + 9 国际）进行信息检索，无需 API key，适合中文/英文实时信息查询。
tags: [search, web, research, chinese, international]
priority: 65
mode: advisory
triggers:
  keywords:
    - 搜索
    - 查一下
    - search
    - 最新消息
    - 实时
    - 价格
    - 汇率
    - 天气
    - 股价
    - wolfram
---

## Purpose

当用户需要查询实时信息、新闻、价格、汇率、天气、股价、特定站点内容时，优先使用多搜索引擎聚合结果，而不是只依赖单一 web_search 来源。

## Use When

- 用户用中文提问，涉及新闻、实时信息、国内服务。
- 用户用英文提问，需要国际来源或隐私搜索引擎。
- 用户明确说"搜索"、"查一下"、"search"。
- 单一 web_search 返回结果不足或可信度低。
- 需要计算/换算/知识查询（WolframAlpha）。

## Do NOT Use When

- 已有明确 MCP 工具可用（如高德 MCP 查路线/天气、麦当劳 MCP 点餐）。
- 只需要读取某个已知 URL 的具体内容（用 web_fetch 直接访问）。

## Workflow

1. **判断查询语言**
   - 中文/中文语境 → 优先使用国内引擎（Baidu、Bing CN、Sogou、WeChat 搜狗、360、神马）。
   - 英文/其他外语 → 优先使用国际引擎（Google、DuckDuckGo、Startpage、Brave、Qwant、Yahoo）。

2. **选择 2-4 个合适引擎并行查询**
   - 不要一次调用全部 16 个引擎。
   - 中文：Baidu + Bing CN + Sogou + WeChat 搜狗。
   - 英文：Google + DuckDuckGo + Brave + Startpage。
   - 计算/换算：WolframAlpha。

3. **构造搜索 URL 并用 web_fetch 抓取**
   - 关键词需要 URL encode（空格替换为 `+`）。
   - 每次调用间隔 1-2 秒，避免触发反爬。
   - 如果返回 403/429，先访问该引擎首页获取 cookie，再重试一次。

4. **聚合与总结**
   - 提取各引擎前 3-5 条结果标题+摘要+链接。
   - 去重后按可信度排序。
   - 给出最终回答，并标注来源引擎和查询时间。

## Domestic Search Engines (Chinese)

| Engine | URL Template |
|--------|--------------|
| Baidu | `https://www.baidu.com/s?wd={keyword}` |
| Bing CN | `https://cn.bing.com/search?q={keyword}&ensearch=0` |
| Bing INT | `https://cn.bing.com/search?q={keyword}&ensearch=1` |
| 360 | `https://www.so.com/s?q={keyword}` |
| Sogou | `https://sogou.com/web?query={keyword}` |
| WeChat Articles | `https://wx.sogou.com/weixin?type=2&query={keyword}` |
| Shenma | `https://m.sm.cn/s?q={keyword}` |

## International Search Engines

| Engine | URL Template |
|--------|--------------|
| Google | `https://www.google.com/search?q={keyword}` |
| Google HK | `https://www.google.com.hk/search?q={keyword}` |
| DuckDuckGo | `https://duckduckgo.com/html/?q={keyword}` |
| Yahoo | `https://search.yahoo.com/search?p={keyword}` |
| Startpage | `https://www.startpage.com/sp/search?query={keyword}` |
| Brave | `https://search.brave.com/search?q={keyword}` |
| Ecosia | `https://www.ecosia.org/search?q={keyword}` |
| Qwant | `https://www.qwant.com/?q={keyword}` |
| WolframAlpha | `https://www.wolframalpha.com/input?i={keyword}` |

## Advanced Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `site:` | `site:github.com python` | 限定站点 |
| `filetype:` | `filetype:pdf report` | 限定文件类型 |
| `""` | `"machine learning"` | 精确匹配 |
| `-` | `python -snake` | 排除词 |
| `OR` | `cat OR dog` | 多词任选 |

## Time Filters (Google/Bing)

| Parameter | Description |
|-----------|-------------|
| `tbs=qdr:h` | 过去 1 小时 |
| `tbs=qdr:d` | 过去 1 天 |
| `tbs=qdr:w` | 过去 1 周 |
| `tbs=qdr:m` | 过去 1 个月 |
| `tbs=qdr:y` | 过去 1 年 |

## Privacy & Bangs

- 隐私优先：DuckDuckGo、Startpage、Brave、Qwant。
- DuckDuckGo Bangs：`!gh tensorflow` → GitHub，`!w beijing` → Wikipedia，`!so react` → StackOverflow，`!yt music` → YouTube。

## Best Practices

- 中文查询优先用 Baidu + Bing CN + Sogou。
- 国际查询优先用 Google + DuckDuckGo。
- 实时/计算优先用 WolframAlpha。
- 每次 web_fetch 后等待 1-2 秒再调用下一个引擎。
- 始终标注来源和查询时间。
- 不要从 silence 中推断用户偏好。
