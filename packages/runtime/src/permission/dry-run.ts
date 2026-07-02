// @ziner/runtime — Dry-run Executor (P1-2 HITL).
//
// Simulates tool execution without performing any side effects.
// When dry-run mode is enabled, the agent calls `simulate()` instead
// of the real `executeTool()`, so the user can preview the full plan
// before committing to real execution.
//
// The simulated result is a human-readable string describing what the
// tool *would* have done, formatted so the LLM can continue reasoning
// about the task as if the tool had run. This lets the agent produce
// a complete plan in dry-run mode, which the user can then approve
// for real execution.
//
// Usage:
//   const executor = new DryRunExecutor();
//   const result = await executor.simulate({ id, toolName: 'write_file', args: { path: '/foo.txt', content: 'hi' } });
//   // → "[dry-run] Would have written 2 bytes to /foo.txt"

import type { ToolInvocation } from '@ziner/contracts';

// ── Options ──────────────────────────────────────────────────────────

export interface DryRunExecutorOptions {
  /**
   * Optional: prefix for simulated results. Default '[dry-run]'.
   * The LLM sees this prefix so it knows the result is simulated.
   */
  prefix?: string;
  /**
   * Optional: callback fired before each simulation (for logging / audit).
   */
  onSimulate?: (invocation: ToolInvocation, simulation: string) => void;
}

// ── DryRunExecutor ───────────────────────────────────────────────────

/**
 * Simulates tool execution without side effects.
 *
 * Each `simulate()` call returns a string describing what the tool
 * would have done, prefixed with `[dry-run]` so the LLM and user can
 * distinguish simulated from real results.
 */
export class DryRunExecutor {
  private readonly prefix: string;
  private readonly onSimulate?: (invocation: ToolInvocation, simulation: string) => void;

  constructor(opts: DryRunExecutorOptions = {}) {
    this.prefix = opts.prefix ?? '[dry-run]';
    this.onSimulate = opts.onSimulate;
  }

  /**
   * Simulate a tool invocation. Returns a human-readable description
   * of what the tool would have done.
   */
  async simulate(invocation: ToolInvocation): Promise<string> {
    const desc = this.describe(invocation.toolName, invocation.args);
    const result = `${this.prefix} ${desc}`;
    this.onSimulate?.(invocation, result);
    return result;
  }

  /**
   * Generate a description of what the tool would do.
   * Public so the confirmation UI can reuse it for previews.
   */
  describe(toolName: string, args: Record<string, unknown>): string {
    const str = (k: string): string => String(args[k] ?? '');
    const num = (k: string): number | undefined => typeof args[k] === 'number' ? args[k] as number : undefined;

    switch (toolName) {
      // ── Web tools ──────────────────────────────────────────────
      case 'web_search':
        return `Would have searched the web for "${str('query')}" (max ${num('maxResults') ?? 5} results).`;
      case 'web_fetch':
        return `Would have fetched URL: ${str('url')} (max ${num('maxLength') ?? 5000} chars).`;

      // ── File tools ─────────────────────────────────────────────
      case 'read_file': {
        const path = str('filePath') || str('path');
        const start = num('startLine');
        const count = num('lineCount');
        const range = start ? ` (lines ${start}-${start + (count ?? 0) - 1})` : '';
        return `Would have read file: ${path}${range}.`;
      }
      case 'write_file': {
        const path = str('filePath') || str('path');
        const content = str('content');
        return `Would have written ${content.length} bytes to: ${path}.`;
      }
      case 'replace_text': {
        const path = str('filePath') || str('path');
        const oldText = str('oldText');
        const newText = str('newText');
        return `Would have replaced ${oldText.length} chars with ${newText.length} chars in: ${path}.`;
      }
      case 'append_text': {
        const path = str('filePath') || str('path');
        const content = str('content');
        return `Would have appended ${content.length} bytes to: ${path}.`;
      }
      case 'insert_text': {
        const path = str('filePath') || str('path');
        const anchor = str('anchorText');
        const mode = str('mode') || 'after';
        return `Would have inserted text ${mode} "${anchor.slice(0, 40)}" in: ${path}.`;
      }

      // ── Shell ──────────────────────────────────────────────────
      case 'run_terminal': {
        const cmd = str('command') || str('cmd');
        const cwd = str('cwd');
        return `Would have executed command: \`${cmd}\`${cwd ? ` in ${cwd}` : ''}.`;
      }

      // ── Search ─────────────────────────────────────────────────
      case 'search_code': {
        const pattern = str('pattern') || str('query');
        return `Would have searched code for "${pattern}" (max ${num('maxResults') ?? 20} results).`;
      }
      case 'list_directory': {
        const dir = str('dirPath') || '(current directory)';
        return `Would have listed directory: ${dir} (depth ${num('depth') ?? 1}).`;
      }
      case 'get_project_context':
        return `Would have retrieved project context (${str('detail') || 'summary'} mode).`;

      // ── Browser ────────────────────────────────────────────────
      case 'browser_navigate':
        return `Would have navigated browser to: ${str('url')}.`;
      case 'browser_click':
        return `Would have clicked at (${num('x') ?? 0}, ${num('y') ?? 0}).`;
      case 'browser_scroll':
        return `Would have scrolled ${str('direction') || 'down'} by ${num('amount') ?? 500}px.`;
      case 'browser_screenshot':
        return `Would have captured a browser screenshot.`;
      case 'browser_go_back':
        return `Would have navigated browser back.`;
      case 'browser_go_forward':
        return `Would have navigated browser forward.`;
      case 'browser_close':
        return `Would have closed the browser.`;

      // ── Perception ─────────────────────────────────────────────
      case 'ocr_image':
        return `Would have OCR'd image: ${str('filePath')}.`;
      case 'describe_image':
        return `Would have described image: ${str('filePath')}.`;
      case 'transcribe_audio':
        return `Would have transcribed audio: ${str('filePath')}.`;
      case 'parse_document':
        return `Would have parsed document: ${str('filePath')}.`;

      default:
        return `Would have invoked tool "${toolName}" with args: ${JSON.stringify(args).slice(0, 200)}.`;
    }
  }
}
