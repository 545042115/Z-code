// Edit Transaction Manager — manages the lifecycle of edit transactions.
//
// Responsibilities:
// 1. Create transactions from EditOperation[]
// 2. Capture file snapshots before applying
// 3. Apply operations with conflict detection
// 4. Bind verification results to transactions
// 5. Revert entire transactions (all files at once)
// 6. Emit events for UI updates

import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEngine } from '../utils/diff-engine';
import { EditOperation } from '../agent/agent-core';
import { VerificationResult } from '../verifier/runtime-verifier';
import {
  EditTransaction,
  TrackedEditOperation,
  FileSnapshot,
  TransactionStatus,
  TransactionEvent,
  TransactionEventType,
  computeContentHash,
  generateTransactionId,
} from './edit-transaction';

export class EditTransactionManager {
  private transactions: Map<string, EditTransaction> = new Map();
  private diffEngine: DiffEngine;
  private eventListeners: ((event: TransactionEvent) => void)[] = [];

  constructor(diffEngine: DiffEngine) {
    this.diffEngine = diffEngine;
  }

  // ── Event System ──────────────────────────────────────────────────

  onEvent(listener: (event: TransactionEvent) => void): void {
    this.eventListeners.push(listener);
  }

  private emit(type: TransactionEventType, transactionId: string, detail?: string): void {
    const event: TransactionEvent = {
      transactionId,
      type,
      timestamp: Date.now(),
      detail,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[EditTransactionManager] Event listener error:', err);
      }
    }
  }

  // ── Transaction Creation ──────────────────────────────────────────

  /**
   * Create a new transaction from a list of EditOperations.
   * The transaction starts in 'planned' status.
   */
  createTransaction(ops: EditOperation[], taskId?: string): EditTransaction {
    const id = generateTransactionId();
    const trackedOps: TrackedEditOperation[] = ops.map(op => ({
      ...op,
      status: 'pending',
    }));

    const txn: EditTransaction = {
      id,
      taskId: taskId || id,
      createdAt: Date.now(),
      status: 'planned',
      operations: trackedOps,
      snapshots: new Map(),
    };

    this.transactions.set(id, txn);
    this.emit('created', id);
    return txn;
  }

  // ── Snapshot Capture ──────────────────────────────────────────────

  /**
   * Capture file snapshots for all files involved in the transaction.
   * Must be called before apply(). If snapshots already exist for a file,
   * they are not re-captured (preserving the earliest state).
   */
  async captureSnapshots(txnId: string): Promise<void> {
    const txn = this.getTxn(txnId);
    if (!txn) return;

    const uniquePaths = new Set(txn.operations.map(op => op.path));
    for (const filePath of uniquePaths) {
      if (txn.snapshots.has(filePath)) continue; // Already captured

      const snapshot = await this.captureFileSnapshot(filePath);
      txn.snapshots.set(filePath, snapshot);
    }
  }

  /**
   * Capture a snapshot of a single file.
   */
  private async captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
    const resolvedPath = this.resolveWorkspacePath(filePath);
    try {
      const uri = vscode.Uri.file(resolvedPath);
      let stat: vscode.FileStat | undefined;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        stat = undefined;
      }
      if (!stat) {
        return { filePath, existed: false, content: '', contentHash: computeContentHash('') };
      }
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8').decode(contentBytes);
      return { filePath, existed: true, content, contentHash: computeContentHash(content) };
    } catch {
      return { filePath, existed: false, content: '', contentHash: computeContentHash('') };
    }
  }

  // ── Conflict Detection ────────────────────────────────────────────

  /**
   * Check if any file has been modified since the snapshot was taken.
   * Returns a list of conflicted file paths.
   */
  async detectConflicts(txnId: string): Promise<string[]> {
    const txn = this.getTxn(txnId);
    if (!txn) return [];

    const conflicts: string[] = [];
    for (const [filePath, snapshot] of txn.snapshots) {
      const current = await this.captureFileSnapshot(filePath);
      // If the file didn't exist before but now exists, or hash changed
      if (snapshot.existed !== current.existed || snapshot.contentHash !== current.contentHash) {
        conflicts.push(filePath);
      }
    }
    return conflicts;
  }

  // ── Apply ─────────────────────────────────────────────────────────

  /**
   * Apply all operations in the transaction.
   * 1. Captures snapshots if not already done
   * 2. Checks for conflicts
   * 3. Applies each operation via DiffEngine
   * 4. Updates transaction status
   */
  async apply(txnId: string): Promise<{ success: boolean; failedOps: TrackedEditOperation[]; conflicts?: string[] }> {
    const txn = this.getTxn(txnId);
    if (!txn) return { success: false, failedOps: [], conflicts: [] };

    // Capture snapshots if not already done
    await this.captureSnapshots(txnId);

    // Check for conflicts
    const conflicts = await this.detectConflicts(txnId);
    if (conflicts.length > 0) {
      txn.status = 'conflict';
      txn.error = `Files modified since transaction was created: ${conflicts.join(', ')}`;
      this.emit('conflict', txnId, txn.error);
      return { success: false, failedOps: [], conflicts };
    }

    // Apply operations
    txn.status = 'applying';
    this.emit('applying', txnId);

    const failedOps: TrackedEditOperation[] = [];
    for (const op of txn.operations) {
      if (op.status === 'applied') continue; // Skip already applied

      try {
        const success = await this.diffEngine.applyEdit(op);
        if (success) {
          op.status = 'applied';
          this.emit('operation_applied', txnId, op.path);
        } else {
          op.status = 'failed';
          op.error = 'DiffEngine.applyEdit returned false';
          failedOps.push(op);
          this.emit('operation_failed', txnId, `${op.path}: ${op.error}`);
        }
      } catch (err) {
        op.status = 'failed';
        op.error = String(err);
        failedOps.push(op);
        this.emit('operation_failed', txnId, `${op.path}: ${op.error}`);
      }
    }

    if (failedOps.length === 0) {
      txn.status = 'applied';
      this.emit('applied', txnId);
    } else {
      txn.status = 'failed';
      txn.error = `${failedOps.length}/${txn.operations.length} operations failed`;
      this.emit('failed', txnId, txn.error);
    }

    return { success: failedOps.length === 0, failedOps };
  }

  // ── Verification ──────────────────────────────────────────────────

  /**
   * Bind verification results to the transaction.
   */
  setVerificationResults(txnId: string, results: VerificationResult[]): void {
    const txn = this.getTxn(txnId);
    if (!txn) return;

    txn.verificationResults = results;
    const allPassed = results.every(r => r.passed || r.skipped);

    if (txn.status === 'applied') {
      txn.status = allPassed ? 'verified' : 'failed';
      if (!allPassed) {
        txn.error = `Verification failed: ${results.filter(r => !r.passed && !r.skipped).length} checks failed`;
      }
      this.emit(allPassed ? 'verified' : 'failed', txnId, txn.error);
    }
  }

  // ── Revert ────────────────────────────────────────────────────────

  /**
   * Revert the entire transaction by restoring all file snapshots.
   */
  async revert(txnId: string): Promise<{ success: boolean; failedFiles: string[] }> {
    const txn = this.getTxn(txnId);
    if (!txn) return { success: false, failedFiles: [] };

    txn.status = 'reverting';
    this.emit('reverting', txnId);

    const failedFiles: string[] = [];

    // Restore each unique file from its snapshot
    for (const [filePath, snapshot] of txn.snapshots) {
      try {
        await this.restoreFileSnapshot(filePath, snapshot);
      } catch (err) {
        failedFiles.push(filePath);
        console.warn(`[EditTransactionManager] Failed to revert ${filePath}:`, err);
      }
    }

    // Update operation statuses
    for (const op of txn.operations) {
      if (op.status === 'applied') {
        op.status = failedFiles.includes(op.path) ? 'failed' : 'reverted';
      }
    }

    if (failedFiles.length === 0) {
      txn.status = 'reverted';
      this.emit('reverted', txnId);
    } else {
      txn.status = 'failed';
      txn.error = `Revert failed for files: ${failedFiles.join(', ')}`;
      this.emit('failed', txnId, txn.error);
    }

    return { success: failedFiles.length === 0, failedFiles };
  }

  /**
   * Restore a single file from its snapshot.
   */
  private async restoreFileSnapshot(filePath: string, snapshot: FileSnapshot): Promise<void> {
    const resolvedPath = this.resolveWorkspacePath(filePath);
    const uri = vscode.Uri.file(resolvedPath);

    if (!snapshot.existed) {
      // File didn't exist before — delete it
      await vscode.workspace.fs.delete(uri, { recursive: false });
    } else {
      // File existed — write back original content
      const dir = path.dirname(resolvedPath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(snapshot.content));

      // Verify content
      const restored = await vscode.workspace.fs.readFile(uri);
      const restoredContent = new TextDecoder('utf-8').decode(restored);
      if (restoredContent !== snapshot.content) {
        throw new Error(`Restored content verification failed for ${filePath}`);
      }
    }
  }

  // ── Query ─────────────────────────────────────────────────────────

  /**
   * Get a transaction by ID.
   */
  getTransaction(txnId: string): EditTransaction | undefined {
    return this.transactions.get(txnId);
  }

  /**
   * Get all transactions.
   */
  getAllTransactions(): EditTransaction[] {
    return Array.from(this.transactions.values());
  }

  /**
   * Get the most recent transaction for a given task.
   */
  getTransactionByTask(taskId: string): EditTransaction | undefined {
    const txns = Array.from(this.transactions.values())
      .filter(t => t.taskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return txns[0];
  }

  /**
   * Get all file paths modified in a transaction.
   */
  getModifiedFiles(txnId: string): string[] {
    const txn = this.getTxn(txnId);
    if (!txn) return [];
    return [...new Set(txn.operations.filter(op => op.status === 'applied').map(op => op.path))];
  }

  /**
   * Get snapshot for a specific file in a transaction.
   */
  getFileSnapshot(txnId: string, filePath: string): FileSnapshot | undefined {
    const txn = this.getTxn(txnId);
    if (!txn) return undefined;
    return txn.snapshots.get(filePath);
  }

  /**
   * Clear all transactions (for cleanup).
   */
  clear(): void {
    this.transactions.clear();
  }

  // ── Internal Helpers ──────────────────────────────────────────────

  private getTxn(txnId: string): EditTransaction | undefined {
    const txn = this.transactions.get(txnId);
    if (!txn) {
      console.warn(`[EditTransactionManager] Transaction not found: ${txnId}`);
    }
    return txn;
  }

  /**
   * Resolve a possibly relative path to an absolute workspace path.
   */
  private resolveWorkspacePath(filePath: string): string {
    // If already absolute, return as-is
    if (path.isAbsolute(filePath)) {
      // Handle Windows Git Bash style paths like /c/Users/...
      if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(filePath)) {
        return filePath.slice(1).replace(/\//g, '\\');
      }
      return filePath;
    }

    // Resolve relative to first workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return path.resolve(workspaceFolders[0].uri.fsPath, filePath);
    }

    return path.resolve(filePath);
  }
}
