// CodingAgentLoopAdapter — Wires the 6 Coding sub-adapters into a
// single IAgent for the V2 Orchestrator.
//
// Per ADR-001 §4.5 this is the V2 ↔ V1 bridge:
//
//   packages/agents/coding-agent/src/agent-core.ts     (CodingAgent)
//   packages/agents/coding-agent/src/planner.ts        (CodingPlanner)
//   packages/agents/coding-agent/src/reflection.ts     (CodingReflectionEngine)
//   packages/agents/coding-agent/src/context.ts        (CodingContextProvider)
//   packages/agents/coding-agent/src/skills.ts         (CodingSkillRegistry)
//   packages/agents/coding-agent/src/tools.ts          (CodingToolRegistry)
//   packages/agents/coding-agent/src/verifier.ts       (CodingVerifier)
//            │
//            ▼
//   packages/agents/coding-agent/src/agent-loop-adapter.ts  (this file)
//            │
//            ▼
//   V2 Orchestrator (packages/runtime/src/orchestrator/)
//
// `CodingAgentLoop` is the composite returned to the Orchestrator;
// it implements `IAgent` AND exposes the sub-adapters for
// inspector / dashboard use.

import type { IAgent } from '@ziner/contracts';
import { CodingAgent, type CodingAgentOptions } from './agent-core';
import { CodingPlanner, type CodingPlannerOptions } from './planner';
import { CodingReflectionEngine, type CodingReflectionOptions } from './reflection';
import { CodingContextProvider, type CodingContextOptions } from './context';
import { CodingSkillRegistry, type CodingSkillOptions } from './skills';
import { CodingToolRegistry, type CodingToolOptions } from './tools';
import { CodingVerifier, type CodingVerifierOptions } from './verifier';

export interface CodingAgentLoopOptions {
  agent?: CodingAgentOptions;
  planner?: CodingPlannerOptions;
  reflection?: CodingReflectionOptions;
  context?: CodingContextOptions;
  skills?: CodingSkillOptions;
  tools?: CodingToolOptions;
  verifier?: CodingVerifierOptions;
}

export class CodingAgentLoop {
  readonly agent: CodingAgent;
  readonly planner: CodingPlanner;
  readonly reflection: CodingReflectionEngine;
  readonly context: CodingContextProvider;
  readonly skills: CodingSkillRegistry;
  readonly tools: CodingToolRegistry;
  readonly verifier: CodingVerifier;

  constructor(opts: CodingAgentLoopOptions = {}) {
    this.context = new CodingContextProvider(opts.context);
    this.skills = new CodingSkillRegistry(opts.skills);
    this.tools = new CodingToolRegistry(opts.tools);
    this.verifier = new CodingVerifier(opts.verifier);
    this.planner = new CodingPlanner(opts.planner);
    this.reflection = new CodingReflectionEngine(opts.reflection);
    this.agent = new CodingAgent(opts.agent);
  }

  /** Hand the agent to the V2 Orchestrator. */
  asIAgent(): IAgent {
    return this.agent;
  }
}

/** Convenience factory. */
export function createCodingAgentLoop(opts: CodingAgentLoopOptions = {}): CodingAgentLoop {
  return new CodingAgentLoop(opts);
}
