# @ziner/agent-coding

Thin V2 adapter that bridges V1 Coding Agent (`extensions/coding-agent/src/agent/`) into the V2 Assistant Runtime. Provides the implementation points for V2 generic interfaces (IAgent, IPlanner, IReflectionEngine, IContextProvider, ISkillRegistry, IToolRegistry, IVerifier) by delegating to V1.

**No Coding business logic is re-implemented here** — it lives in V1.
