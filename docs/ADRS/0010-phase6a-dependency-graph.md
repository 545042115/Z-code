# Phase 6A — Dependency Graph

> Step 10 deliverable. This document maps every package in the V2
> monorepo and the apps in `apps/` to their declared dependencies.
> Generated from `package.json` files in this revision.
>
> Verifier: every edge here corresponds to a real
> `dependencies.entry` in the corresponding `package.json`. A node
> is included if its `package.json` is in the workspace
> (`packages/`, `apps/`, or `extensions/coding-agent/`).

## 1. Top-level view

```
                            ┌──────────────────────────────────┐
                            │            apps/*                │
                            │  (vscode-connector / cli /       │
                            │   desktop)                       │
                            └──────┬───────────────┬───────────┘
                                   │               │
                                   ▼               ▼
                          ┌────────────┐    ┌────────────┐
                          │  runtime   │    │  agents/*  │
                          │ (composes) │    │ (adapters) │
                          └──────┬─────┘    └──────┬─────┘
                                 │                │
                                 ▼                │
        ┌────────────────┬───────┴───────┐        │
        ▼                ▼               ▼        │
   ┌────────┐       ┌──────────┐    ┌─────────┐   │
   │ trace  │       │ evolution│    │  ...    │   │
   └───┬────┘       └────┬─────┘    └─────────┘   │
       │                 │                       │
       ▼                 ▼                       │
   ┌────────┐       ┌──────────┐                 │
   │infra/* │       │ evaluation│                │
   └───┬────┘       └────┬─────┘                 │
       │                 │                       │
       └────────┬────────┘                       │
                ▼                                │
           ┌──────────┐                          │
           │contracts │◄─────────────────────────┘
           └──────────┘
```

### 1.1 Strict ordering

`apps/*` → `agents/*` / `runtime` → `trace` / `evolution` / `evaluation` / `planning` / `reflection` / `context` / `skills` / `orchestrator` → `infra/*` → `contracts`.

The dependency direction is **strictly top-down**. No package in
`packages/` may depend on any package in `apps/` or on any package
in `agents/` (per ADR-0007 §三 "强约束").

## 2. Per-package edges

| Package | Depends on |
|---------|------------|
| `@z-assistant/contracts` | (none — leaf) |
| `@z-assistant/infra-errors`  | (none) |
| `@z-assistant/infra-cost`    | (none) |
| `@z-assistant/infra-storage` | (none) |
| `@z-assistant/infra-permission` | (none) |
| `@z-assistant/infra-config`  | (none) |
| `@z-assistant/trace`         | `contracts`, `infra-errors`, `infra-cost`, `infra-storage` |
| `@z-assistant/runtime`       | `contracts`, `infra-cost`, `infra-errors`, `infra-storage`, `trace` |
| `@z-assistant/agent-coding`  | `contracts`, `runtime` |
| `@z-assistant/agent-browser` | `contracts` |
| `@z-assistant/agent-office`  | `contracts` |
| `@z-assistant/agent-research`| `contracts` |
| `@z-assistant/app-vscode-connector` | `contracts`, `runtime` |
| `@z-assistant/app-cli`       | `contracts`, `runtime` |
| `@z-assistant/app-desktop`   | `contracts`, `runtime` |
| `extensions/coding-agent` (V1) | `contracts`, `runtime`, `infra-*`, `trace` |

## 3. ASCII dependency graph (workspace-internal)

```
                              ┌────────────────────────────┐
                              │   apps/*                   │
                              │   vscode-connector | cli   │
                              │   desktop                  │
                              └──────┬──────────┬──────────┘
                                     │          │
                ┌────────────────────┘          │
                │                               ▼
                ▼                  ┌────────────────────────┐
        ┌──────────────┐           │   agents/*             │
        │   runtime    │           │   coding | browser     │
        │              │           │   office | research    │
        └──┬─┬─┬─┬─┬─┬──┘           └────────────┬───────────┘
           │ │ │ │ │ │                          │
           │ │ │ │ │ │                          │
   ┌───────┘ │ │ │ │ └────────────┐             │
   │         │ │ │ │              │             │
   ▼         ▼ │ ▼ ▼              ▼             │
 trace  context evolution evaluation reflection planning skills
   │                                       ▲
   │                                       │
   ├─────────────┬─────────────┬────────────┘
   ▼             ▼             ▼
 contracts   infra-cost   infra-errors  infra-storage  infra-permission  infra-config
```

### 3.1 Cross-layer verification

* **`runtime` → `trace`** — runtime composes orchestrator + the six
  framework subpackages; it depends on `trace` for Run/Span APIs.
* **`runtime` → `infra-*`** — uses `infra-cost` for budget math,
  `infra-errors` for error classification, `infra-storage` for the
  shared Store. (`infra-permission` and `infra-config` are pulled
  transitively by V1 callers, not by `runtime` itself — a future
  refactor will lift them into runtime's surface.)
* **`agents/*` → `runtime`** — Coding adapter imports `IPlanner`,
  `Plan`, `PlanResult` and uses `ContextChunk` from
  `@z-assistant/runtime`. The other three agent packages are
  placeholders for future phases.
* **`apps/*` → `runtime`** — connectors and CLI consume the runtime
  facade; no app imports another app.

## 4. Forbidden / not-yet-implemented edges

The following would be **forbidden** per ADR-0007 §三:

* Any `packages/*` → `apps/*` (would invert the direction)
* Any `packages/*` → `agents/*` outside of `agents/coding-agent`'s
  framework layer (agent package cannot depend on another agent)
* Any `apps/*` → `apps/*` (apps are independent hosts)

The following are **declared but not yet used** in Phase 6A:

* `runtime` → `infra-permission` — V2 contract surface, not yet
  consumed; the V1 permission paths (`extensions/coding-agent/src/infra/permission`)
  are still the only caller.
* `runtime` → `infra-config` — same situation.

## 5. Verification commands

```powershell
# Print declared dependencies of every workspace package
node -e "
const fs = require('fs');
const path = require('path');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === 'package.json') out.push(p);
  }
  return out;
}
for (const p of walk('packages').concat(walk('apps'))) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log(p);
  console.log('  name:', j.name);
  console.log('  deps:', Object.keys(j.dependencies ?? {}).join(', ') || '(none)');
}
"
```

## 6. Test surface

| Package | Test command | Status |
|---------|--------------|--------|
| `@z-assistant/runtime`   | `npm test --prefix packages/runtime` | passing — 38 tests across orchestrator, evolution, evaluation |
| `@z-assistant/trace`     | `npm test --prefix packages/trace`   | passing |
| `extensions/coding-agent`| `npm test --prefix extensions/coding-agent` | passing |
| `@z-assistant/agent-coding` | n/a (Phase 6A stubs only) | n/a |

The integration test for `apps/*` and the cross-package
`runtime → agents/coding` integration is scheduled for R7 once the
agent adapters stop returning `3001` "stub" errors.
