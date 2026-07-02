// Delegation Protocol — inter-agent task delegation via SharedState.
//
// Allows one agent to request help from another agent during execution.
// The requesting agent writes a delegation request to SharedState, and
// a coordinator (or the next agent in the pipeline) picks it up.
//
// SharedState keys:
//   delegation.<targetAgent>.request  — { id, task, context, from }
//   delegation.<targetAgent>.response — { id, result, error }
//   delegation.<targetAgent>.status   — 'pending' | 'running' | 'done' | 'failed'

import type { SharedState } from '@ziner/contracts';

export interface DelegationRequest {
  /** Unique delegation id (uuid). */
  id: string;
  /** Which agent should handle this. */
  targetAgent: string;
  /** The task description for the target agent. */
  task: string;
  /** Optional context (URLs, data, etc.). */
  context?: Record<string, unknown>;
  /** Which agent is requesting. */
  from: string;
  /** When the request was created. */
  createdAt: number;
}

export interface DelegationResponse {
  /** Matches the request id. */
  id: string;
  /** Result content (markdown or structured text). */
  result?: string;
  /** Optional structured data. */
  data?: Record<string, unknown>;
  /** Error message if failed. */
  error?: string;
  /** When the response was produced. */
  completedAt: number;
}

export type DelegationStatus = 'pending' | 'running' | 'done' | 'failed';

const PREFIX = 'delegation.';

/**
 * Write a delegation request to SharedState.
 * Returns the delegation id.
 */
export function requestDelegation(
  state: SharedState,
  targetAgent: string,
  task: string,
  from: string,
  context?: Record<string, unknown>,
): string {
  const id = `${from}->${targetAgent}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const req: DelegationRequest = {
    id,
    targetAgent,
    task,
    context,
    from,
    createdAt: Date.now(),
  };
  state.set(`${PREFIX}${targetAgent}.request`, req, from);
  state.set(`${PREFIX}${targetAgent}.status`, 'pending' as DelegationStatus, from);
  return id;
}

/**
 * Check if there's a pending delegation request for a given agent.
 */
export function getDelegationRequest(
  state: SharedState,
  targetAgent: string,
): DelegationRequest | undefined {
  return state.get<DelegationRequest>(`${PREFIX}${targetAgent}.request`);
}

/**
 * Mark a delegation as running.
 */
export function markDelegationRunning(
  state: SharedState,
  targetAgent: string,
  by: string,
): void {
  state.set(`${PREFIX}${targetAgent}.status`, 'running' as DelegationStatus, by);
}

/**
 * Complete a delegation with a result.
 */
export function completeDelegation(
  state: SharedState,
  targetAgent: string,
  result: string,
  by: string,
  data?: Record<string, unknown>,
): void {
  const req = state.get<DelegationRequest>(`${PREFIX}${targetAgent}.request`);
  const resp: DelegationResponse = {
    id: req?.id ?? 'unknown',
    result,
    data,
    completedAt: Date.now(),
  };
  state.set(`${PREFIX}${targetAgent}.response`, resp, by);
  state.set(`${PREFIX}${targetAgent}.status`, 'done' as DelegationStatus, by);
}

/**
 * Fail a delegation.
 */
export function failDelegation(
  state: SharedState,
  targetAgent: string,
  error: string,
  by: string,
): void {
  const req = state.get<DelegationRequest>(`${PREFIX}${targetAgent}.request`);
  const resp: DelegationResponse = {
    id: req?.id ?? 'unknown',
    error,
    completedAt: Date.now(),
  };
  state.set(`${PREFIX}${targetAgent}.response`, resp, by);
  state.set(`${PREFIX}${targetAgent}.status`, 'failed' as DelegationStatus, by);
}

/**
 * Wait for a delegation to complete (polling-based).
 * Used by the requesting agent to block until the result is ready.
 */
export async function waitForDelegation(
  state: SharedState,
  targetAgent: string,
  timeoutMs = 60_000,
  pollMs = 500,
): Promise<DelegationResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = state.get<DelegationStatus>(`${PREFIX}${targetAgent}.status`);
    if (status === 'done') {
      const resp = state.get<DelegationResponse>(`${PREFIX}${targetAgent}.response`);
      return resp ?? { id: '', completedAt: Date.now() };
    }
    if (status === 'failed') {
      const resp = state.get<DelegationResponse>(`${PREFIX}${targetAgent}.response`);
      throw new Error(resp?.error ?? 'Delegation failed');
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Delegation to ${targetAgent} timed out after ${timeoutMs}ms`);
}
