// @ziner/app-desktop — Trace panel (i18n)
//
// Shows chat sessions with detailed run timeline (waterfall view),
// span hierarchy, LLM/tool details, agent info, and audit logs.

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

// ── Session detail (waterfall timeline) ──────────────────────────────

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
          <div class="row" style="gap:6px">
            <button class="trace-create-skill secondary" data-sessionid="${escapeHtml(session.id)}" style="font-size:0.82em">${t('trace.create_skill')}</button>
            <button class="trace-export-btn secondary" data-sessionid="${escapeHtml(session.id)}" style="font-size:0.82em">${t('trace.export')}</button>
          </div>
        </div>
        <p class="muted">${t('trace.created')}: ${new Date(session.createdAt).toLocaleString()}</p>
        <p class="muted">${t('trace.updated')}: ${new Date(session.updatedAt).toLocaleString()}</p>
        <p class="muted">${session.messages.length} ${t('trace.messages')} | ${runs.length} ${t('trace.runs')}</p>
      </div>`;

    // ── Runs detail ───────────────────────────────────────────────
    if (runs.length > 0) {
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

      // Per-run waterfall cards
      for (const run of runs) {
        html += renderRunCard(run);
      }
    } else {
      html += `<div class="card"><p class="muted">${t('trace.no_runs')}</p></div>`;
    }

    // Conversation history lives in the Chat view (sessions.json is the
    // single source of truth for messages). The Trace view is for spans /
    // runs / cost — it deliberately does not duplicate the chat history.
    // Keeping the conversation card out of Trace prevents the user from
    // seeing the same content in two places.

    detail.innerHTML = html;

    // Auto-load spans for all runs
    detail.querySelectorAll('.load-spans-btn').forEach((btn) => {
      const runId = (btn as HTMLElement).dataset.runid!;
      setTimeout(() => loadSpans(runId), 100);
      btn.addEventListener('click', async () => { await loadSpans(runId); });
    });

    // Bind audit log buttons
    detail.querySelectorAll('.load-audit-btn').forEach((btn) => {
      const runId = (btn as HTMLElement).dataset.runid!;
      btn.addEventListener('click', async () => { await loadAuditEntries(runId); });
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

    // Bind create-skill button
    detail.querySelectorAll('.trace-create-skill').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = (btn as HTMLElement).dataset.sessionid!;
        (btn as HTMLButtonElement).disabled = true;
        (btn as HTMLButtonElement).textContent = t('trace.creating_skill');
        try {
          const result = await zApi.createSkillFromSession(sid);
          alert(`${t('trace.skill_created')}: ${result.name}\n${t('trace.skill_path')}: ${result.path}`);
        } catch (err: unknown) {
          alert(`${t('trace.skill_error')}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          (btn as HTMLButtonElement).disabled = false;
          (btn as HTMLButtonElement).textContent = t('trace.create_skill');
        }
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    detail.innerHTML = `<p class="status error">${t('chat.error')}: ${escapeHtml(msg)}</p>`;
  }
}

// ── Render a single run card (waterfall header) ──────────────────────

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

function renderRunCard(run: any): string {
  const statusClass = run.status === 'success' ? 'ok' : run.status === 'failed' ? 'error' : '';
  const statusLabel = run.status === 'success' ? '✓ ' + t('trace.success') : run.status === 'failed' ? '✗ ' + t('trace.failed') : run.status;
  const duration = formatDuration(run.duration);
  const modelInfo = run.model
    ? `${run.model.provider}/${run.model.name}`
    : '—';
  const agents = run.tags?.filter((t: string) => t.startsWith('agent:'))?.map((t: string) => t.slice(6)).join(', ') || '—';

  const totalTokens = (run.totalTokensIn ?? 0) + (run.totalTokensOut ?? 0);
  const tokenInPct = totalTokens > 0 ? ((run.totalTokensIn ?? 0) / totalTokens) * 100 : 0;

  return `
    <div class="card run-card">
      <div class="run-header">
        <span class="status-badge status-${run.status || 'unknown'}">${statusLabel}</span>
        <span class="run-time muted">🕐 ${new Date(run.startTime).toLocaleTimeString()}</span>
        <span class="run-duration">⏱ ${duration}</span>
        <span class="run-model muted" style="margin-left:auto">${t('trace.model')}: ${escapeHtml(modelInfo)}</span>
      </div>
      <div class="run-task">${escapeHtml(run.task.slice(0, 200))}</div>
      
      <div class="run-stats-grid">
        <div class="run-stat-item">
          <div class="run-stat-label">${t('trace.agents')}</div>
          <div class="run-stat-value">${escapeHtml(agents)}</div>
        </div>
        <div class="run-stat-item">
          <div class="run-stat-label">${t('trace.tokens_in')}</div>
          <div class="run-stat-value token-in">${(run.totalTokensIn ?? 0).toLocaleString()}</div>
        </div>
        <div class="run-stat-item">
          <div class="run-stat-label">${t('trace.tokens_out')}</div>
          <div class="run-stat-value token-out">${(run.totalTokensOut ?? 0).toLocaleString()}</div>
        </div>
        <div class="run-stat-item">
          <div class="run-stat-label">${t('trace.cost')}</div>
          <div class="run-stat-value cost">$${(run.totalCostUsd ?? 0).toFixed(6)}</div>
        </div>
      </div>
      
      ${totalTokens > 0 ? `
      <div class="token-visual">
        <div class="token-bar">
          <div class="token-bar-in" style="width:${tokenInPct}%" title="${t('trace.tokens_in')}: ${(run.totalTokensIn ?? 0).toLocaleString()}"></div>
          <div class="token-bar-out" style="width:${100 - tokenInPct}%" title="${t('trace.tokens_out')}: ${(run.totalTokensOut ?? 0).toLocaleString()}"></div>
        </div>
        <div class="token-legend">
          <span class="legend-item"><span class="legend-dot legend-in"></span>${t('trace.tokens_in')} ${tokenInPct.toFixed(0)}%</span>
          <span class="legend-item"><span class="legend-dot legend-out"></span>${t('trace.tokens_out')} ${(100 - tokenInPct).toFixed(0)}%</span>
          <span class="legend-total">${t('trace.total')}: ${totalTokens.toLocaleString()}</span>
        </div>
      </div>` : ''}
      
      <div class="row run-actions" style="gap:6px">
        <button class="load-spans-btn primary" data-runid="${escapeHtml(run.id)}">
          <span class="btn-icon">📊</span>${t('trace.load_spans')}
        </button>
        <button class="load-audit-btn secondary" data-runid="${escapeHtml(run.id)}">
          <span class="btn-icon">📋</span>${t('trace.load_audit')}
        </button>
        <span class="run-id muted">ID: ${escapeHtml(run.id.slice(0, 8))}</span>
      </div>
      <div class="spans-container" id="spans-${escapeHtml(run.id)}"></div>
      <div class="audit-container" id="audit-${escapeHtml(run.id)}" style="margin-top:8px"></div>
    </div>`;
}

// ── Waterfall timeline ───────────────────────────────────────────────

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
  const filterStatus = (document.getElementById(`span-filter-status-${runId}`) as HTMLSelectElement)?.value || 'all';
  const searchText = (document.getElementById(`span-search-${runId}`) as HTMLInputElement)?.value?.toLowerCase() || '';

  let filtered = allSpans;
  if (filterType !== 'all') {
    filtered = filtered.filter((s) => s.type === filterType);
  }
  if (filterStatus !== 'all') {
    filtered = filtered.filter((s) => {
      if (filterStatus === 'running') return s.status === 'running' || !s.status;
      return s.status === filterStatus;
    });
  }
  if (searchText) {
    filtered = filtered.filter((s) =>
      s.name?.toLowerCase().includes(searchText) ||
      s.agent?.toLowerCase().includes(searchText) ||
      JSON.stringify(s.input ?? '').toLowerCase().includes(searchText) ||
      JSON.stringify(s.output ?? '').toLowerCase().includes(searchText)
    );
  }

  if (filtered.length === 0) {
    container.querySelector('.span-list')!.innerHTML = `<p class="empty-state">${t('trace.no_spans')}</p>`;
    return;
  }

  // Compute timeline bounds for waterfall bars
  const minStart = Math.min(...filtered.map((s) => s.startTime));
  const maxEnd = Math.max(...filtered.map((s) => s.endTime ?? s.startTime));
  const totalDuration = maxEnd - minStart || 1;

  // Summary stats
  const llmCount = filtered.filter((s) => s.type === 'llm').length;
  const toolCount = filtered.filter((s) => s.type === 'tool').length;
  const totalTokens = filtered.reduce((sum, s) => {
    if (s.type === 'llm' && s.attributes) {
      const inTok = s.attributes['gen_ai.usage.input_tokens'] || 0;
      const outTok = s.attributes['gen_ai.usage.output_tokens'] || 0;
      return sum + inTok + outTok;
    }
    return sum;
  }, 0);

  const listEl = container.querySelector('.span-list');
  if (listEl) {
    listEl.innerHTML = filtered
      .map((s) => renderSpanItem(s, minStart, totalDuration, 0))
      .join('');
  }

  // Update filter stats
  const statsEl = container.querySelector('.filter-stats');
  if (statsEl && filtered.length !== allSpans.length) {
    statsEl.innerHTML = `<span class="muted">${filtered.length} / ${allSpans.length} ${t('trace.total')}</span>`;
  }
}

function buildSpanTree(spans: any[]): any[] {
  const map = new Map<string, any>();
  const roots: any[] = [];
  for (const s of spans) {
    map.set(s.id, { ...s, children: [] });
  }
  for (const s of spans) {
    const node = map.get(s.id)!;
    if (s.parentSpanId && map.has(s.parentSpanId)) {
      map.get(s.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function renderSpanItem(s: any, minStart: number, totalDuration: number, depth: number): string {
  const dur = s.duration ? `${s.duration.toFixed(0)}ms` : '—';
  const typeColors: Record<string, { icon: string; bg: string; text: string }> = {
    llm: { icon: '🤖', bg: 'var(--llm-bg, #eef2ff)', text: 'var(--llm-fg, #6366f1)' },
    tool: { icon: '🔧', bg: 'var(--tool-bg, #ecfdf5)', text: 'var(--tool-fg, #10b981)' },
    planner: { icon: '📋', bg: 'var(--planner-bg, #fef3c7)', text: 'var(--planner-fg, #f59e0b)' },
    agent: { icon: '👤', bg: 'var(--agent-bg, #f3e8ff)', text: 'var(--agent-fg, #a855f7)' },
  };
  const typeStyle = typeColors[s.type] || { icon: '•', bg: 'var(--bg)', text: 'var(--text-secondary)' };
  const hasError = s.status === 'error';

  // Waterfall bar position
  const offset = ((s.startTime - minStart) / totalDuration) * 100;
  const width = s.endTime ? ((s.endTime - s.startTime) / totalDuration) * 100 : 2;
  const barColor = hasError ? 'var(--danger)' : typeStyle.text;
  const waterfallBar = s.endTime
    ? `<div class="waterfall-bar" style="margin-left:${offset}%;width:${Math.max(width, 1)}%;background:${barColor}"></div>`
    : '';

  // Duration percentage
  const durPct = s.duration ? ((s.duration / totalDuration) * 100).toFixed(1) : null;

  // LLM-specific details
  let llmDetails = '';
  if (s.type === 'llm' && s.attributes) {
    const model = s.attributes['gen_ai.request.model'] || s.attributes['gen_ai.system'] || '';
    const inputTokens = s.attributes['gen_ai.usage.input_tokens'];
    const outputTokens = s.attributes['gen_ai.usage.output_tokens'];
    const inputCost = s.attributes['gen_ai.usage.input_cost'];
    const outputCost = s.attributes['gen_ai.usage.output_cost'];
    if (model) {
      llmDetails += `<span class="attr">${escapeHtml(String(model))}</span>`;
    }
    if (inputTokens !== undefined) {
      llmDetails += `<span class="attr attr-in">↑ ${inputTokens.toLocaleString()}</span>`;
    }
    if (outputTokens !== undefined) {
      llmDetails += `<span class="attr attr-out">↓ ${outputTokens.toLocaleString()}</span>`;
    }
    if (inputCost !== undefined || outputCost !== undefined) {
      const cost = (Number(inputCost || 0) + Number(outputCost || 0)).toFixed(6);
      llmDetails += `<span class="attr attr-cost">$${cost}</span>`;
    }
  }

  // Tool-specific details
  let toolDetails = '';
  if (s.type === 'tool' && s.input) {
    const input = s.input as any;
    const toolName = input.name || input.toolName || s.name.replace('tool:', '');
    const args = input.arguments || input.args || {};
    toolDetails = `<div class="span-tool-call">
      <code>${escapeHtml(toolName)}</code>
      ${Object.keys(args).length > 0 ? `<pre class="span-args">${escapeHtml(JSON.stringify(args, null, 2))}</pre>` : ''}
    </div>`;
  }

  // Agent badge
  const agentBadge = s.agent
    ? `<span class="agent-badge">${escapeHtml(s.agent)}</span>`
    : '';

  // Type badge
  const typeBadge = `<span class="span-type-badge span-type-${s.type || 'default'}">${typeStyle.icon} ${s.type || 'span'}</span>`;

  // Input/Output details (collapsible)
  const inputStr = s.input ? JSON.stringify(s.input, null, 2) : '';
  const outputStr = s.output ? JSON.stringify(s.output, null, 2) : '';
  const hasDetails = inputStr.length > 0 || outputStr.length > 0 || s.events?.length > 0;

  // Error details (auto-expanded)
  const errorHtml = s.error
    ? `<details open class="span-error-details"><summary>❌ ${t('trace.error')}</summary><pre class="span-error">${escapeHtml(JSON.stringify(s.error, null, 2))}</pre></details>`
    : '';

  // Events
  const eventsHtml = s.events && s.events.length > 0
    ? `<details class="span-events-details"><summary>📌 ${s.events.length} events</summary><div class="span-events">${s.events.map((e: any) => `<span class="event">${escapeHtml(e.name)} @ ${new Date(e.ts).toLocaleTimeString()}</span>`).join('')}</div></details>`
    : '';

  // Input/Output collapsible sections
  const ioDetails = hasDetails
    ? `<div class="span-io">
        ${inputStr ? `<details ${hasError ? 'open' : ''}><summary>📥 ${t('trace.input')}</summary><pre class="span-output">${escapeHtml(inputStr.slice(0, 2000))}${inputStr.length > 2000 ? '...' : ''}</pre></details>` : ''}
        ${outputStr ? `<details ${hasError ? 'open' : ''}><summary>📤 ${t('trace.output')}</summary><pre class="span-output">${escapeHtml(outputStr.slice(0, 2000))}${outputStr.length > 2000 ? '...' : ''}</pre></details>` : ''}
      </div>`
    : '';

  // Waterfall row
  return `
    <div class="span-item span-type-${s.type || 'default'} ${hasError ? 'has-error' : ''}" style="margin-left:${depth * 20}px">
      <div class="span-header">
        <div class="span-header-left">
          ${typeBadge}
          <strong class="span-name">${escapeHtml(s.name)}</strong>
          ${agentBadge}
        </div>
        <div class="span-header-right">
          <span class="span-duration">${dur}${durPct ? ` <span class="span-duration-pct">(${durPct}%)</span>` : ''}</span>
          <span class="span-status ${s.status || ''}">${hasError ? '❌' : s.status === 'ok' ? '✓' : '⏳'}</span>
        </div>
      </div>
      ${waterfallBar ? `<div class="waterfall-track">${waterfallBar}</div>` : ''}
      ${llmDetails ? `<div class="span-attrs">${llmDetails}</div>` : ''}
      ${toolDetails}
      ${errorHtml}
      ${eventsHtml}
      ${ioDetails}
    </div>`;
}

// ── Load spans ───────────────────────────────────────────────────────

async function loadSpans(runId: string): Promise<void> {
  const container = document.getElementById(`spans-${runId}`);
  if (!container) return;
  const btn = document.querySelector(`.load-spans-btn[data-runid="${runId}"]`) as HTMLButtonElement | null;
  if (btn) btn.textContent = t('trace.loading');
  container.innerHTML = `<p class="muted">${t('trace.loading')}</p>`;
  try {
    const spans = await zApi.getSpans(runId);
    spansCache.set(runId, spans);

    // Add filter controls above spans
    const filterHtml = spans.length > 0
      ? `<div class="span-filters">
          <div class="filter-group">
            <label class="filter-label">${t('trace.filter')}:</label>
            <select id="span-filter-type-${runId}" class="filter-select">
              <option value="all">${t('trace.all')} (${spans.length})</option>
              <option value="llm">🤖 LLM (${spans.filter((s: any) => s.type === 'llm').length})</option>
              <option value="tool">🔧 ${t('trace.tools')} (${spans.filter((s: any) => s.type === 'tool').length})</option>
              <option value="planner">📋 Planner (${spans.filter((s: any) => s.type === 'planner').length})</option>
              <option value="agent">👤 Agent (${spans.filter((s: any) => s.type === 'agent').length})</option>
            </select>
          </div>
          <div class="filter-group">
            <select id="span-filter-status-${runId}" class="filter-select">
              <option value="all">${t('trace.all_status')}</option>
              <option value="ok">✓ ${t('trace.success')} (${spans.filter((s: any) => s.status === 'ok').length})</option>
              <option value="error">❌ ${t('trace.failed')} (${spans.filter((s: any) => s.status === 'error').length})</option>
              <option value="running">⏳ Running (${spans.filter((s: any) => s.status === 'running' || !s.status).length})</option>
            </select>
          </div>
          <div class="filter-group filter-search">
            <span class="search-icon">🔍</span>
            <input id="span-search-${runId}" type="text" placeholder="${t('trace.search_spans')}" class="filter-search-input">
          </div>
          <div class="filter-stats">
            <span class="muted">${spans.length} ${t('trace.total')}</span>
          </div>
        </div>`
      : '';

    container.innerHTML = filterHtml + '<div class="span-list"></div>';

    if (spans.length === 0) {
      container.querySelector('.span-list')!.innerHTML = `<p class="muted">${t('trace.no_spans')}</p>`;
      if (btn) btn.textContent = t('trace.no_spans');
      return;
    }

    renderSpans(runId);

    // Bind filter/search events
    const filterSelect = document.getElementById(`span-filter-type-${runId}`) as HTMLSelectElement;
    const statusSelect = document.getElementById(`span-filter-status-${runId}`) as HTMLSelectElement;
    const searchInput = document.getElementById(`span-search-${runId}`) as HTMLInputElement;
    if (filterSelect) {
      filterSelect.addEventListener('change', () => renderSpans(runId));
    }
    if (statusSelect) {
      statusSelect.addEventListener('change', () => renderSpans(runId));
    }
    if (searchInput) {
      let searchTimer: ReturnType<typeof setTimeout> | null = null;
      searchInput.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderSpans(runId), 150);
      });
    }

    if (btn) btn.textContent = `${t('trace.load_spans')} (${spans.length})`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<p class="status error">${t('chat.error')}: ${escapeHtml(msg)}</p>`;
  }
}

// ── Load audit entries ───────────────────────────────────────────────

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
            <div class="muted" style="font-size:0.78em">${ts} · risk: ${e.risk ?? '-'} · decision: ${e.decision ?? '-'}</div>
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

function mountTrace(container: HTMLElement): void {
  container.innerHTML = `
    <div class="stack">
      <div class="row">
        <h2>${t('trace.runs')}</h2>
        <button id="trace-refresh" class="primary">${t('trace.refresh')}</button>
      </div>
      <ul id="trace-list" class="run-list"></ul>
      <div id="trace-detail"></div>
    </div>
    <div class="stack" style="margin-top:24px">
      <div class="row">
        <h2>${t('trace.resumable')}</h2>
        <button id="trace-resumable-refresh" class="secondary" style="font-size:0.78em;padding:4px 8px">${t('trace.refresh')}</button>
      </div>
      <ul id="trace-resumable-list" class="run-list"></ul>
    </div>
  `;

  const list = document.getElementById('trace-list')!;
  document.getElementById('trace-refresh')!.addEventListener('click', loadSessions);
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-sessionid]') as HTMLLIElement;
    if (li) showSessionDetail(li.dataset.sessionid!);
  });
  document.getElementById('trace-resumable-refresh')!.addEventListener('click', loadResumableRuns);
  document.getElementById('trace-resumable-list')!.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-runid]') as HTMLLIElement;
    if (!li) return;
    const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
    const runId = li.dataset.runid!;
    if (action === 'resume') {
      void resumeCheckpoint(runId);
    } else if (action === 'delete') {
      void deleteCheckpoint(runId);
    }
  });
  loadSessions();
  loadResumableRuns();
}

// ── P3 Resumable Runs ────────────────────────────────────────────────

async function loadResumableRuns(): Promise<void> {
  const list = document.getElementById('trace-resumable-list')!;
  list.innerHTML = `<li class="muted">${t('trace.loading')}</li>`;
  try {
    const entries = await zApi.listCheckpoints({ limit: 30 });
    if (entries.length === 0) {
      list.innerHTML = `<li class="muted">${t('trace.no_resumable')}</li>`;
      return;
    }
    list.innerHTML = entries
      .map((e) => {
        const statusLabel = t(`trace.checkpoint_status.${e.status}`);
        const date = new Date(e.updatedAt).toLocaleString();
        const preview = e.task.length > 80 ? e.task.slice(0, 80) + '…' : e.task;
        const resumable = e.status === 'in_progress' || e.status === 'cancelled' || e.status === 'failed';
        return `<li data-runid="${escapeHtml(e.runId)}">
          <div class="session-info">
            <strong>${escapeHtml(preview)}</strong>
            <span class="muted">${date} · ${statusLabel}</span>
          </div>
          <div class="session-meta">
            <span class="muted">${e.completedCount}/${e.totalCount} ${t('trace.subtasks')}</span>
            <span style="display:flex;gap:4px">
              ${
                resumable
                  ? `<button class="primary" data-action="resume" style="font-size:0.78em;padding:3px 8px">${t('trace.resume')}</button>`
                  : ''
              }
              <button class="secondary" data-action="delete" style="font-size:0.78em;padding:3px 8px">${t('trace.delete')}</button>
            </span>
          </div>
        </li>`;
      })
      .join('');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    list.innerHTML = `<li class="muted">${t('trace.failed_load')}: ${escapeHtml(msg)}</li>`;
  }
}

async function resumeCheckpoint(runId: string): Promise<void> {
  try {
    await zApi.resumeTask(runId);
    addSystemToast(t('trace.resume_started'));
    // Switch to chat so the user can watch progress.
    const navBtn = document.querySelector<HTMLElement>('[data-view="chat"]');
    navBtn?.click();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addSystemToast(`${t('trace.resume_failed')}: ${msg}`);
  }
}

async function deleteCheckpoint(runId: string): Promise<void> {
  try {
    await zApi.deleteCheckpoint(runId);
    void loadResumableRuns();
  } catch {
    /* ignore */
  }
}

function addSystemToast(text: string): void {
  // Reuse the chat panel's system-message styling by appending a
  // floating toast at the bottom of the viewport.
  const toast = document.createElement('div');
  toast.className = 'message system';
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:1000;box-shadow:0 4px 20px rgba(0,0,0,0.15);animation:messageIn 0.3s ease';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// Auto-mount
let traceInitialized = false;
const observer = new MutationObserver(() => {
  const container = document.getElementById('view-trace');
  if (container && !container.querySelector('#trace-list') && !traceInitialized) {
    traceInitialized = true;
    mountTrace(container);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export { mountTrace, traceInitialized };
