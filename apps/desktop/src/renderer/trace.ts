// @z-assistant/app-desktop — Trace panel (i18n)
//
// Shows chat sessions with both conversation history and underlying
// run details (spans, token usage, cost, etc.).

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
        <h3>${escapeHtml(session.title)}</h3>
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
        html += `
        <div class="card run-card">
          <div class="run-header">
            <span class="status ${statusClass}">${run.status}</span>
            <span class="muted">${new Date(run.startTime).toLocaleTimeString()}</span>
            <span class="muted">${duration}</span>
          </div>
          <div class="run-task muted">${escapeHtml(run.task.slice(0, 100))}</div>
          <div class="run-metrics">
            <span>${t('trace.tokens_in')}: ${(run.totalTokensIn ?? 0).toLocaleString()}</span>
            <span>${t('trace.tokens_out')}: ${(run.totalTokensOut ?? 0).toLocaleString()}</span>
            <span>${t('trace.cost')}: $${(run.totalCostUsd ?? 0).toFixed(6)}</span>
            <span>ID: ${escapeHtml(run.id.slice(0, 8))}</span>
          </div>
          <button class="load-spans-btn" data-runid="${escapeHtml(run.id)}">${t('trace.load_spans')}</button>
          <div class="spans-container" id="spans-${escapeHtml(run.id)}"></div>
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

    // Bind "load spans" buttons
    detail.querySelectorAll('.load-spans-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const runId = (btn as HTMLElement).dataset.runid!;
        await loadSpans(runId);
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    detail.innerHTML = `<p class="status error">${t('chat.error')}: ${escapeHtml(msg)}</p>`;
  }
}

// ── Load spans for a run ─────────────────────────────────────────────

async function loadSpans(runId: string): Promise<void> {
  const container = document.getElementById(`spans-${runId}`);
  if (!container) return;
  container.innerHTML = `<p class="muted">${t('trace.loading')}</p>`;
  try {
    const spans = await zApi.getSpans(runId);
    if (spans.length === 0) {
      container.innerHTML = `<p class="muted">${t('trace.no_spans')}</p>`;
      return;
    }
    container.innerHTML = spans
      .map((s) => {
        const dur = s.duration ? `${s.duration.toFixed(0)}ms` : '—';
        const typeIcon = s.type === 'llm' ? '🤖' : s.type === 'tool' ? '🔧' : s.type === 'planner' ? '📋' : '•';
        const input = s.input ? JSON.stringify(s.input, null, 2).slice(0, 300) : '';
        const output = s.output ? JSON.stringify(s.output, null, 2).slice(0, 300) : '';
        const error = s.error ? escapeHtml(JSON.stringify(s.error)) : '';
        const attrs = s.attributes && Object.keys(s.attributes).length > 0
          ? Object.entries(s.attributes).map(([k, v]) => `<span class="attr">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`).join(' ')
          : '';
        const events = s.events && s.events.length > 0
          ? s.events.map(e => `<span class="event">${escapeHtml(e.name)}</span>`).join(' ')
          : '';
        const tokens = s.tokensIn || s.tokensOut
          ? `<span class="muted">↑${s.tokensIn ?? 0} ↓${s.tokensOut ?? 0}</span>`
          : '';
        return `<div class="span-item">
          <div class="span-header">
            <span class="span-type-icon">${typeIcon}</span>
            <strong>${escapeHtml(s.name)}</strong>
            <span class="muted">${dur}</span>
            ${tokens}
            <span class="span-status ${s.status === 'ok' ? 'ok' : s.status === 'error' ? 'error' : ''}">${s.status}</span>
          </div>
          ${attrs ? `<div class="span-attrs">${attrs}</div>` : ''}
          ${events ? `<div class="span-events">${events}</div>` : ''}
          ${input ? `<details><summary>Input</summary><pre class="span-output">${escapeHtml(input)}</pre></details>` : ''}
          ${output ? `<details><summary>Output</summary><pre class="span-output">${escapeHtml(output)}</pre></details>` : ''}
          ${error ? `<div class="span-error">${error}</div>` : ''}
        </div>`;
      })
      .join('');
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
