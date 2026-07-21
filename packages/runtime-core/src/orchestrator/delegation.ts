import type { SharedState } from '@ziner/contracts';

export interface DelegationRequest {
  id: string;
  targetAgent: string;
  task: string;
  context?: Record<string, unknown>;
  from: string;
  createdAt: number;
}

export interface DelegationResponse {
  id: string;
  result?: string;
  data?: Record<string, unknown>;
  error?: string;
  completedAt: number;
}

export type DelegationStatus = 'pending' | 'running' | 'done' | 'failed';

const PREFIX = 'delegation.';

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

export function getDelegationRequest(
  state: SharedState,
  targetAgent: string,
): DelegationRequest | undefined {
  return state.get<DelegationRequest>(`${PREFIX}${targetAgent}.request`);
}

export function markDelegationRunning(
  state: SharedState,
  targetAgent: string,
  by: string,
): void {
  state.set(`${PREFIX}${targetAgent}.status`, 'running' as DelegationStatus, by);
}

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
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Delegation to ${targetAgent} timed out after ${timeoutMs}ms`);
}
