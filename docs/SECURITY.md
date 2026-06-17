# Security Policy（安全策略）

> 本文档定义 Z Assistant V2 的安全模型、威胁面、缓解措施与披露流程。
> 适用于**所有阶段**（Phase 0 ~ 5），与 `docs/ADRS/` 互为补充。

---

## 1. 安全目标

1. **用户数据零外泄**：默认不向任何第三方服务发送用户工作区内容。
2. **工具调用最小权限**：每个工具只能访问其声明范围的资源。
3. **配置与密钥零明文落盘**：API Key 走 OS 密钥链。
4. **演化可控**：Evolution 阶段的所有变更需人工确认。
5. **失败可审计**：所有安全相关事件可追溯到 Trace。

---

## 2. 威胁模型（STRIDE 速览）

| 类别 | 威胁 | 缓解 |
|---|---|---|
| **Spoofing（伪装）** | 伪造 LLM 响应、伪造 Tool 结果 | 工具签名校验、Prompt 注入检测 |
| **Tampering（篡改）** | 工具越权改文件、Prompt 注入 | 文件/网络沙箱、Prompt 模板固定 |
| **Repudiation（抵赖）** | 用户否认操作 | Trace 全留痕，签名 Span |
| **Information Disclosure（信息泄露）** | 用户文件/密钥外发 | 网络白名单、密钥走 Keychain |
| **Denial of Service（拒绝服务）** | 死循环/巨文件耗尽资源 | 单 Run 预算 + 资源硬限 |
| **Elevation of Privilege（越权）** | Agent 提权执行系统命令 | 工具白名单 + 容器隔离（Harness） |

---

## 3. 信任边界

```text
┌──────────────────────────────────────────┐
│  不可信：用户输入 / Web 内容 / 工具结果   │
└──────────────────┬───────────────────────┘
                   │  Prompt 模板 + 解析
┌──────────────────▼───────────────────────┐
│  可信：LLM 输出（视为"半可信"）          │
└──────────────────┬───────────────────────┘
                   │  工具调用（沙箱校验）
┌──────────────────▼───────────────────────┐
│  不可信：Tool 副作用（必须显式授权）      │
└──────────────────────────────────────────┘
```

> **核心原则**：LLM 输出**永远**视为不可信。任何"读 LLM 输出再决定文件操作"的路径必须经过白名单校验。

---

## 4. 权限与沙箱

### 4.1 文件访问

| 范围 | 默认策略 | 越权行为 |
|---|---|---|
| Workspace 内 | 允许 | — |
| Workspace 外 | **拒绝**（除非用户显式授权） | 记 error `2002` |
| 系统目录 | 拒绝 | 记 error `2002` |
| 隐藏文件（`.env` 等） | 拒绝（默认） | 需白名单显式开启 |

实现：`src/infra/permission/fs-guard.ts`（见 PHASE0）。

### 4.2 网络出口

| 目标 | 默认策略 |
|---|---|
| LLM Provider API | 允许（按 host 白名单） |
| 任意其他域名 | 拒绝 |
| 任意 IP 直连 | 拒绝 |

实现：`src/infra/permission/net-guard.ts`。

### 4.3 工具调用

- 工具必须登记在 `config-center` 的 `tools.allow` 列表中
- 危险工具（`shell_exec` / `write_file`）需要二次确认
- 危险操作（`rm -rf` / `git push --force`）默认拦截

---

## 5. 密钥与凭证

### 5.1 存储

- **绝不允许**把 API Key 写入 SQLite、JSONL、日志、Trace attributes
- API Key 必须走 OS 原生密钥链：
  - Windows：DPAPI / Credential Manager
  - macOS：Keychain
  - Linux：Secret Service（D-Bus）
- 内存中临时持有，**不做**明文落盘

### 5.2 加载

```ts
// src/infra/config/secrets.ts
export async function loadSecret(name: string): Promise<string> {
  // 1. OS Keychain
  // 2. 环境变量（仅 dev）
  // 3. 抛出 5xxx 错误
}
```

### 5.3 传输

- 所有出站请求强制 HTTPS
- 禁止 `disableTlsVerify` 类配置项

---

## 6. Prompt 注入防御

LLM 输出不可信。所有"把 LLM 输出当命令执行"的路径必须有：

1. **白名单校验**：只接受预定义 schema 内的字段
2. **长度限制**：单次工具调用参数 < 32KB
3. **路径校验**：任何文件路径必须经过 `fs-guard`
4. **命令校验**：Shell 命令必须经过 `allow-cmd` 列表
5. **Span 留痕**：所有工具调用必须产生 Span（Phase 1 强制）

> 参考：[OWASP LLM01 Prompt Injection](https://owasp.org/www-project-top-10-for-large-language-model-applications/)

---

## 7. 数据保护

### 7.1 留痕范围

- **必须留痕**：所有工具调用、文件读写、网络请求
- **禁止留痕**：API Key、Authorization 头、用户明文密码
- attributes 中若命中敏感字段（`password` / `token` / `secret`）→ 自动脱敏为 `***`

### 7.2 数据保留

| 数据 | 保留期 | 归档 |
|---|---|---|
| Trace（SQLite） | 90 天 | 超出可导出 zip |
| Trace（JSONL） | 30 天 | 30 天后压缩 `.jsonl.zst` |
| Benchmark 报告 | 永久 | 单独目录 |
| Evolution 候选 | 永久 | 单独目录 |

### 7.3 用户控制

- 用户可一键关闭 Trace：`config.run.trace_enabled = false`
- 关闭后仍记录最小化元数据（用于成本/配额）
- 用户可一键导出 / 删除全部 Trace（GDPR-like）

---

## 8. Harness 沙箱（Phase 3）

详见 [ADR 0005](./ADRS/0005-harness-requires-docker-sandbox.md)。

要点：

- 每个 Benchmark 任务独立容器
- 网络默认隔离，资源硬限
- 容器结束即销毁，文件系统不留痕

---

## 9. Evolution 安全门（Phase 5）

详见 [ADR 0004](./ADRS/0004-evolution-requires-human-approval.md)。

要点：

- Evolution 引擎**只生成候选**，不直接修改
- 候选进入 `Proposed` 状态，必须人工确认
- 灰度期异常自动回滚

---

## 10. 错误码约定（与 `PHASE0_FOUNDATION.md` 对齐）

| 范围 | 类别 | 示例 |
|---|---|---|
| 1xxx | LLM | 1001 rate_limit, 1002 context_overflow |
| 2xxx | Tool / 权限 | 2001 not_found, **2002 permission_denied** |
| 3xxx | Agent | 3001 timeout, 3002 budget_exceeded |
| 4xxx | Sandbox | 4001 container_oom |
| 5xxx | Config | 5001 schema_invalid |
| 9xxx | Unknown | 9001 unexpected |

> 所有权限相关失败必须使用 `2002`，便于审计聚合。

---

## 11. 依赖与供应链

- 所有 npm 依赖必须 `pnpm audit` 通过
- 高风险依赖（执行 shell / 解析 YAML）需要 pin 具体版本
- 锁文件（`pnpm-lock.yaml`）必须提交
- 引入新依赖需在 PR 中说明用途与替代方案

---

## 12. 漏洞披露

如发现安全漏洞，请**不要**公开 issue，请联系：

- 邮箱：`security@z-assistant.local`（占位，需替换为真实地址）
- 加密：PGP key 见 `docs/SECURITY_PGP.asc`（占位，未生成）

响应承诺：

- 48 小时内确认
- 7 天内评估严重性
- 30 天内修复（高危 7 天）

---

## 13. 检查清单（每阶段合并前自查）

- [ ] 没有 API Key 出现在 Trace / 日志 / 配置文件中
- [ ] 新增工具已登记 `tools.allow`
- [ ] 危险操作（rm / force-push / 写系统目录）默认拦截
- [ ] 网络出口走 `net-guard` 白名单
- [ ] 错误码使用 2xxx 标记权限失败
- [ ] 数据保留策略已配置
- [ ] 依赖审计通过

---

## 14. 相关文档

- [PHASE0_FOUNDATION.md](./PHASE0_FOUNDATION.md) — 基础设施中的权限模块
- [ADRS/0004-evolution-requires-human-approval.md](./ADRS/0004-evolution-requires-human-approval.md)
- [ADRS/0005-harness-requires-docker-sandbox.md](./ADRS/0005-harness-requires-docker-sandbox.md)
- [ADRS/0006-prompt-and-tool-via-config-center.md](./ADRS/0006-prompt-and-tool-via-config-center.md)
