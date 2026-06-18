// Error Classifier — turns arbitrary thrown values into a structured
// `ErrorRef`-shaped object with a category code.
//
// The Trace layer (Phase 1) records these refs on failed Spans, and
// the Dashboard (Phase 4) aggregates by category.

import {
  ALL_ERROR_CODES,
  AgentErrorCode,
  LlmErrorCode,
  ToolErrorCode,
  UnknownErrorCode,
} from './error-codes';
import type { ErrorRef } from '@z-assistant/contracts';

/** Classification of an error. */
export type ErrorCategory =
  | 'llm'
  | 'tool'
  | 'agent'
  | 'sandbox'
  | 'config'
  | 'storage'
  | 'unknown';

const CATEGORY_PREFIX: Record<ErrorCategory, string> = {
  llm: '1',
  tool: '2',
  agent: '3',
  sandbox: '4',
  config: '5',
  storage: '6',
  unknown: '9',
};

export interface ClassifiedError extends ErrorRef {
  category: ErrorCategory;
  /** Original error name, e.g. "TypeError" */
  cause?: string;
}

/** Heuristic classifier. Add new mappings here as new error sources appear. */
export function classify(err: unknown): ClassifiedError {
  if (err == null) {
    return finalize({ code: UnknownErrorCode.Unexpected, message: 'null/undefined thrown' });
  }
  if (typeof err === 'string') {
    return finalize({ code: UnknownErrorCode.Unexpected, message: err, cause: 'String' });
  }

  const e = err as { name?: string; code?: string; message?: string; status?: number };
  const code = String(e.code ?? '');
  const message = String(e.message ?? 'unknown error');
  const cause = e.name;

  // 1. Already-classified codes pass through.
  if (ALL_ERROR_CODES.has(code)) {
    return finalize({ code, message, cause });
  }

  // 2. Heuristics for Node / VS Code / fetch errors.
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return finalize({ code: ToolErrorCode.NotFound, message, cause });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return finalize({ code: ToolErrorCode.PermissionDenied, message, cause });
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || e.name === 'TimeoutError') {
    return finalize({ code: ToolErrorCode.Timeout, message, cause });
  }
  if (code === 'ENOMEM') {
    return finalize({ code: AgentErrorCode.BudgetExceeded, message: 'out of memory', cause });
  }

  // 3. HTTP / fetch status codes
  if (typeof e.status === 'number') {
    if (e.status === 401 || e.status === 403) {
      return finalize({ code: LlmErrorCode.AuthFailed, message, cause: `HTTP ${e.status}` });
    }
    if (e.status === 404) {
      return finalize({ code: LlmErrorCode.ModelNotFound, message, cause: `HTTP ${e.status}` });
    }
    if (e.status === 429) {
      return finalize({ code: LlmErrorCode.RateLimit, message, cause: `HTTP ${e.status}` });
    }
    if (e.status >= 500) {
      return finalize({ code: LlmErrorCode.ProviderUnreachable, message, cause: `HTTP ${e.status}` });
    }
  }

  // 4. Fall back by message content
  if (/context (length|window|overflow|too long)/i.test(message)) {
    return finalize({ code: LlmErrorCode.ContextOverflow, message, cause });
  }
  if (/permission denied|EACCES/i.test(message)) {
    return finalize({ code: ToolErrorCode.PermissionDenied, message, cause });
  }
  if (/timeout|timed out/i.test(message)) {
    return finalize({ code: ToolErrorCode.Timeout, message, cause });
  }
  if (/budget|cost limit/i.test(message)) {
    return finalize({ code: AgentErrorCode.BudgetExceeded, message, cause });
  }

  return finalize({ code: UnknownErrorCode.Unexpected, message, cause });
}

function finalize(input: { code: string; message: string; cause?: string }): ClassifiedError {
  const category: ErrorCategory =
    (Object.keys(CATEGORY_PREFIX) as ErrorCategory[]).find(
      (k) => input.code.startsWith(CATEGORY_PREFIX[k])
    ) ?? 'unknown';
  return { ...input, category };
}

/** Convert classified error to plain ErrorRef (drop the internal category). */
export function toErrorRef(c: ClassifiedError): ErrorRef {
  return { code: c.code, message: c.message, stack: undefined };
}
