// @ziner/app-cli
//
// V2 CLI entry point. Boots the V2 Assistant Runtime for terminal use.
//
//   $ z run "fix the failing test in src/foo.test.ts"
//   $ z trace ls               — list recent runs
//   $ z trace show <runId>     — show a run with its span tree
//   $ z version                — print runtime version
//
// Subcommands planned for future phases:
//   z eval <benchmark>     — run a benchmark suite
//   z evolution            — generate a self-improvement report
//   z config get/set       — config-center CLI
//
// This file is the *real* entry point. It parses argv, dispatches to
// subcommand handlers, and wires the V2 runtime. `run` / `trace` /
// `version` / `help` are fully implemented; `eval` / `evolution` /
// `config` are future work.

import { RUNTIME_VERSION } from '@ziner/runtime';
import { listRunSummaries, listSpanNodes, type SpanNode } from '@ziner/trace';
import { VSCodeConnector, type VSCodeConnectorConfig } from '@ziner/app-vscode-connector';

// ── Subcommand surface ────────────────────────────────────────────────

export interface CLIContext {
  args: string[];
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  runtime: VSCodeConnector;
}

export type CLISubcommand = {
  name: string;
  description: string;
  run: (ctx: CLIContext) => Promise<number>;
};

// ── Built-in subcommands (Phase 6A placeholders) ──────────────────────

const runSubcommand: CLISubcommand = {
  name: 'run',
  description: 'Run a single task via the V2 runtime',
  async run(ctx) {
    const task = ctx.args.join(' ').trim();
    if (!task) {
      ctx.err('error: missing task. usage: z run <task>');
      return 2;
    }
    const { runId } = await ctx.runtime.runTask(task, 'cli');
    ctx.out(`runId=${runId}`);
    return 0;
  },
};

const traceSubcommand: CLISubcommand = {
  name: 'trace',
  description: 'List / show runs and spans',
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === 'ls') {
      return await traceList(ctx);
    }
    if (sub === 'show') {
      const id = ctx.args[1];
      if (!id) { ctx.err('error: missing runId. usage: z trace show <runId>'); return 2; }
      return await traceShow(ctx, id);
    }
    ctx.err('error: unknown subcommand. usage: z trace <ls|show>');
    return 2;
  },
};

// ── trace ls — list recent runs ───────────────────────────────────────

async function traceList(ctx: CLIContext): Promise<number> {
  const store = ctx.runtime.store();
  if (!store) {
    ctx.err('error: runtime store not available (boot failed?)');
    return 1;
  }
  const summaries = await listRunSummaries(store, { limit: 20 });
  if (summaries.length === 0) {
    ctx.out('No runs found.');
    return 0;
  }
  // Table header
  ctx.out(formatRow(['RUN ID', 'STATUS', 'DURATION', 'SPANS', 'TOKENS', 'COST', 'TASK']));
  ctx.out(formatRow(['─'.repeat(20), '─'.repeat(8), '─'.repeat(10), '─'.repeat(6), '─'.repeat(10), '─'.repeat(8), '─'.repeat(30)]));
  for (const s of summaries) {
    ctx.out(formatRow([
      s.id.slice(0, 20),
      s.status,
      s.duration != null ? formatDuration(s.duration) : '-',
      String(s.spanCount),
      formatTokens(s.totalTokensIn + s.totalTokensOut),
      s.totalCostUsd > 0 ? `$${s.totalCostUsd.toFixed(4)}` : '-',
      truncate(s.task, 30),
    ]));
  }
  ctx.out(`\n${summaries.length} run(s) listed (limit 20).`);
  return 0;
}

// ── trace show <runId> — show span tree ───────────────────────────────

async function traceShow(ctx: CLIContext, runId: string): Promise<number> {
  const store = ctx.runtime.store();
  if (!store) {
    ctx.err('error: runtime store not available (boot failed?)');
    return 1;
  }
  const summaries = await listRunSummaries(store, { limit: 1000 });
  const run = summaries.find((s) => s.id === runId);
  if (!run) {
    ctx.err(`error: run '${runId}' not found`);
    return 1;
  }
  // Run summary
  ctx.out(`Run: ${run.id}`);
  ctx.out(`  Task:    ${run.task}`);
  ctx.out(`  Model:   ${run.model.provider}/${run.model.name}`);
  ctx.out(`  Status:  ${run.status}`);
  ctx.out(`  Start:   ${new Date(run.startTime).toISOString()}`);
  if (run.endTime) {
    ctx.out(`  End:     ${new Date(run.endTime).toISOString()}`);
  }
  if (run.duration != null) {
    ctx.out(`  Duration: ${formatDuration(run.duration)}`);
  }
  ctx.out(`  Tokens:  ${formatTokens(run.totalTokensIn)} in / ${formatTokens(run.totalTokensOut)} out`);
  if (run.totalCostUsd > 0) {
    ctx.out(`  Cost:    $${run.totalCostUsd.toFixed(4)}`);
  }
  ctx.out(`  Spans:   ${run.spanCount} (${run.errorSpanCount} error)`);

  // Span tree
  const nodes = await listSpanNodes(store, runId);
  if (nodes.length === 0) {
    ctx.out('\nNo spans recorded.');
    return 0;
  }
  ctx.out('\nSpan tree:');
  const byId = new Map<string, SpanNode>(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string | undefined, SpanNode[]>();
  for (const n of nodes) {
    const key = n.parentSpanId;
    const arr = childrenOf.get(key) ?? [];
    arr.push(n);
    childrenOf.set(key, arr);
  }
  const roots = childrenOf.get(undefined) ?? [];
  for (const root of roots) {
    printSpanTree(ctx, root, byId, childrenOf, 0);
  }
  return 0;
}

function printSpanTree(
  ctx: CLIContext,
  node: SpanNode,
  byId: Map<string, SpanNode>,
  childrenOf: Map<string | undefined, SpanNode[]>,
  depth: number,
): void {
  const indent = '  '.repeat(depth);
  const prefix = depth === 0 ? '' : '├─ ';
  const dur = node.duration != null ? ` (${formatDuration(node.duration)})` : '';
  const status = node.hasError ? ' ✗' : '';
  const tokens = (node.tokensIn || node.tokensOut) ? ` [${formatTokens(node.tokensIn ?? 0)}+${formatTokens(node.tokensOut ?? 0)}]` : '';
  ctx.out(`${indent}${prefix}${node.name} [${node.type}]${dur}${tokens}${status}`);
  const kids = childrenOf.get(node.id) ?? [];
  for (const k of kids) {
    printSpanTree(ctx, k, byId, childrenOf, depth + 1);
  }
}

// ── Formatting helpers ────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function formatRow(cols: string[]): string {
  return cols.join('  ');
}

const versionSubcommand: CLISubcommand = {
  name: 'version',
  description: 'Print the runtime version',
  async run(ctx) {
    ctx.out(`@ziner/runtime v${RUNTIME_VERSION}`);
    return 0;
  },
};

const helpSubcommand: CLISubcommand = {
  name: 'help',
  description: 'Print this help message',
  async run(ctx) {
    ctx.out(usage());
    return 0;
  },
};

const subcommands: CLISubcommand[] = [
  runSubcommand,
  traceSubcommand,
  versionSubcommand,
  helpSubcommand,
];

// ── argv parsing ──────────────────────────────────────────────────────

function parseArgv(argv: string[]): { cmd: string; rest: string[] } {
  if (argv.length === 0) return { cmd: 'help', rest: [] };
  return { cmd: argv[0], rest: argv.slice(1) };
}

function usage(): string {
  const lines = [
    `Ziner CLI v${RUNTIME_VERSION}`,
    '',
    'Usage: z <command> [args]',
    '',
    'Commands:',
  ];
  for (const s of subcommands) {
    lines.push(`  ${s.name.padEnd(10)}  ${s.description}`);
  }
  return lines.join('\n');
}

// ── Public entry: run(argv, opts?) → exit code ───────────────────────

export interface CLIOptions {
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /**
   * Storage directory for the V2 runtime. Defaults to
   * `<cwd>/.ziner/`. Tests override this with a tmp dir.
   */
  storageDir?: string;
  /**
   * If true, boot a real AssistantRuntime. Defaults to true so trace
   * subcommands can access the Store. Tests may set this to false to
   * skip the boot path.
   */
  bootRuntime?: boolean;
}

export async function run(argv: string[], opts: CLIOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const storageDir = opts.storageDir ?? `${cwd}/.ziner`;

  const { cmd, rest } = parseArgv(argv);
  const handler = subcommands.find((s) => s.name === cmd);
  if (!handler) {
    err(`error: unknown command '${cmd}'`);
    err(usage());
    return 2;
  }

  const config: VSCodeConnectorConfig = { storageDir, projectKey: 'cli' };
  const runtime = new VSCodeConnector(config);
  if (opts.bootRuntime !== false) {
    try { await runtime.start(); } catch (e) {
      err(`error: failed to boot V2 runtime: ${(e as Error).message}`);
      return 1;
    }
  }

  const ctx: CLIContext = { args: rest, cwd, out, err, runtime };
  try {
    return await handler.run(ctx);
  } finally {
    try { await runtime.stop(); } catch { /* ignore */ }
  }
}

// ── Direct process entry (used by `z` bin) ───────────────────────────

// `require.main === module` only fires in CJS, but the bin doesn't
// depend on the value — we just need a side-effecting invocation.
// In ESM mode, the user would import `run` directly.
declare const require: { main?: { filename?: string } };
if (typeof require !== 'undefined' && require.main && require.main.filename === __filename) {
  void run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(e); process.exit(1); },
  );
}
