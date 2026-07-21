import type { PlanDag } from '@ziner/contracts';

export type CheckpointStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed';

export interface SubTaskResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string };
  agent: string;
  durationMs?: number;
  completedAt: number;
}

export interface Checkpoint {
  runId: string;
  task: string;
  mode: 'plan' | 'dag' | string;
  sessionId: string;
  planDag: PlanDag;
  completedSubTaskIds: string[];
  subtaskOutputs: Record<string, SubTaskResult>;
  sharedState: Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }>;
  plannerAgent: string;
  synthesizerAgent: string;
  routerSeed?: string[];
  createdAt: number;
  updatedAt: number;
  status: CheckpointStatus;
}

export interface CheckpointIndexEntry {
  runId: string;
  task: string;
  sessionId: string;
  status: CheckpointStatus;
  completedCount: number;
  totalCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(runId: string): Promise<Checkpoint | null>;
  delete(runId: string): Promise<void>;
  list(options?: { sessionId?: string; limit?: number }): Promise<CheckpointIndexEntry[]>;
  cleanup?(): Promise<{ removed: number }>;
}
