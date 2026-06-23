// @z-assistant/app-desktop — Trace panel (i18n)
//
// Shows chat sessions with both conversation history and underlying
// run details (spans, token usage, cost, etc.).
// Enhanced with model info, tool call details, error details, and export.

declare const zApi: import('../preload').ZDesktopAPI;
import { t } from './i18n';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Session list ─────────────────────────────────────────────────────

async function loadSessions(): Promise<void> {
  const list = document.getElementById('trace-list')!;
  const detail = document.getElementById('trace-detail')!;
  detail.innerHTML = '';
  try {
    const sessions = await zApi.listSessions();
    if (sessions.length === 0) {
      list.innerHTML = `<li class="muted">${t('trace.no_sessions')}</li>`;
      return;
    }
    list.innerHTML = sessions
      .map((s) => {
        const msgCount = s.messages.length;
        const lastMsg = msgCount > 0
          ? s.messages[msgCount - 1].content.slice(0, 60)
          : '';
        const date = new Date(s.updatedAt).toLocaleString();
        return `<li data-sessionid="${escapeHtml(s.id)}">
          <div class="session-info">
            <strong>${escapeHtml(s.title)}</strong>
            <span class="muted">${date}</span>
          </div>
          <div class="session-meta">
            <span class="muted">${msgCount} ${t('trace.messages')}</span>
            <span class="muted">${escapeHtml(lastMsg)}</span>
          </div>
        </li>`;
      })
      .join('');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    list.innerHTML = `<li class="muted">${t('trace.failed_load')}: ${escapeHtml(msg)}</li>`;
  }
}

// ── Session detail (conversation + runs) ─────────────────────────────

async function showSessionDetail(sessionId: string): Promise<void> {
  const detail = document.getElementById('trace-detail')!;
  detail.innerHTML = `<p class="muted">${t('trace.loading')}</p>`;
  try {
    const [session, runs] = await Promise.all([
      zApi.getSession(sessionId),
      zApi.listRuns(200, sessionId),
    ]);
    if (!session) {
      detail.innerHTML = `<p class="muted">${t('trace.not_found')}</p>`;
      return;
    }

    // ── Header card ───────────────────────────────────────────────
    let html = `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3>${escapeHtml(session.title)}</h3>
          <button class="trace-export-btn secondary" data-sessionid="${escapeHtml(session.id)}" style="font-size:0.82em">${t('trace.export')}</button>
        </div>
        <p class="muted">${t('trace.created')}: ${new Date(session.createdAt).toLocaleString()}</p>
        <p class="muted">${t('trace.updated')}: ${new Date(session.updatedAt).toLocaleString()}</p>
        <p class="muted">${session.messages.length} ${t('trace.messages')} | ${runs.length} ${t('trace.runs')}</p>
      </div>`;

    // ── Runs detail ───────────────────────────────────────────────
    if (runs.length > 0) {
      // Aggregate totals
      const totalTokensIn = runs.reduce((s, r) => s + (r.totalTokensIn ?? 0), 0);
      const totalTokensOut = runs.reduce((s, r) => s + (r.totalTokensOut ?? 0), 0);
      const totalCost = runs.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);

      html += `
      <div class="card">
        <h4>${t('trace.run_details')}</h4>
        <div class="trace-stats">
          <div class="stat"><span class="muted">${t('trace.total_runs')}</span><strong>${runs.length}</strong></div>
          <div class="stat"><span class="muted">${t('trace.tokens_in')}</span><strong>${totalTokensIn.toLocaleString()}</strong></div>
          <div class="stat"><span class="muted">${t('trace.tokens_out')}</span><strong>${totalTokensOut.toLocaleString()}</strong></div>
          <div class="stat"><span class="muted">${t('trace.cost')}</span><strong>$${totalCost.toFixed(4)}</strong></div>
        </div>
      </div>`;

      // Per-run cards
      for (const run of runs) {
        const statusClass = run.status === 'success' ? 'ok' : run.status === 'failed' ? 'error' : '';
        const duration = run.duration ? `${(run.duration / 1000).toFixed(1)}s` : '—';
        const modelInfo = run.model
          ? `${run.model.provider}/${run.model.name}`
          : '—';
        html += `
        <div class="card run-card">
          <div class="run-header">
            <span class="status ${statusClass}">${run.status}</span>
            <span class="muted">${new Date(run.startTime).toLocaleTimeString()}</span>
            <span class="muted">${duration}</span>
            <span class="muted" style="margin-left:auto;font-size:0.82em">${t('trace.model')}: ${escapeHtml(modelInfo)}</span>
          </div>
          <div class="run-task muted">${escapeHtml(run.task.slice(0, 200))}</div>
          <div class="run-metrics">
            <span>${t('trace.tokens_in')}: ${(run.totalTokensIn ?? 0).toLocaleString()}</span>
            <span>${t('trace.tokens_out')}: ${(run.totalTokensOut ?? 0).toLocaleString()}</span>
            <span>${t('trace.cost')}: $${(run.totalCostUsd ?? 0).toFixed(6)}</span>
            <span>ID: ${escapeHtml(run.id.slice(0, 8))}</span>
          </div>
          <button class="load-spans-btn" data-runid="${escapeHtml(run.id)}">${t('trace.load_spans')}</button>
          <button class="load-audit-btn secondary" data-runid="${escapeHtml(run.id)}" style="margin-left:8px;font-size:0.82em">${t('trace.load_audit')}</button>
          <div class="spans-container" id="spans-${escapeHtml(run.id)}"></div>
          <div class="audit-container" id="audit-${escapeHtml(run.id)}" style="margin-top:8px"></div>
        </div>`;
      }
    } else {
      html += `<div class="card"><p class="muted">${t('trace.no_runs')}</p></div>`;
    }

    // ── Conversation ──────────────────────────────────────────────
    html += `
      <div class="card trace-conversation">
        <h4>${t('trace.conversation')}</h4>
        ${session.messages.map((m) => `
          <div class="trace-msg ${m.role}">
            <strong>${m.role === 'user' ? t('chat.you') : t('chat.assistant')}</strong>
            <span class="muted">${new Date(m.timestamp).toLocaleTimeString()}</span>
            <p>${escapeHtml(m.content)}</p>
          </div>
        `).join('')}
      </div>`;

    detail.innerHTML = html;

    // Auto-load spans for all runs
    detail.querySelectorAll('.load-spans-btn').forEach((btn) => {
      const runId = (btn as HTMLElement).dataset.runid!;
      // Trigger auto-load after a short delay to let UI render
      setTimeout(() => loadSpans(runId), 100);
      // Also keep manual click handler
      btn.addEventListener('click', async () => {
        await loadSpans(runId);
      });
    });

    // Bind audit log buttons
    detail.querySelectorAll('.load-audit-btn').forEach((btn) => {
      const runId = (btn as HTMLElement).dataset.runid!;
      btn.addEventListener('click', async () => {
        await loadAuditEntries(runId);
      });
    });

    // Bind export button
    detail.querySelectorAll('.trace-export-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = (btn as HTMLElement).dataset.sessionid!;
        try {
          const content = await zApi.exportSession(sid, 'markdown');
          const session = await zApi.getSession(sid);
          const filename = `${session?.title ?? 'trace'}_${sid.slice(-8)}.md`;
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err: unknown) {
          console.error('Export error:', err);
        }
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    detail.innerHTML = `<p class="status error">${t('chat.error')}: ${escapeHtml(msg)}</p>`;
  }
}

// ── Load spans for a run ─────────────────────────────────────────────

/** All loaded spans per runId, used for client-side filtering. */
const spansCache = new Map<string, any[]>();

function renderSpans(runId: string): void {
  const container = document.getElementById(`spans-${runId}`);
  if (!container) return;
  const allSpans = spansCache.get(runId);
  if (!allSpans || allSpans.length === 0) {
    container.innerHTML = `<p class="muted">${t('trace.no_spans')}</p>`;
    return;
  }

  // Read filter state
  const filterType = (document.getElementById(`span-filter-type-${runId}`) as HTMLSelectElement)?.value || 'all';
  const searchText = (document.getElementById(`span-search-${runId}`) as HTMLInputElement)?.value?.toLowerCase() || '';

  let filtered = allSpans;
  if (filterType !== 'all') {
    filtered = filtered.filter((s) => s.type === filterType);
  }
  if (searchText) {
    filtered = filtered.filter((s) =>
      s.name?.toLowerCase().includes(searchText) ||
      JSON.stringify(s.input ?? '').toLowerCase().includes(searchText) ||
      JSON.stringify(s.output ?? '').toLowerCase().includes(searchText)
    );
  }

  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted">${t('trace.no_spans')}</p>`;
    return;
  }

  container.innerHTML = filtered
    .map((s) => {
      const dur = s.duration ? `${s.duration.toFixed(0)}ms` : '—';
      const typeIcon = s.type === 'llm' ? '🤖' : s.type === 'tool' ? '🔧' : s.type === 'planner' ? '📋' : '•';
      const input = s.input ? JSON.stringify(s.input, null, 2).slice(0, 500) : '';
      const output = s.output ? JSON.stringify(s.output, null, 2).slice(0, 500) : '';
      const error = s.error ? escapeHtml(JSON.stringify(s.error, null, 2)) : '';
      const attrs = s.attributes && Object.keys(s.attributes).length > 0
        ? Object.entries(s.attributes).map(([k, v]) => `<span class="attr">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`).join(' ')
        : '';
      const events = s.events && s.events.length > 0
        ? s.events.map((e: any) => `<span class="event">${escapeHtml(e.name)}</span>`).join(' ')
        : '';
      const tokens = s.tokensIn || s.tokensOut
        ? `<span class="muted">↑${s.tokensIn ?? 0} ↓${s.tokensOut ?? 0}</span>`
        : '';
      const toolCallInfo = s.type === 'tool' && s.input
        ? `<div class="span-tool-call"><span class="muted">${t('trace.tools')}: </span><code>${escapeHtml(String((s.input as any).name || s.input as any))}</code></div>`
        : '';
      return `<div class="span-item">
        <div class="span-header">
          <span class="span-type-icon">${typeIcon}</span>
          <strong>${escapeHtml(s.name)}</strong>
          <span class="muted">${dur}</span>
          ${tokens}
          <span class="span-status ${s.status === 'ok' ? 'ok' : s.status === 'error' ? 'error' : ''}">${s.status}</span>
        </div>
        ${toolCallInfo}
        ${attrs ? `<div class="span-attrs">${attrs}</div>` : ''}
        ${events ? `<div class="span-events">${events}</div>` : ''}
        ${input ? `<details><summary>${t('trace.input')}</summary><pre class="span-output">${escapeHtml(input)}</pre></details>` : ''}
        ${output ? `<details><summary>${t('trace.output')}</summary><pre class="span-output">${escapeHtml(output)}</pre></details>` : ''}
        ${error ? `<details open><summary>${t('trace.error')}</summary><div class="span-error">${error}</div></details>` : ''}
      </div>`;
    })
    .join('');
}

async function loadSpans(runId: string): Promise<void> {
  const container = document.getElementById(`spans-${runId}`);
  if (!container) return;
  // Update button to show loading
  const btn = document.querySelector(`.load-spans-btn[data-runid="${runId}"]`) as HTMLButtonElement | null;
  if (btn) btn.textContent = t('trace.loading');
  container.innerHTML = `<p class="muted">${t('trace.loading')}</p>`;
  try {
    const spans = await zApi.getSpans(runId);
    spansCache.set(runId, spans);

    // Add filter controls above spans
    const filterHtml = spans.length > 0
      ? `<div class="span-filters" style="display:flex;gap:6px;margin-bottom:6px;align-items:center;font-size:0.82em">
          <label class="muted">${t('trace.filter')}:</label>
          <select id="span-filter-type-${runId}" style="width:auto;font-size:0.85em">
            <option value="all">${t('trace.all')}</option>
            <option value="llm">LLM</option>
            <option value="tool">${t('trace.tools')}</option>
            <option value="planner">Planner</option>
          </select>
          <input id="span-search-${runId}" type="text" placeholder="${t('trace.search_spans')}" style="flex:1;max-width:200px;font-size:0.85em">
          <span class="muted" style="font-size:0.82em">${spans.length} ${t('trace.total')}</span>
        </div>`
      : '';

    container.innerHTML = filterHtml + '<div class="span-list"></div>';

    if (spans.length === 0) {
      container.querySelector('.span-list')!.innerHTML = `<p class="muted">${t('trace.no_spans')}</p>`;
      if (btn) btn.textContent = t('trace.no_spans');
      return;
    }

    // Render spans
    renderSpans(runId);

    // Bind filter/search events
    const filterSelect = document.getElementById(`span-filter-type-${runId}`) as HTMLSelectElement;
    const searchInput = document.getElementById(`span-search-${runId}`) as HTMLInputElement;
    if (filterSelect) {
      filterSelect.addEventListener('change', () => renderSpans(runId));
    }
    if (searchInput) {
      searchInput.addEventListener('input', () => renderSpans(runId));
    }

    if (btn) btn.textContent = `${t('trace.load_spans')} (${spans.length})`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<p class="status error">${t('chat.error')}: ${escapeHtml(msg)}</p>`;
  }
}

// ── Load audit entries for a run ─────────────────────────────────────

async function loadAuditEntries(runId: string): Promise<void> {
  const container = document.getElementById(`audit-${runId}`);
  if (!container) return;
  container.innerHTML = `<p class="muted">${t('trace.loading')}</p>`;
  try {
    const entries = await zApi.listAuditEntries({ runId, limit: 100 });
    if (entries.length === 0) {
      container.innerHTML = `<p class="muted">${t('trace.no_audit')}</p>`;
      return;
    }
    container.innerHTML = `
      <div class="audit-list" style="font-size:0.85em">
        <div class="muted" style="margin-bottom:4px">${entries.length} ${t('trace.audit_entries')}</div>
        ${entries.map((e) => {
          const ts = new Date(e.timestamp).toLocaleTimeString();
          const args = Object.keys(e.args ?? {}).length > 0
            ? `<pre style="white-space:pre-wrap;background:var(--bg);padding:4px;border-radius:4px;margin-top:4px;font-size:0.85em">${escapeHtml(JSON.stringify(e.args, null, 2)).slice(0, 400)}</pre>`
            : '';
          return `<div class="audit-item" style="padding:6px 8px;margin:4px 0;border:1px solid var(--border-light);border-radius:var(--radius-md)">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${escapeHtml(e.toolName ?? 'unknown')}</strong>
              <span class="status ${e.outcome}" style="font-size:0.78em">${e.outcome}</span>
            </div>
            <div class="muted" style="font-size:0.78em">${ts} · risk: ${e.risk ?? '-'}</div>
            ${args}
          </div>`;
        }).join('')}
      </div>`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<p class="status error">${t('chat.error')}: ${escapeHtml(msg)}</p>`;
  }
}

// ── Mount ────────────────────────────────────────────────────────────

export function mountTrace(container: HTMLElement): void {
  container.innerHTML = `
    <div class="stack">
      <div class="row">
        <h2>${t('trace.runs')}</h2>
        <button id="trace-refresh" class="primary">${t('trace.refresh')}</button>
      </div>
      <ul id="trace-list" class="run-list"></ul>
      <div id="trace-detail"></div>
    </div>
  `;

  const list = document.getElementById('trace-list')!;
  document.getElementById('trace-refresh')!.addEventListener('click', loadSessions);
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-sessionid]') as HTMLLIElement;
    if (li) showSessionDetail(li.dataset.sessionid!);
  });
  loadSessions();
}

// Auto-mount
const observer = new MutationObserver(() => {
  const container = document.getElementById('view-trace');
  if (container && !container.querySelector('#trace-list')) {
    mountTrace(container);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export {};
