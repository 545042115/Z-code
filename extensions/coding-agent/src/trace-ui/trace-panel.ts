// TracePanel — VS Code Webview that displays Runs and Spans.
//
// This is the entry point of the Trace UI. It hosts an HTML page
// (rendered in the webview) and bridges messages between the webview
// and the extension via `postMessage` / `onDidReceiveMessage`.
//
// Views:
//   1. RunList   — recent Runs, filterable by status/tag
//   2. Timeline  — Span tree of a selected Run, time-scaled
//   3. SpanDetail — full record (input/output/events) of a selected Span
//
// The webview is a single HTML page with hash-based routing
// (#/runs, #/run/:id, #/span/:id).

import * as vscode from 'vscode';
import { QueryService } from './query-service';
import type { Store } from '../infra/storage';
import type { TraceManager } from '../trace';

export interface TracePanelOptions {
  store: Store;
  traceManager?: TraceManager;
  /** Optional: subscribe to live updates. */
  extensionUri: vscode.Uri;
  /** Optional run to deep-link to on first render. */
  focusRunId?: string;
}

export class TracePanel {
  public static readonly VIEW_TYPE = 'codingAgent.trace';
  public static currentPanel: TracePanel | undefined;

  /**
   * V2 entry: open or focus the Trace UI. Pass a `focusRunId` to
   * deep-link to a specific Run (used by the Multi-Agent flow).
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    mgrOrStore: TraceManager | { store: import('../infra/storage').Store },
    focusRunId?: string,
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;
    if (TracePanel.currentPanel) {
      TracePanel.currentPanel._panel.reveal(column);
      TracePanel.currentPanel._setFocusRun(focusRunId);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'zTrace',
      'Z Trace',
      column ?? vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const store = 'opts' in mgrOrStore
      ? (mgrOrStore as TraceManager).opts.store
      : mgrOrStore.store;
    TracePanel.currentPanel = new TracePanel(panel, { store, extensionUri, focusRunId });
  }

  private _focusRunId?: string;
  private _setFocusRun(id: string | undefined): void {
    this._focusRunId = id;
    // Re-render the panel to scroll to the new focus
    this._render();
  }

  private _render(): void {
    this._panel.webview.html = this._getHtml();
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _query: QueryService;
  private readonly _disposables: vscode.Disposable[] = [];
  private _unsubscribeQuery: () => void;
  private _pollTimer?: NodeJS.Timeout;

  private constructor(panel: vscode.WebviewPanel, private readonly opts: TracePanelOptions) {
    this._panel = panel;
    this._query = new QueryService(opts.store);
    this._unsubscribeQuery = this._query.subscribe((key) => {
      this._postMessage({ type: 'cache.invalidated', key });
    });

    // When an active Run is in flight, poll the store every 500ms
    // and notify the webview of new Spans.
    this._startLivePolling();

    this._panel.webview.html = this._getHtml();
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables
    );
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Public API ──────────────────────────────────────────────────────

  static show(opts: TracePanelOptions): TracePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Two;
    if (TracePanel.currentPanel) {
      TracePanel.currentPanel._panel.reveal(column);
      return TracePanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      TracePanel.VIEW_TYPE,
      'Z Trace',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [opts.extensionUri],
      }
    );
    TracePanel.currentPanel = new TracePanel(panel, opts);
    return TracePanel.currentPanel;
  }

  dispose(): void {
    TracePanel.currentPanel = undefined;
    this._unsubscribeQuery();
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      try { d?.dispose(); } catch { /* ignore */ }
    }
  }

  // ── Message handling ────────────────────────────────────────────────

  private async _onMessage(msg: WebviewToHostMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'query.listRuns': {
          const runs = await this._query.listRuns(msg.query);
          this._postMessage({ type: 'reply.listRuns', reqId: msg.reqId, runs });
          break;
        }
        case 'query.getRun': {
          const run = await this._query.getRun(msg.runId);
          this._postMessage({ type: 'reply.getRun', reqId: msg.reqId, run });
          break;
        }
        case 'query.listSpanNodes': {
          const spans = await this._query.listSpanNodes(msg.runId);
          this._postMessage({ type: 'reply.listSpanNodes', reqId: msg.reqId, spans });
          break;
        }
        case 'query.getSpan': {
          const span = await this._query.getSpan(msg.spanId);
          this._postMessage({ type: 'reply.getSpan', reqId: msg.reqId, span });
          break;
        }
        case 'query.readEvents': {
          const events = await this._query.readEvents(msg.runId);
          this._postMessage({ type: 'reply.readEvents', reqId: msg.reqId, events });
          break;
        }
        case 'query.deleteRun': {
          await this.opts.store.runs.delete(msg.runId);
          await this.opts.store.spans.deleteByRun(msg.runId);
          this._query.clear();
          this._postMessage({ type: 'reply.deleteRun', reqId: msg.reqId });
          break;
        }
      }
    } catch (e) {
      this._postMessage({
        type: 'reply.error',
        reqId: 'reqId' in msg ? msg.reqId : undefined,
        message: (e as Error).message,
      });
    }
  }

  // ── Live polling ────────────────────────────────────────────────────

  private _startLivePolling(): void {
    if (!this.opts.traceManager) return;
    this._pollTimer = setInterval(async () => {
      const active = this.opts.traceManager?.active();
      if (active) {
        this._query.invalidate('runs:*', `spans:${active.id}`, `events:${active.id}`, `run:${active.id}`);
      }
    }, 500);
    this._disposables.push({ dispose: () => this._pollTimer && clearInterval(this._pollTimer) });
  }

  // ── Transport ───────────────────────────────────────────────────────

  private _postMessage(msg: HostToWebviewMessage): void {
    this._panel.webview.postMessage(msg);
  }

  // ── HTML ────────────────────────────────────────────────────────────

  private _getHtml(): string {
    return TRACE_HTML;
  }
}

// ── Message protocol (typed) ─────────────────────────────────────────

export type WebviewToHostMessage =
  | { type: 'query.listRuns'; reqId: string; query?: import('../infra/storage').RunQuery }
  | { type: 'query.getRun'; reqId: string; runId: string }
  | { type: 'query.listSpanNodes'; reqId: string; runId: string }
  | { type: 'query.getSpan'; reqId: string; spanId: string }
  | { type: 'query.readEvents'; reqId: string; runId: string }
  | { type: 'query.deleteRun'; reqId: string; runId: string };

export type HostToWebviewMessage =
  | { type: 'cache.invalidated'; key: string }
  | { type: 'reply.listRuns'; reqId: string; runs: import('./query-service').RunSummary[] }
  | { type: 'reply.getRun'; reqId: string; run: import('../contracts').AgentRun | undefined }
  | { type: 'reply.listSpanNodes'; reqId: string; spans: import('./query-service').SpanNode[] }
  | { type: 'reply.getSpan'; reqId: string; span: import('../contracts').AgentSpan | undefined }
  | { type: 'reply.readEvents'; reqId: string; events: import('./query-service').SpanEventLite[] }
  | { type: 'reply.deleteRun'; reqId: string }
  | { type: 'reply.error'; reqId?: string; message: string };

// ── HTML payload ─────────────────────────────────────────────────────

const TRACE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Z Trace</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    header { padding: 8px 12px; border-bottom: 1px solid #8884; display: flex; gap: 8px; align-items: center; }
    header h1 { font-size: 13px; margin: 0; font-weight: 600; }
    header .grow { flex: 1; }
    button { font: inherit; padding: 3px 8px; border: 1px solid #8884; background: transparent; border-radius: 3px; cursor: pointer; }
    button:hover { background: #8882; }
    main { display: grid; grid-template-columns: 280px 1fr; height: calc(100vh - 41px); }
    aside { border-right: 1px solid #8884; overflow-y: auto; }
    section { overflow-y: auto; padding: 12px; }
    .run-item { padding: 8px 12px; border-bottom: 1px solid #8882; cursor: pointer; }
    .run-item:hover { background: #8882; }
    .run-item.active { background: #8883; }
    .run-task { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .run-meta { color: #888; font-size: 11px; margin-top: 2px; display: flex; gap: 8px; }
    .pill { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 600; }
    .pill.success { background: #2d8a3e33; color: #2d8a3e; }
    .pill.failed { background: #c43c3c33; color: #c43c3c; }
    .pill.running { background: #2c7be533; color: #2c7be5; }
    .pill.cancelled { background: #88888833; color: #888; }
    .timeline { position: relative; }
    .span-row { display: flex; align-items: center; padding: 2px 0; cursor: pointer; }
    .span-row:hover { background: #8882; }
    .span-label { width: 220px; flex-shrink: 0; padding-right: 8px; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .span-bar-wrap { flex: 1; position: relative; height: 18px; }
    .span-bar { position: absolute; height: 14px; top: 2px; border-radius: 2px; min-width: 2px; }
    .span-bar.llm { background: #6f42c177; }
    .span-bar.tool { background: #2c7be577; }
    .span-bar.planner { background: #d29922aa; }
    .span-bar.unknown { background: #88888877; }
    .span-bar.error { background: #c43c3caa; }
    .span-bar.ok { background: #2d8a3e88; }
    .span-row.selected { background: #8883; }
    .empty { color: #888; padding: 20px; text-align: center; }
    .kv { display: grid; grid-template-columns: 120px 1fr; gap: 4px 12px; margin: 4px 0; }
    .kv .k { color: #888; }
    .kv .v { font-family: monospace; word-break: break-all; white-space: pre-wrap; }
    pre { background: #8882; padding: 8px; border-radius: 3px; overflow-x: auto; font-size: 11px; }
    .filter-bar { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid #8884; }
    .filter-bar select, .filter-bar input { flex: 1; font: inherit; padding: 2px 4px; }
  </style>
</head>
<body>
  <header>
    <h1>Z Trace</h1>
    <span id="active-badge" class="pill running" style="display:none">● ACTIVE</span>
    <span class="grow"></span>
    <button id="refresh-btn">Refresh</button>
  </header>
  <main>
    <aside>
      <div class="filter-bar">
        <select id="status-filter">
          <option value="">all</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
          <option value="running">running</option>
          <option value="cancelled">cancelled</option>
        </select>
        <input id="search-input" placeholder="search task…" />
      </div>
      <div id="run-list"></div>
    </aside>
    <section id="detail"></section>
  </main>
  <script>
    // ── Tiny RPC layer ────────────────────────────────────────────────
    const vscode = acquireVsCodeApi();
    const pending = new Map();
    let nextReqId = 1;
    function send(msg) {
      return new Promise((resolve, reject) => {
        const reqId = String(nextReqId++);
        pending.set(reqId, { resolve, reject });
        vscode.postMessage(Object.assign({ reqId }, msg));
      });
    }
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.reqId && pending.has(msg.reqId)) {
        const { resolve, reject } = pending.get(msg.reqId);
        pending.delete(msg.reqId);
        if (msg.type === 'reply.error') reject(new Error(msg.message));
        else if (msg.type === 'cache.invalidated') { /* ignore */ }
        else resolve(msg);
      }
    });

    // ── State ─────────────────────────────────────────────────────────
    const state = { runs: [], selectedRunId: null, selectedSpanId: null, filter: { status: '', search: '' } };

    // ── RunList view ──────────────────────────────────────────────────
    async function loadRuns() {
      const query = {};
      if (state.filter.status) query.status = state.filter.status;
      const reply = await send({ type: 'query.listRuns', query });
      state.runs = reply.runs;
      // Tag filter is a client-side post-filter (cheap)
      const search = state.filter.search.toLowerCase();
      const filtered = state.runs.filter(r => !search || r.task.toLowerCase().includes(search));
      renderRunList(filtered);
    }
    function renderRunList(runs) {
      const el = document.getElementById('run-list');
      if (runs.length === 0) { el.innerHTML = '<div class="empty">no runs yet</div>'; return; }
      el.innerHTML = runs.map(r => \`
        <div class="run-item \${r.id === state.selectedRunId ? 'active' : ''}" data-id="\${r.id}">
          <div class="run-task">\${escapeHtml(r.task)}</div>
          <div class="run-meta">
            <span class="pill \${r.status}">\${r.status}</span>
            <span>\${r.spanCount} spans</span>
            <span>\${(r.duration ?? 0)}ms</span>
            <span>$\${r.totalCostUsd.toFixed(4)}</span>
          </div>
        </div>
      \`).join('');
      el.querySelectorAll('.run-item').forEach(node => {
        node.onclick = () => selectRun(node.dataset.id);
      });
    }

    // ── Timeline view ─────────────────────────────────────────────────
    async function selectRun(runId) {
      state.selectedRunId = runId;
      state.selectedSpanId = null;
      loadRuns();  // re-render active highlight
      const reply = await send({ type: 'query.listSpanNodes', runId });
      renderTimeline(runId, reply.spans);
    }
    function renderTimeline(runId, spans) {
      const el = document.getElementById('detail');
      if (spans.length === 0) { el.innerHTML = '<div class="empty">no spans</div>'; return; }
      const t0 = Math.min(...spans.map(s => s.startTime));
      const tEnd = Math.max(...spans.map(s => s.endTime ?? s.startTime));
      const total = Math.max(1, tEnd - t0);
      // Build parent→children map
      const byParent = new Map();
      spans.forEach(s => {
        const k = s.parentSpanId ?? '__root__';
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(s);
      });
      // Render root tree
      function renderChildren(parentId, depth) {
        const kids = (byParent.get(parentId) || []).sort((a, b) => a.startTime - b.startTime);
        return kids.map(s => {
          const offset = ((s.startTime - t0) / total) * 100;
          const width = Math.max(0.5, ((s.endTime ?? s.startTime) - s.startTime) / total * 100);
          const cls = (s.status === 'error' ? 'error' : (s.hasError ? 'error' : s.type));
          return \`
            <div class="span-row \${s.id === state.selectedSpanId ? 'selected' : ''}" data-id="\${s.id}" style="padding-left: \${depth * 16}px">
              <div class="span-label">\${escapeHtml(s.name)}</div>
              <div class="span-bar-wrap">
                <div class="span-bar \${cls}" style="left: \${offset}%; width: \${width}%"></div>
              </div>
            </div>
            \${renderChildren(s.id, depth + 1)}
          \`;
        }).join('');
      }
      el.innerHTML = \`
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
          <button onclick="deleteRun('\${runId}')">Delete</button>
          <span>total: \${spans.length} spans</span>
        </div>
        <div class="timeline">\${renderChildren('__root__', 0)}</div>
      \`;
      el.querySelectorAll('.span-row').forEach(node => {
        node.onclick = () => selectSpan(node.dataset.id);
      });
    }

    // ── SpanDetail view ───────────────────────────────────────────────
    async function selectSpan(spanId) {
      state.selectedSpanId = spanId;
      const reply = await send({ type: 'query.getSpan', spanId });
      renderSpanDetail(reply.span);
    }
    function renderSpanDetail(span) {
      if (!span) return;
      const el = document.getElementById('detail');
      el.innerHTML = \`
        <h2 style="font-family: monospace; font-size: 13px; margin-top: 0">\${escapeHtml(span.name)}</h2>
        <div class="kv">
          <div class="k">id</div><div class="v">\${span.id}</div>
          <div class="k">type</div><div class="v">\${span.type}</div>
          <div class="k">status</div><div class="v"><span class="pill \${span.status}">\${span.status}</span></div>
          <div class="k">duration</div><div class="v">\${span.duration ?? '—'}ms</div>
          \${span.tokensIn !== undefined ? \`<div class="k">tokens in/out</div><div class="v">\${span.tokensIn} / \${span.tokensOut ?? 0}</div>\` : ''}
          \${span.costUsd !== undefined ? \`<div class="k">cost</div><div class="v">$\${span.costUsd.toFixed(6)}</div>\` : ''}
          \${span.error ? \`<div class="k">error</div><div class="v">\${span.error.code} — \${escapeHtml(span.error.message ?? '')}</div>\` : ''}
        </div>
        \${span.input !== undefined ? \`<h3>Input</h3><pre>\${escapeHtml(JSON.stringify(span.input, null, 2))}</pre>\` : ''}
        \${span.output !== undefined ? \`<h3>Output</h3><pre>\${escapeHtml(JSON.stringify(span.output, null, 2))}</pre>\` : ''}
        \${span.events && span.events.length > 0 ? \`<h3>Events (\${span.events.length})</h3><pre>\${escapeHtml(JSON.stringify(span.events, null, 2))}</pre>\` : ''}
        <div style="margin-top:8px"><button onclick="selectRun('\${span.runId}')">← back to timeline</button></div>
      \`;
    }

    // ── Helpers ───────────────────────────────────────────────────────
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    async function deleteRun(runId) {
      if (!confirm('Delete this run?')) return;
      await send({ type: 'query.deleteRun', runId });
      state.selectedRunId = null;
      state.selectedSpanId = null;
      loadRuns();
    }

    // ── Wire up ───────────────────────────────────────────────────────
    document.getElementById('refresh-btn').onclick = loadRuns;
    document.getElementById('status-filter').onchange = (e) => { state.filter.status = e.target.value; loadRuns(); };
    document.getElementById('search-input').oninput = (e) => { state.filter.search = e.target.value; loadRuns(); };
    loadRuns();
    // Live refresh: re-fetch on cache invalidation
    window.addEventListener('message', (e) => {
      if (e.data.type === 'cache.invalidated') {
        if (state.selectedRunId && (e.data.key.includes('spans:') || e.data.key.includes('runs'))) {
          selectRun(state.selectedRunId);  // re-fetch timeline
        }
        loadRuns();
      }
    });
  </script>
</body>
</html>`;
