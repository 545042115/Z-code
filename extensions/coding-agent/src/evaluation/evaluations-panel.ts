// EvaluationsPanel — list + filter + compare benchmark evaluations
// against saved Baselines, plus a 7-day metric dashboard.
//
// Mirrors the TracePanel architecture: Webview + IPC + QueryService.
// Phase 4 surface:
//   - Per-benchmark pass rate, avg score, Pass@1 / Pass@3
//   - 7-day rolling dashboard (Success Rate, Avg Runtime, Avg Cost, Top Tools)
//   - Save current evaluations as a Baseline
//   - Side-by-side delta vs a selected Baseline
//   - Per-candidate score trend chart

import * as vscode from 'vscode';
import type { TraceManager } from '../trace';
import type {
  Evaluation,
  Benchmark,
  Baseline,
  EvaluationAggregate,
  EvaluationDelta,
} from '../contracts';
import type { QueryService } from '../trace-ui/query-service';

interface BaselineComparison {
  baseline: EvaluationAggregate;
  current: EvaluationAggregate;
  deltas: EvaluationDelta[];
  baselineName: string;
}

interface DashboardSnapshot {
  windowMs: number;
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  topTools: Array<{ name: string; count: number }>;
  topSkills: Array<{ name: string; count: number }>;
}

export class EvaluationsPanel {
  public static currentPanel: EvaluationsPanel | undefined;

  public static createOrShow(extensionUri: vscode.Uri, mgr: TraceManager): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;
    if (EvaluationsPanel.currentPanel) {
      EvaluationsPanel.currentPanel._panel.reveal(column);
      void EvaluationsPanel.currentPanel._refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'zEvaluations',
      'Z Evaluations',
      column ?? vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    EvaluationsPanel.currentPanel = new EvaluationsPanel(panel, extensionUri, mgr);
  }

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _mgr: TraceManager;
  private _query: QueryService;

  private constructor(panel: vscode.WebviewPanel, _uri: vscode.Uri, mgr: TraceManager) {
    this._panel = panel;
    this._mgr = mgr;
    this._query = mgr.getQueryService();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables,
    );
    void this._refresh();
  }

  public dispose(): void {
    EvaluationsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      try { d?.dispose(); } catch { /* ignore */ }
    }
  }

  private async _refresh(): Promise<void> {
    let evals: Evaluation[] = [];
    let benchmarks: Benchmark[] = [];
    let baselines: Baseline[] = [];
    let passRate = 0;
    let trend: Array<{ timestamp: number; total: number; pass: boolean }> = [];
    let dashboard: DashboardSnapshot = {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      totalRuns: 0,
      successRate: 0,
      avgDurationMs: 0,
      avgCostUsd: 0,
      topTools: [],
      topSkills: [],
    };
    let comparison: BaselineComparison | undefined;
    try {
      evals = await this._query.listEvaluations({ limit: 200 });
      benchmarks = await this._query.listBenchmarks();
      baselines = await this._query.listBaselines();
      passRate = await this._query.passRate({});
      trend = await this._query.scoreTrend(50);
      dashboard = await this._buildDashboardSnapshot(dashboard.windowMs);
      const last = baselines[0];
      if (last) {
        comparison = await this._loadComparison(last.id);
      }
    } catch (e) {
      // first render before any data — empty state
    }
    this._panel.webview.html = renderHtml({
      evals,
      benchmarks,
      baselines,
      passRate,
      trend,
      dashboard,
      comparison,
    });
  }

  // ── IPC ──────────────────────────────────────────────────────────────

  private async _onMessage(msg: {
    type: string;
    reqId?: string;
    [k: string]: unknown;
  }): Promise<void> {
    const reply = (payload: Record<string, unknown>) =>
      this._panel.webview.postMessage(payload);
    if (msg.type === 'query.listEvaluations') {
      const evals = await this._query.listEvaluations({
        benchmarkId: msg.benchmarkId as string | undefined,
        pass: msg.pass as boolean | undefined,
        limit: (msg.limit as number | undefined) ?? 200,
      });
      reply({ type: 'reply.listEvaluations', reqId: msg.reqId, evaluations: evals });
    } else if (msg.type === 'query.listBenchmarks') {
      const benches = await this._query.listBenchmarks();
      reply({ type: 'reply.listBenchmarks', reqId: msg.reqId, benchmarks: benches });
    } else if (msg.type === 'query.passRate') {
      const pr = await this._query.passRate({
        benchmarkId: msg.benchmarkId as string | undefined,
      });
      reply({ type: 'reply.passRate', reqId: msg.reqId, passRate: pr });
    } else if (msg.type === 'query.trend') {
      const trend = await this._query.scoreTrend();
      reply({ type: 'reply.trend', reqId: String(msg.reqId), trend });
    } else if (msg.type === 'baseline.create') {
      const benchmarkId = msg.benchmarkId as string;
      const name = (msg.name as string | undefined)?.trim() || `baseline-${Date.now()}`;
      const description = msg.description as string | undefined;
      if (!benchmarkId) {
        vscode.window.showWarningMessage('Pick a benchmark first.');
        return;
      }
      const b = await this._query.createBaseline({ benchmarkId, name, description });
      vscode.window.showInformationMessage(`Baseline saved: ${b.id} (${b.evaluations.length} evals)`);
      void this._refresh();
    } else if (msg.type === 'baseline.delete') {
      await this._query.deleteBaseline(msg.id as string);
      void this._refresh();
    } else if (msg.type === 'baseline.compare') {
      const out = await this._loadComparison(msg.id as string);
      reply({ type: 'reply.compare', reqId: msg.reqId, comparison: out });
    } else if (msg.type === 'refresh') {
      void this._refresh();
    }
  }

  private async _loadComparison(baselineId: string): Promise<BaselineComparison> {
    const rec = await this._query.getBaseline(baselineId);
    const cmp = await this._query.compareToBaseline({ baselineId });
    return {
      baseline: cmp.baseline,
      current: cmp.current,
      deltas: cmp.deltas,
      baselineName: rec?.name ?? baselineId,
    };
  }

  // ── 7-day Dashboard (PHASE4_EVAL.md) ────────────────────────────────

  private async _buildDashboardSnapshot(windowMs: number): Promise<DashboardSnapshot> {
    const store = (this._mgr as unknown as { opts: { store: import('../infra/storage').Store } })
      .opts.store;
    const fromTs = Date.now() - windowMs;
    const runs = await store.runs.list({ fromTs, limit: 500 });
    const successCount = runs.filter((r) => r.status === 'success').length;
    const totalDuration = runs.reduce(
      (s, r) => s + (r.duration ?? (r.endTime ? r.endTime - r.startTime : 0)),
      0,
    );
    const totalCost = runs.reduce((s, r) => s + r.totalCostUsd, 0);

    // Tool / Skill usage: count spans grouped by name where type=tool/skill.
    const toolCount = new Map<string, number>();
    const skillCount = new Map<string, number>();
    for (const r of runs) {
      const spans = await store.spans.listByRun(r.id);
      for (const s of spans) {
        if (s.status !== 'ok') continue;
        const m = s.type === 'tool' ? toolCount : s.type === 'skill' ? skillCount : null;
        if (!m) continue;
        m.set(s.name, (m.get(s.name) ?? 0) + 1);
      }
    }
    const topTools = [...toolCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
    const topSkills = [...skillCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return {
      windowMs,
      totalRuns: runs.length,
      successRate: runs.length ? successCount / runs.length : 0,
      avgDurationMs: runs.length ? totalDuration / runs.length : 0,
      avgCostUsd: runs.length ? totalCost / runs.length : 0,
      topTools,
      topSkills,
    };
  }
}

// ── HTML ───────────────────────────────────────────────────────────────

interface RenderArgs {
  evals: Evaluation[];
  benchmarks: Benchmark[];
  baselines: Baseline[];
  passRate: number;
  trend: Array<{ timestamp: number; total: number; pass: boolean }>;
  dashboard: DashboardSnapshot;
  comparison: BaselineComparison | undefined;
}

function renderHtml(args: RenderArgs): string {
  const { evals, benchmarks, baselines, passRate, trend, dashboard, comparison } = args;
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  const totalCount = evals.length;
  const passedCount = evals.filter((e) => e.pass).length;
  const avg = totalCount ? evals.reduce((s, e) => s + (e.total ?? 0), 0) / totalCount : 0;

  const benchOptions = benchmarks.map((b) =>
    `<option value="${esc(b.id)}">${esc(b.id)} — ${esc(b.source?.dataset ?? '')}</option>`,
  ).join('');

  const evalRows = evals.map((e) => `
    <tr class="${e.pass ? 'pass' : 'fail'}">
      <td>${esc(e.benchmarkId)}</td>
      <td>${esc(e.runId)}</td>
      <td>${esc(e.total?.toFixed(1) ?? '-')}</td>
      <td>${e.pass ? '✓' : '✗'}</td>
      <td>${e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</td>
    </tr>`).join('');

  // Trend sparkline (mini svg, one bar per data point).
  const trendBars = trend
    .map((p, i) => {
      const x = (i / Math.max(1, trend.length - 1)) * 100;
      const h = Math.max(2, Math.min(60, (p.total ?? 0) * 0.6));
      const fill = p.pass ? '#4caf50' : '#f44336';
      return `<rect x="${x.toFixed(1)}%" y="${(60 - h).toFixed(1)}" width="2" height="${h.toFixed(1)}" fill="${fill}" />`;
    })
    .join('');

  // Baseline list rows
  const baselineRows = baselines.map((b) => `
    <tr>
      <td>${esc(b.id)}</td>
      <td>${esc(b.name)}</td>
      <td>${b.evaluations.length}</td>
      <td>${new Date(b.createdAt).toLocaleString()}</td>
      <td>
        <button data-act="compare" data-id="${esc(b.id)}">Compare</button>
        <button data-act="delete" data-id="${esc(b.id)}">Delete</button>
      </td>
    </tr>`).join('');

  // Comparison delta table
  const compareRows = comparison
    ? comparison.deltas.map((d) => {
        const improve =
          d.metric === 'avgDurationMs' ? d.diff < 0 : d.diff > 0;
        const sign = d.diff > 0 ? '+' : '';
        const cls = d.diff === 0 ? 'flat' : improve ? 'up' : 'down';
        return `<tr>
          <td>${esc(d.metric)}</td>
          <td>${d.before.toFixed(2)}</td>
          <td>${d.after.toFixed(2)}</td>
          <td class="${cls}">${sign}${d.diff.toFixed(2)} (${(d.pctChange * 100).toFixed(1)}%)</td>
        </tr>`;
      }).join('')
    : '';

  const baselineOptions = baselines
    .map((b) => `<option value="${esc(b.id)}">${esc(b.name)} (${esc(b.benchmarkId)})</option>`)
    .join('');

  const topToolsRows = dashboard.topTools
    .map((t) => `<li>${esc(t.name)} <span class="count">${t.count}</span></li>`)
    .join('') || '<li class="empty">—</li>';
  const topSkillsRows = dashboard.topSkills
    .map((t) => `<li>${esc(t.name)} <span class="count">${t.count}</span></li>`)
    .join('') || '<li class="empty">—</li>';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Z Evaluations</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 13px/1.4 system-ui, sans-serif; padding: 16px; margin: 0; }
    h1 { font-size: 16px; margin: 0 0 12px; }
    h2 { font-size: 13px; margin: 18px 0 8px; }
    .stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .card { flex: 1; min-width: 120px; padding: 10px 12px; border: 1px solid #8883; border-radius: 4px; }
    .card .v { font-size: 20px; font-weight: 600; }
    .card .l { opacity: 0.7; font-size: 11px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
    select, input, button {
      padding: 4px 8px; border: 1px solid #8883; background: var(--vscode-input-background);
      color: var(--vscode-input-foreground); border-radius: 3px; font: inherit;
    }
    button { cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8883; }
    tr.pass td:nth-child(4) { color: #4caf50; }
    tr.fail td:nth-child(4) { color: #f44336; }
    .empty { padding: 32px; text-align: center; opacity: 0.6; }
    .spark { background: var(--vscode-editor-background); border: 1px solid #8883; border-radius: 4px; padding: 8px; }
    .spark svg { width: 100%; height: 64px; display: block; }
    .compare-card { border: 1px solid #8883; border-radius: 4px; padding: 8px 12px; }
    .up { color: #4caf50; }
    .down { color: #f44336; }
    .flat { opacity: 0.7; }
    .top-list { margin: 0; padding-left: 16px; }
    .top-list .count { opacity: 0.6; font-size: 11px; margin-left: 4px; }
    .top-list .empty { padding: 4px 0; }
  </style>
</head>
<body>
  <h1>Z Evaluations</h1>

  <div class="stats">
    <div class="card"><div class="v">${totalCount}</div><div class="l">Total</div></div>
    <div class="card"><div class="v">${passedCount}/${totalCount}</div><div class="l">Passed</div></div>
    <div class="card"><div class="v">${(passRate * 100).toFixed(1)}%</div><div class="l">Pass Rate</div></div>
    <div class="card"><div class="v">${avg.toFixed(1)}</div><div class="l">Avg Score</div></div>
  </div>

  <h2>7-day Dashboard</h2>
  <div class="stats">
    <div class="card"><div class="v">${dashboard.totalRuns}</div><div class="l">Runs (7d)</div></div>
    <div class="card"><div class="v">${(dashboard.successRate * 100).toFixed(1)}%</div><div class="l">Success Rate</div></div>
    <div class="card"><div class="v">${(dashboard.avgDurationMs / 1000).toFixed(2)}s</div><div class="l">Avg Runtime</div></div>
    <div class="card"><div class="v">$${dashboard.avgCostUsd.toFixed(4)}</div><div class="l">Avg Cost</div></div>
  </div>
  <div class="stats">
    <div class="card">
      <div class="l">Top Tools</div>
      <ul class="top-list">${topToolsRows}</ul>
    </div>
    <div class="card">
      <div class="l">Top Skills</div>
      <ul class="top-list">${topSkillsRows}</ul>
    </div>
  </div>

  <h2>Score Trend</h2>
  <div class="spark">
    ${trend.length === 0
      ? '<div class="empty">No data yet.</div>'
      : `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><g>${trendBars}</g></svg>`}
  </div>

  <h2>Baselines</h2>
  <div class="toolbar">
    <label>Benchmark:
      <select id="bench">
        <option value="">— pick —</option>
        ${benchOptions}
      </select>
    </label>
    <label>Name: <input id="baselineName" type="text" placeholder="v0.3-stable" /></label>
    <button id="createBaseline">Snapshot as Baseline</button>
    <label>Compare to:
      <select id="baselineSelect">
        <option value="">— pick —</option>
        ${baselineOptions}
      </select>
    </label>
    <button id="refresh">Refresh</button>
  </div>
  ${baselines.length === 0
    ? '<div class="empty">No baselines yet. Pick a benchmark above and snapshot the current evaluations.</div>'
    : `<table>
        <thead><tr><th>ID</th><th>Name</th><th>Evals</th><th>Created</th><th></th></tr></thead>
        <tbody>${baselineRows}</tbody>
      </table>`}

  ${comparison
    ? `<h2>Baseline Comparison: ${esc(comparison.baselineName)}</h2>
      <div class="compare-card">
        <table>
          <thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Δ</th></tr></thead>
          <tbody>${compareRows}</tbody>
        </table>
      </div>`
    : ''}

  <h2>Evaluations</h2>
  <div class="toolbar">
    <label>Benchmark:
      <select id="benchFilter">
        <option value="">All</option>
        ${benchOptions}
      </select>
    </label>
    <label><input id="passedOnly" type="checkbox" /> Passed only</label>
    <button id="refreshEval">Refresh Evals</button>
  </div>
  ${totalCount === 0
    ? '<div class="empty">No evaluations yet. Run a benchmark suite first.</div>'
    : `<table>
        <thead><tr>
          <th>Benchmark</th><th>Run</th><th>Total</th><th>Pass</th><th>When</th>
        </tr></thead>
        <tbody>${evalRows}</tbody>
      </table>`
  }
  <script>
    const vscode = acquireVsCodeApi();
    function send(msg) { vscode.postMessage(msg); }
    document.getElementById('createBaseline').addEventListener('click', () => {
      const bench = document.getElementById('bench').value;
      const name = document.getElementById('baselineName').value;
      if (!bench) { alert('Pick a benchmark first'); return; }
      send({ type: 'baseline.create', benchmarkId: bench, name });
    });
    document.getElementById('baselineSelect').addEventListener('change', (e) => {
      const id = e.target.value;
      if (!id) return;
      send({ type: 'baseline.compare', reqId: 'cmp1', id });
    });
    document.querySelectorAll('button[data-act="compare"]').forEach(b =>
      b.addEventListener('click', () => {
        send({ type: 'baseline.compare', reqId: 'cmp1', id: b.dataset.id });
      }));
    document.querySelectorAll('button[data-act="delete"]').forEach(b =>
      b.addEventListener('click', () => {
        if (confirm('Delete baseline ' + b.dataset.id + '?')) {
          send({ type: 'baseline.delete', id: b.dataset.id });
        }
      }));
    document.getElementById('refresh').addEventListener('click', () => send({ type: 'refresh' }));
    document.getElementById('refreshEval').addEventListener('click', () => {
      const bench = document.getElementById('benchFilter').value || undefined;
      const passedOnly = document.getElementById('passedOnly').checked;
      send({ type: 'query.listEvaluations', reqId: 'r1', benchmarkId: bench, pass: passedOnly ? true : undefined, limit: 200 });
    });
  </script>
</body>
</html>`;
}
