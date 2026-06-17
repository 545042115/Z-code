// EvolutionPanel — display the EvolutionReport and gate Apply behind
// human approval (ADR-0004: Evolution must be human-in-the-loop).
//
// The panel shows:
//   1. Recurring failure clusters + heuristic suggestions (apply gated)
//   2. Tool Optimizer stats (per-tool usage + success rate)
//   3. Skill Optimizer stats (per-skill hit rate + success rate)
//   4. A/B Candidate pool (variants + per-variant stats)
//   5. Pending Proposals (files written under evolution/pending/)

import * as vscode from 'vscode';
import type { TraceManager } from '../trace';
import {
  EvolutionEngine,
  type EvolutionReport,
  type EvolutionSuggestion,
} from './evolution';
import type { PromptCandidate, VariantStats } from '../contracts';
import { writeFile, mkdir, readdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import type { QueryService } from '../trace-ui/query-service';

interface ProposalRecord {
  filename: string;
  suggestion: EvolutionSuggestion;
  createdAt: number;
}

interface ToolRow {
  name: string;
  calls: number;
  ok: number;
  error: number;
  successRate: number;
  avgDurationMs: number;
}
interface SkillRow {
  name: string;
  hits: number;
  successRate: number;
}

interface CandidateRow {
  candidate: PromptCandidate;
  stats: VariantStats[];
}

export class EvolutionPanel {
  public static currentPanel: EvolutionPanel | undefined;

  public static createOrShow(extensionUri: vscode.Uri, mgr: TraceManager): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;
    if (EvolutionPanel.currentPanel) {
      EvolutionPanel.currentPanel._panel.reveal(column);
      void EvolutionPanel.currentPanel._refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'zEvolution',
      'Z Evolution',
      column ?? vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    EvolutionPanel.currentPanel = new EvolutionPanel(panel, extensionUri, mgr);
  }

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _mgr: TraceManager;
  private _engine: EvolutionEngine;
  private _query: QueryService;
  private _report?: EvolutionReport;
  private _proposals: ProposalRecord[] = [];
  private _tools: ToolRow[] = [];
  private _skills: SkillRow[] = [];
  private _candidates: CandidateRow[] = [];

  private constructor(panel: vscode.WebviewPanel, _uri: vscode.Uri, mgr: TraceManager) {
    this._panel = panel;
    this._mgr = mgr;
    this._query = mgr.getQueryService();
    this._engine = new EvolutionEngine(
      (mgr as unknown as { opts: { store: import('../infra/storage').Store } }).opts.store,
      mgr,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables,
    );
    void this._refresh();
  }

  public dispose(): void {
    EvolutionPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      try { d?.dispose(); } catch { /* ignore */ }
    }
  }

  private async _refresh(): Promise<void> {
    this._report = await this._engine.generate({});
    this._proposals = await this._loadProposals();
    try {
      this._tools = await this._query.toolUsage();
      this._skills = await this._query.skillUsage();
    } catch {
      this._tools = [];
      this._skills = [];
    }
    try {
      const cs = await this._query.listCandidates();
      this._candidates = await Promise.all(
        cs.map(async (c) => ({
          candidate: c,
          stats: await this._query.variantStats(c.id),
        })),
      );
    } catch {
      this._candidates = [];
    }
    this._panel.webview.html = renderHtml({
      report: this._report,
      proposals: this._proposals,
      tools: this._tools,
      skills: this._skills,
      candidates: this._candidates,
    });
  }

  private async _onMessage(msg: { type: string; idx?: number; id?: string }): Promise<void> {
    if (msg.type === 'apply' && typeof msg.idx === 'number' && this._report) {
      const sug = this._report.suggestions[msg.idx];
      if (!sug) return;
      const confirm = await vscode.window.showInformationMessage(
        `Apply suggestion?\n\n${summarizeSuggestion(sug)}`,
        { modal: true },
        'Apply',
        'Cancel',
      );
      if (confirm !== 'Apply') return;
      await this._writeProposal(sug);
      vscode.window.showInformationMessage('[Z Evolution] Proposal recorded. Review and apply in config center.');
      void this._refresh();
    } else if (msg.type === 'proposal.delete' && msg.id) {
      await this._deleteProposal(msg.id);
      void this._refresh();
    } else if (msg.type === 'candidate.add') {
      const agentName = await vscode.window.showInputBox({
        prompt: 'Agent name (must match a registered IAgent)',
        placeHolder: 'e.g. planner, coder, reviewer',
      });
      if (!agentName) return;
      const name = await vscode.window.showInputBox({
        prompt: 'Candidate name',
        placeHolder: 'e.g. planner-default',
      });
      if (!name) return;
      const label = await vscode.window.showInputBox({
        prompt: 'Initial variant label (control)',
        value: 'control',
      });
      const content = await vscode.window.showInputBox({
        prompt: 'Initial variant content (the prompt text)',
      });
      if (!content) return;
      const id = `${agentName}:${name}`;
      const variantId = `v-${Date.now()}`;
      await this._query.upsertCandidate({
        id,
        agentName,
        name,
        variants: [{ id: variantId, label: label || 'control', content, createdAt: Date.now() }],
        activeVariantId: variantId,
      });
      void this._refresh();
    } else if (msg.type === 'candidate.variant' && msg.id) {
      // msg.id === candidateId
      const cand = await this._query.getCandidate(msg.id);
      if (!cand) return;
      const label = await vscode.window.showInputBox({ prompt: 'Variant label (e.g. A, B)', value: 'A' });
      if (!label) return;
      const content = await vscode.window.showInputBox({ prompt: 'Variant content' });
      if (!content) return;
      const variantId = `v-${Date.now()}`;
      await this._query.upsertCandidate({
        id: cand.id,
        agentName: cand.agentName,
        name: cand.name,
        variants: [...cand.variants, { id: variantId, label, content, createdAt: Date.now() }],
        activeVariantId: cand.activeVariantId,
      });
      void this._refresh();
    } else if (msg.type === 'candidate.activate' && msg.id) {
      const cand = await this._query.getCandidate(msg.id);
      if (!cand) return;
      const pick = await vscode.window.showQuickPick(
        cand.variants.map((v) => ({ label: v.label, description: v.id, variantId: v.id })),
        { placeHolder: 'Pick variant to activate' },
      );
      if (!pick) return;
      await this._query.upsertCandidate({
        id: cand.id,
        agentName: cand.agentName,
        name: cand.name,
        variants: cand.variants,
        activeVariantId: pick.variantId,
      });
      void this._refresh();
    } else if (msg.type === 'candidate.delete' && msg.id) {
      const confirm = await vscode.window.showWarningMessage(
        `Delete candidate ${msg.id}?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      await this._query.deleteCandidate(msg.id);
      void this._refresh();
    } else if (msg.type === 'refresh') {
      void this._refresh();
    }
  }

  /** Persist a human-approved proposal to a review log under globalStorage. */
  private async _writeProposal(s: EvolutionSuggestion): Promise<void> {
    const dir = join(this._mgr.opts.tracesDir, 'evolution', 'pending');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${s.kind}.json`);
    await writeFile(path, JSON.stringify(s, null, 2), 'utf8');
  }

  private async _loadProposals(): Promise<ProposalRecord[]> {
    const dir = join(this._mgr.opts.tracesDir, 'evolution', 'pending');
    try {
      const files = await readdir(dir);
      const out: ProposalRecord[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const text = await readFile(join(dir, f), 'utf8');
          const s = JSON.parse(text) as EvolutionSuggestion;
          const stat = await import('fs/promises').then((m) => m.stat(join(dir, f)));
          out.push({ filename: f, suggestion: s, createdAt: stat.mtimeMs });
        } catch {
          // ignore malformed
        }
      }
      out.sort((a, b) => b.createdAt - a.createdAt);
      return out;
    } catch {
      return [];
    }
  }

  private async _deleteProposal(filename: string): Promise<void> {
    const dir = join(this._mgr.opts.tracesDir, 'evolution', 'pending');
    try {
      await unlink(join(dir, filename));
    } catch {
      // ignore
    }
  }
}

function summarizeSuggestion(s: EvolutionSuggestion): string {
  if (s.kind === 'prompt') return `PROMPT for ${s.agentName}\n+ ${s.proposed.slice(0, 120)}…`;
  if (s.kind === 'tool') return `TOOL ${s.toolName}: ${s.proposed.action} (${s.proposed.reason})`;
  return `CONFIG ${s.key}: ${JSON.stringify(s.currentValue)} → ${JSON.stringify(s.proposedValue)}`;
}

interface RenderArgs {
  report: EvolutionReport;
  proposals: ProposalRecord[];
  tools: ToolRow[];
  skills: SkillRow[];
  candidates: CandidateRow[];
}

function renderHtml(args: RenderArgs): string {
  const { report, proposals, tools, skills, candidates } = args;
  const esc = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  if (!report) return `<!doctype html><body><p>Loading…</p></body>`;

  const sugRows = report.suggestions.map((s, i) => `
    <tr>
      <td><span class="tag tag-${s.kind}">${esc(s.kind)}</span></td>
      <td>${esc(s.kind === 'prompt' ? s.agentName : s.kind === 'tool' ? s.toolName : s.key)}</td>
      <td>${esc(s.kind === 'prompt' ? s.proposed : s.kind === 'tool' ? s.proposed.action : s.proposedValue)}</td>
      <td><button data-idx="${i}" class="apply">Apply (human-approved)</button></td>
    </tr>`).join('');

  const clusterRows = report.clusters.map((c) => `
    <tr>
      <td>${esc(c.label)}</td>
      <td>${esc(c.signature.slice(0, 80))}</td>
      <td>${c.count}</td>
      <td>${c.distinctRuns}</td>
      <td>${c.distinctTasks}</td>
    </tr>`).join('');

  // Tool / Skill / Proposals
  const toolRows = tools
    .slice(0, 10)
    .map((t) => `
      <tr>
        <td>${esc(t.name)}</td>
        <td>${t.calls}</td>
        <td>${(t.successRate * 100).toFixed(1)}%</td>
        <td>${(t.avgDurationMs / 1000).toFixed(2)}s</td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">No tool usage in window.</td></tr>';

  const skillRows = skills
    .slice(0, 10)
    .map((s) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${s.hits}</td>
        <td>${(s.successRate * 100).toFixed(1)}%</td>
      </tr>`).join('') || '<tr><td colspan="3" class="empty">No skill hits in window.</td></tr>';

  const proposalRows = proposals
    .map((p) => `
      <tr>
        <td>${esc(p.filename)}</td>
        <td><span class="tag tag-${p.suggestion.kind}">${esc(p.suggestion.kind)}</span></td>
        <td>${esc(p.suggestion.kind === 'prompt' ? p.suggestion.agentName : p.suggestion.kind === 'tool' ? p.suggestion.toolName : p.suggestion.key)}</td>
        <td>${new Date(p.createdAt).toLocaleString()}</td>
        <td><button data-id="${esc(p.filename)}" class="proposal-del">Remove</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">No pending proposals.</td></tr>';

  const candidateBlocks = candidates.length === 0
    ? '<div class="empty">No prompt candidates registered yet.</div>'
    : candidates.map((c) => {
        const active = c.candidate.variants.find((v) => v.id === c.candidate.activeVariantId);
        const variantRows = c.candidate.variants.map((v) => {
          const st = c.stats.find((s) => s.variantId === v.id);
          const isActive = v.id === c.candidate.activeVariantId;
          return `<tr class="${isActive ? 'active' : ''}">
            <td>${esc(v.label)} ${isActive ? '<span class="tag tag-prompt">active</span>' : ''}</td>
            <td>${st?.runCount ?? 0}</td>
            <td>${st ? (st.passRate * 100).toFixed(1) : '-'}%</td>
            <td>$${st ? st.avgCostUsd.toFixed(4) : '-'}</td>
            <td><button data-id="${esc(c.candidate.id)}" class="candidate-activate">Activate</button></td>
          </tr>`;
        }).join('');
        return `<div class="card candidate-card">
          <h3>${esc(c.candidate.name)} <span class="muted">(${esc(c.candidate.agentName)})</span></h3>
          <div class="muted">Active: ${esc(active?.label ?? '—')}</div>
          <table>
            <thead><tr><th>Variant</th><th>Runs</th><th>Pass</th><th>Avg Cost</th><th></th></tr></thead>
            <tbody>${variantRows}</tbody>
          </table>
          <div class="row-actions">
            <button data-id="${esc(c.candidate.id)}" class="candidate-variant">+ Variant</button>
            <button data-id="${esc(c.candidate.id)}" class="candidate-delete">Delete</button>
          </div>
        </div>`;
      }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>Z Evolution</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.4 system-ui, sans-serif; padding: 16px; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  h2 { font-size: 13px; margin: 20px 0 8px; }
  h3 { font-size: 12px; margin: 0 0 6px; }
  .muted { opacity: 0.65; font-size: 11px; }
  .stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .card { flex: 1; min-width: 120px; padding: 10px 12px; border: 1px solid #8883; border-radius: 4px; }
  .card .v { font-size: 20px; font-weight: 600; }
  .card .l { opacity: 0.7; font-size: 11px; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .tag-prompt { background: #1976d2; color: white; }
  .tag-tool { background: #f57c00; color: white; }
  .tag-config { background: #388e3c; color: white; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8883; }
  tr.active { background: #1976d233; }
  .apply, .proposal-del, .candidate-activate, .candidate-variant, .candidate-delete { padding: 4px 10px; cursor: pointer; }
  .empty { padding: 12px; opacity: 0.6; text-align: center; }
  .row-actions { display: flex; gap: 6px; margin-top: 6px; }
  .candidate-card { flex-basis: 100%; }
  .candidates-grid { display: flex; flex-wrap: wrap; gap: 12px; }
</style></head>
<body>
  <h1>Z Evolution <button id="refresh" style="float:right">Refresh</button></h1>
  <div class="stats">
    <div class="card"><div class="v">${report.totalFailures}</div><div class="l">Failures in window</div></div>
    <div class="card"><div class="v">${report.clusters.length}</div><div class="l">Recurring clusters</div></div>
    <div class="card"><div class="v">${report.suggestions.length}</div><div class="l">Suggestions</div></div>
    <div class="card"><div class="v">${proposals.length}</div><div class="l">Pending proposals</div></div>
    <div class="card"><div class="v">${candidates.length}</div><div class="l">A/B candidates</div></div>
  </div>

  <h2>Failure Clusters</h2>
  ${report.clusters.length === 0
    ? '<div class="empty">No recurring failure patterns detected.</div>'
    : `<table>
        <thead><tr><th>Cluster</th><th>Pattern</th><th>Count</th><th>Runs</th><th>Tasks</th></tr></thead>
        <tbody>${clusterRows}</tbody>
      </table>`}

  <h2>Suggestions (apply is human-gated)</h2>
  ${report.suggestions.length === 0
    ? '<div class="empty">No suggestions yet.</div>'
    : `<table>
        <thead><tr><th>Kind</th><th>Target</th><th>Proposed</th><th></th></tr></thead>
        <tbody>${sugRows}</tbody>
      </table>`}

  <h2>Tool Optimizer <span class="muted">(7-day usage + success rate)</span></h2>
  <table>
    <thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>Avg Duration</th></tr></thead>
    <tbody>${toolRows}</tbody>
  </table>

  <h2>Skill Optimizer <span class="muted">(hit rate + success rate)</span></h2>
  <table>
    <thead><tr><th>Skill</th><th>Hits</th><th>Success</th></tr></thead>
    <tbody>${skillRows}</tbody>
  </table>

  <h2>A/B Prompt Candidates</h2>
  <button id="addCandidate">+ New candidate</button>
  <div class="candidates-grid" style="margin-top: 8px;">
    ${candidateBlocks}
  </div>

  <h2>Pending Proposals</h2>
  <table>
    <thead><tr><th>File</th><th>Kind</th><th>Target</th><th>Created</th><th></th></tr></thead>
    <tbody>${proposalRows}</tbody>
  </table>

  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.apply').forEach(b => b.addEventListener('click', () => {
      vscode.postMessage({ type: 'apply', idx: Number(b.dataset.idx) });
    }));
    document.querySelectorAll('.proposal-del').forEach(b => b.addEventListener('click', () => {
      vscode.postMessage({ type: 'proposal.delete', id: b.dataset.id });
    }));
    document.querySelectorAll('.candidate-activate').forEach(b => b.addEventListener('click', () => {
      vscode.postMessage({ type: 'candidate.activate', id: b.dataset.id });
    }));
    document.querySelectorAll('.candidate-variant').forEach(b => b.addEventListener('click', () => {
      vscode.postMessage({ type: 'candidate.variant', id: b.dataset.id });
    }));
    document.querySelectorAll('.candidate-delete').forEach(b => b.addEventListener('click', () => {
      vscode.postMessage({ type: 'candidate.delete', id: b.dataset.id });
    }));
    document.getElementById('addCandidate').addEventListener('click', () => {
      vscode.postMessage({ type: 'candidate.add' });
    });
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
  </script>
</body></html>`;
}
