// Edit Transaction — binds multi-file edits, snapshots, verification, and rollback
// under a single transaction ID.
//
// Design goals (from PROJECT_ROADMAP §8.1):
// - Same-task file modifications share a transaction ID
// - Rollback by transaction, not scattered single-file ops
// - Verification results bind to the transaction
// - Conflict detection before applying

import { EditOperation } from '../agent/agent-core';
import { VerificationResult } from '../verifier/runtime-verifier';

// ── File Snapshot ─────────────────────────────────────────────────────

export interface FileSnapshot {
  /** Absolute path of the file */
  filePath: string;
  /** Whether the file existed before the edit */
  existed: boolean;
  /** Full content of the file before the edit (empty string if not existed) */
  content: string;
  /** Content hash for quick conflict detection */
  contentHash: string;
}

// ── Transaction Status ────────────────────────────────────────────────

export type TransactionStatus =
  | 'planned'     // Operations registered but not yet applied
  | 'applying'    // Currently applying operations
  | 'applied'     // All operations applied successfully
  | 'verifying'   // Running verification
  | 'verified'    // Verification passed
  | 'reverting'   // Currently reverting
  | 'reverted'    // Successfully reverted to pre-transaction state
  | 'failed'      // Application or verification failed
  | 'conflict';   // Conflict detected before apply

// ── Edit Transaction ──────────────────────────────────────────────────

export interface EditTransaction {
  /** Unique transaction ID */
  id: string;

  /** The task/sub-task ID this transaction belongs to */
  taskId: string;

  /** Timestamp when the transaction was created */
  createdAt: number;

  /** Current status */
  status: TransactionStatus;

  /** Edit operations in this transaction */
  operations: TrackedEditOperation[];

  /** File snapshots taken before applying (keyed by filePath) */
  snapshots: Map<string, FileSnapshot>;

  /** Verification results (if verification was run) */
  verificationResults?: VerificationResult[];

  /** Error message if status is 'failed' or 'conflict' */
  error?: string;
}

// ── Tracked Edit Operation ────────────────────────────────────────────

export interface TrackedEditOperation extends EditOperation {
  /** Status of this individual operation */
  status: 'pending' | 'applied' | 'failed' | 'reverted' | 'skipped';

  /** Error message if failed */
  error?: string;

  /** Content of the file after this operation was applied */
  modifiedContent?: string;
}

// ── Transaction Events ────────────────────────────────────────────────

export type TransactionEventType =
  | 'created'
  | 'applying'
  | 'applied'
  | 'verifying'
  | 'verified'
  | 'reverting'
  | 'reverted'
  | 'failed'
  | 'conflict'
  | 'operation_applied'
  | 'operation_failed';

export interface TransactionEvent {
  transactionId: string;
  type: TransactionEventType;
  timestamp: number;
  detail?: string;
}

// ── Utility ───────────────────────────────────────────────────────────

/**
 * Compute a simple hash of content for quick conflict detection.
 * Uses a fast non-cryptographic hash (FNV-1a inspired).
 */
export function computeContentHash(content: string): string {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // FNV prime, keep 32-bit
  }
  return hash.toString(16);
}

/**
 * Generate a unique transaction ID.
 */
export function generateTransactionId(): string {
  return `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
