# V1 `contracts/` — MIGRATED in R3

**Phase 6A R3 (2026-06-17)**: V1 contract types (`run`, `agent`, `eval`, `config`) and their tests have been moved to V2 package [`@ziner/contracts`](../../../../packages/contracts/).

This directory now contains **only** the V1 re-export shim:

```
src/contracts/
└── index.ts    →  re-exports from '@ziner/contracts'
```

V1 consumers continue to work via:
```typescript
import { AgentRun, IAgent, Benchmark, ConfigSpec } from '../contracts';
```

The shim will be removed in R10 once V1 has fully migrated to the new path alias.
