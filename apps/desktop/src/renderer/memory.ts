// @ziner/app-desktop — Memory panel
//
// Displays stored memories from the V2 memory system.
// Allows filtering by kind, searching, viewing details,
// deleting individual memories, purging all memories,
// and exporting all memories as JSON.

declare const zApi: import('../preload').ZDesktopAPI;
import { t } from './i18n';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const KIND_LABELS: Record<string, string> = {
  'long-term': 'memory.long_term',
  'episodic': 'memory.episodic',
  'preference': 'memory.preference',
  'semantic': 'memory.semantic',
  'procedural': 'memory.procedural',
  'short-term': 'memory.short_term',
};

const ALL_KINDS = ['long-term', 'episodic', 'preference', 'semantic', 'procedural', 'short-term'];

let currentKindFilter = 'all';
let currentSearchQuery = '';

async function loadMemories(): Promise<void> {
  const list = document.getElementById('memory-list')!;
  list.innerHTML = `<p class="muted">${t('memory.loading')}</p>`;

  try {
    const kind = currentKindFilter === 'all' ? undefined : currentKindFilter;
    let memories = await zApi.listMemories(kind, 200);

    // Client-side keyword filter if search query is set
    if (currentSearchQuery.trim()) {
      const q = currentSearchQuery.toLowerCase();
      memories = memories.filter((m) =>
        m.content.toLowerCase().includes(q) ||
        m.kind.toLowerCase().includes(q)
      );
    }

    if (memories.length === 0) {
      list.innerHTML = `<p class="muted">${t('memory.no_data')}</p>`;
      return;
    }

    list.innerHTML = memories
      .map((m) => {
        const kindLabel = t(KIND_LABELS[m.kind] || m.kind);
        const date = new Date(m.createdAt).toLocaleString();
        const content = m.content.length > 200
          ? m.content.slice(0, 200) + '…'
          : m.content;
        const importance = m.importance !== undefined
          ? Math.round(m.importance * 100)
          : null;
        return `
          <div class="memory-card" data-id="${escapeHtml(m.id)}">
            <div class="memory-card-header">
              <div class="memory-card-tags">
                <span class="memory-kind-badge memory-kind-${m.kind}">${escapeHtml(kindLabel)}</span>
                ${importance !== null ? `<span class="memory-importance-badge" title="重要度">⭐ ${importance}%</span>` : ''}
              </div>
              <div class="memory-card-actions">
                <button class="memory-delete-btn" title="${t('memory.delete')}" data-id="${escapeHtml(m.id)}">🗑️</button>
              </div>
            </div>
            <div class="memory-card-content">${escapeHtml(content)}</div>
            <div class="memory-card-footer">
              <span class="memory-date muted">📅 ${escapeHtml(date)}</span>
              ${m.scope ? `<span class="memory-scope muted">📍 ${escapeHtml(m.scope)}</span>` : ''}
            </div>
            <details class="memory-card-detail">
              <summary>${t('trace.attributes')}</summary>
              <pre class="memory-meta">${escapeHtml(JSON.stringify({
                id: m.id,
                kind: m.kind,
                scope: m.scope,
                userId: m.userId,
                sessionId: m.sessionId,
                agentName: m.agentName,
                importance: m.importance,
                createdAt: new Date(m.createdAt).toISOString(),
                accessedAt: m.accessedAt ? new Date(m.accessedAt).toISOString() : undefined,
              }, null, 2))}</pre>
            </details>
          </div>
        `;
      })
      .join('');

    // Bind delete buttons
    list.querySelectorAll('.memory-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id;
        if (!id) return;
        if (!confirm(t('memory.delete_confirm'))) return;
        try {
          await zApi.deleteMemory(id);
          await loadMemories();
          await updateStats();
        } catch (err) {
          console.error('Delete memory error:', err);
        }
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    list.innerHTML = `<p class="status error">${t('memory.failed_load')}: ${escapeHtml(msg)}</p>`;
  }
}

async function updateStats(): Promise<void> {
  const totalEl = document.getElementById('memory-total-count');
  if (!totalEl) return;
  try {
    const total = await zApi.countMemories();
    totalEl.textContent = String(total);
    // Update per-kind counts
    for (const kind of ALL_KINDS) {
      const el = document.getElementById(`memory-count-${kind}`);
      if (el) {
        const count = await zApi.countMemories(kind);
        el.textContent = String(count);
      }
    }
  } catch {
    // ignore
  }
}

function downloadJson(data: string, filename: string): void {
  const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function mountMemory(container: HTMLElement): void {
  container.innerHTML = `
    <div class="memory-page">
      <div class="memory-header-card">
        <div class="memory-header-top">
          <div class="memory-header-title">
            <span class="memory-header-icon">🧠</span>
            <div>
              <h3>${t('memory.title')}</h3>
              <p class="muted">${t('memory.manage_desc')}</p>
            </div>
          </div>
          <div class="memory-header-actions">
            <button id="memory-export-btn" class="secondary" title="${t('memory.export')}">
              <span>📤</span> ${t('memory.export')}
            </button>
            <button id="memory-purge-btn" class="secondary danger" title="${t('memory.purge')}">
              <span>🗑️</span> ${t('memory.purge')}
            </button>
            <button id="memory-refresh" class="primary" title="${t('memory.refresh')}">
              <span>↻</span> ${t('memory.refresh')}
            </button>
          </div>
        </div>
        <div class="memory-stats-grid">
          <div class="memory-stat-card memory-stat-total">
            <span class="memory-stat-label">${t('memory.total')}</span>
            <span class="memory-stat-value" id="memory-total-count">—</span>
            <span class="memory-stat-unit">${t('memory.count')}</span>
          </div>
          ${ALL_KINDS.map((k) => `
            <div class="memory-stat-card" data-kind="${k}">
              <span class="memory-stat-label">${t(KIND_LABELS[k])}</span>
              <span class="memory-stat-value" id="memory-count-${k}">—</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="memory-toolbar">
        <div class="memory-filter-tabs">
          <button class="memory-filter-tab active" data-kind="all">${t('memory.all')}</button>
          ${ALL_KINDS.map((k) => `
            <button class="memory-filter-tab" data-kind="${k}">${t(KIND_LABELS[k])}</button>
          `).join('')}
        </div>
        <div class="memory-search-wrapper">
          <span class="memory-search-icon">🔍</span>
          <input id="memory-search-input" type="text" placeholder="${t('memory.search_placeholder')}">
        </div>
      </div>

      <div id="memory-list" class="memory-list"></div>
    </div>
  `;

  const filterTabs = container.querySelectorAll('.memory-filter-tab');
  const refreshBtn = document.getElementById('memory-refresh') as HTMLButtonElement;
  const searchInput = document.getElementById('memory-search-input') as HTMLInputElement;
  const purgeBtn = document.getElementById('memory-purge-btn') as HTMLButtonElement;
  const exportBtn = document.getElementById('memory-export-btn') as HTMLButtonElement;

  async function reload(): Promise<void> {
    currentSearchQuery = searchInput.value;
    await Promise.all([loadMemories(), updateStats()]);
  }

  filterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      filterTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentKindFilter = (tab as HTMLElement).dataset.kind || 'all';
      reload();
    });
  });

  refreshBtn.addEventListener('click', reload);

  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(reload, 200);
  });

  purgeBtn.addEventListener('click', async () => {
    if (!confirm(t('memory.purge_confirm'))) return;
    try {
      const count = await zApi.purgeMemories();
      console.log(`Purged ${count} memories`);
      await reload();
    } catch (err) {
      console.error('Purge error:', err);
    }
  });

  exportBtn.addEventListener('click', async () => {
    try {
      const data = await zApi.exportMemories();
      downloadJson(data, `memories_${new Date().toISOString().slice(0, 10)}.json`);
    } catch (err) {
      console.error('Export error:', err);
    }
  });

  // Initial load
  reload();
}

// Auto-mount
let memoryInitialized = false;
const observer = new MutationObserver(() => {
  const container = document.getElementById('view-memory');
  if (container && !container.querySelector('#memory-list') && !memoryInitialized) {
    memoryInitialized = true;
    mountMemory(container);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export { mountMemory, memoryInitialized };
