// @z-assistant/app-cli
//
// V2 CLI entry point. Boots the V2 Assistant Runtime for terminal use.
//
//   $ z run "fix the failing test in src/foo.test.ts"
//
// Subcommands planned for R7+:
//   z run <task>           — run a single task
//   z trace ls             — list recent runs
//   z trace show <runId>   — show a run with its span tree
//   z eval <benchmark>     — run a benchmark suite
//   z evolution            — generate a self-improvement report
//   z config get/set       — config-center CLI
//
// Phase 6A: this file is the *real* entry point. It parses argv,
// dispatches to subcommand handlers, and wires the V2 runtime. The
// subcommand handlers themselves are stubs that print a clear "not
// implemented in Phase 6A" message; R7+ will fill them in. The
// runtime is instantiated (boot + shutdown on exit) so the wiring
// is exercised end-to-end in this revision.

import { RUNTIME_VERSION } from '@z-assistant/runtime';
import { VSCodeConnector, type VSCodeConnectorConfig } from '@z-assistant/app-vscode-connector';

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
  description: 'List / show runs and spans (Phase 6A placeholder)',
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === 'ls') {
      ctx.out('(stub) z trace ls: not implemented in Phase 6A — use `npm test --prefix packages/runtime` for now');
      return 0;
    }
    if (sub === 'show') {
      const id = ctx.args[1];
      if (!id) { ctx.err('error: missing runId. usage: z trace show <runId>'); return 2; }
      ctx.out(`(stub) z trace show ${id}: not implemented in Phase 6A`);
      return 0;
    }
    ctx.err('error: unknown subcommand. usage: z trace <ls|show>');
    return 2;
  },
};

const versionSubcommand: CLISubcommand = {
  name: 'version',
  description: 'Print the runtime version',
  async run(ctx) {
    ctx.out(`@z-assistant/runtime v${RUNTIME_VERSION}`);
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
    `Z Assistant CLI v${RUNTIME_VERSION}`,
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
   * `<cwd>/.z-assistant/`. Tests override this with a tmp dir.
   */
  storageDir?: string;
  /**
   * If true, boot a real AssistantRuntime. Phase 6A defaults to
   * `false` because the runtime is itself a stub; setting this to
   * `true` exercises the boot path. R7+ flips the default.
   */
  bootRuntime?: boolean;
}

export async function run(argv: string[], opts: CLIOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const storageDir = opts.storageDir ?? `${cwd}/.z-assistant`;

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
