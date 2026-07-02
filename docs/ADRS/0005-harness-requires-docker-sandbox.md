# 0005. Harness 评测必须在 Docker 沙箱中执行

- 状态：Accepted
- 日期：2026-06-17
- 决策人：@Ziner V2 架构组
- 影响阶段：Phase 3

## 背景

Harness 用于跑 Benchmark（代码生成 / 修复 / 测试），Agent 会执行任意命令与网络请求。
如果直接跑在宿主机：
- 用户工作区会被污染
- 网络请求可能泄露数据
- 失败 Benchmark 难以复现

## 备选方案

- 方案 A：直接跑在宿主机（最快）
- 方案 B：本地进程隔离（chroot / namespace）
- 方案 C：Docker / Podman 容器（推荐）
- 方案 D：远程 Worker 集群

## 决策

采用 **方案 C**：Docker（或 Podman）容器。

- 每个 Benchmark 任务一个独立容器
- 容器基于 benchmark 指定的镜像启动
- 网络默认 `bridge` 隔离，可选白名单
- 资源限制：CPU / 内存 / 超时
- 任务结束容器自动销毁
- 不在 Windows 桌面端做 Harness 评测（容器仅 Linux 可用，桌面端只做单任务试跑）

> Windows 桌面用户：评测任务通过 WSL2 / 远程 Linux Worker 执行。

## 后果

### 正面
- 宿主环境与用户数据完全隔离
- 任务可复现（镜像版本固定）
- 危险操作（rm -rf、git push）天然受限

### 负面 / 成本
- 需要 Docker / Podman 运行时
- 桌面端无法直接评测，依赖 WSL2 或远程
- 容器启动有额外延迟（~1-3s）

### 缓解措施
- 容器镜像预热（常驻 base image）
- 批量任务复用容器（一次启 N 个 Run）
- 文档明确"桌面端只跑单任务，批量评测需要 Linux 环境"
