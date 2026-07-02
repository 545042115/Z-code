---
name: amap-maps
description: 高德地图综合服务，支持 POI 搜索、路径规划、旅游规划、周边搜索和热力图数据可视化。需要用户配置高德地图 API Key。
tags: [maps, location, amap, gaode, navigation, poi, search]
priority: 70
mode: advisory
triggers:
  intents:
    - 附近的餐厅
    - 附近的咖啡店
    - 怎么去
    - 怎么走
    - 导航
    - 路径规划
    - 距离
    - 周边
    - 附近
    - 周围
    - 周边搜索
    - 找酒店
    - 找景点
  keywords:
    - 地图
    - 位置
    - 定位
    - 路线
    - 导航
    - POI
    - 酒店
    - 景点
    - 餐厅
    - 美食
    - 咖啡
    - 高德
    - amap
    - gaode
    - 公交
    - 地铁
    - 驾车
    - 步行
stopIf: []
imports: []
toolsAllow: []
---

## Purpose

基于高德地图提供位置服务，让用户能查询 POI、规划路径、搜索周边。

## Use When

- "附近的咖啡店" / "附近有什么好吃的"
- "从 A 到 B 怎么走" / "导航到 XXX"
- "这个地址在哪" / "经纬度转换"
- "周边 1 公里内的酒店"
- 任何涉及位置、距离、路线的问题

## Workflow

1. 检测用户场景：POI 搜索 / 路径规划 / 周边搜索 / 地理编码
2. 调用对应工具：
   - `amap_poi_search`: 搜索 POI（餐厅、酒店、景点等）
   - `amap_route_plan`: 规划路径（驾车/公交/步行/骑行）
   - `amap_nearby`: 搜索周边
   - `amap_geocode`: 地址 ↔ 经纬度
3. 整理结果为自然语言输出
4. 给出关键距离 / 时间 / 票价

## Do

- 先确认用户起点和终点
- 提供多种出行方式（驾车 / 公交 / 步行）对比
- 标注距离和预计时间
- 包含地址的经纬度信息
- 对结果按距离 / 评分排序

## Do Not

- 不要忽略用户的"附近"半径（默认 1 km）
- 不要在无 key 时假装能查
- 不要给不存在的位置
- 不要在路线规划时忽略实时路况

## Examples

### 例 1：用户说"中关村附近的咖啡店"

→ 调用 amap_poi_search("咖啡店", location="北京中关村", radius=1000)
→ 输出：列出 5 家最近的咖啡店，含距离、评分

### 例 2：用户说"从天安门到故宫怎么走"

→ 调用 amap_route_plan("天安门", "故宫", mode="walking")
→ 输出：步行距离 1.2 km，预计 16 分钟，路线描述

## Verification

API 调用成功且返回非空结果。配置 API Key 在设置页面。
