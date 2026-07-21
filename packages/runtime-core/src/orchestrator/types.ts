import type { AgentResult, ErrorRef, ModelRef, RunStatus } from '@ziner/contracts';
import type { Checkpoint, CheckpointStore } from './checkpoint';

export type OrchestratorMode = 'dag' | 'plan';

export type PlanEventName = 'plan.dag' | 'plan.subtask.started' | 'plan.subtask.completed' | 'plan.subtask.fallback';

export interface PlanEvent {
  name: PlanEventName;
  data: Record<string, unknown>;
}

export interface RecentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlanSubTaskView {
  id: string;
  title: string;
  assignedTo: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface SharedStateSnapshotEntry {
  value: unknown;
  version: number;
  updatedAt: number;
  writer?: string;
}

export type SharedStateSnapshot = Record<string, SharedStateSnapshotEntry>;

export interface CoreOrchestratorOptions {
  task: string;
  model: ModelRef;
  sessionId: string;
  userId?: string;
  mode?: OrchestratorMode;
  maxAgentCalls?: number;
  initialState?: Record<string, unknown>;
  agents?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  signal?: AbortSignal;
  plannerAgent?: string;
  synthesizerAgent?: string;
  onPlanEvent?: (event: PlanEvent) => void;
  loadRecentMessages?: (sessionId: string, limit: number) => Promise<RecentMessage[]>;
  recentMessagesLimit?: number;
  routerSeed?: string[];
  checkpointManager?: CheckpointStore;
  resumeFrom?: Checkpoint;
  resumeFromRunId?: string;
}

export interface OrchestratorResult {
  status: RunStatus;
  outputs: AgentResult[];
  sharedStateSnapshot: SharedStateSnapshot;
  error?: ErrorRef;
}
