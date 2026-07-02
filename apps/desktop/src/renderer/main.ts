declare const zApi: import('../preload').ZDesktopAPI;
import { t } from './i18n';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function navigateTo(view: string): void {
  const btn = document.querySelector(`#nav button[data-view="${view}"]`) as HTMLElement;
  if (btn) btn.click();
}

async function renderRecentSessions(container: HTMLElement): Promise<void> {
  try {
    const sessions = await zApi.listSessions();
    const recent = sessions.slice(0, 5);

    if (recent.length === 0) {
      container.innerHTML = `
        <div class="main-empty-state">
          <div class="main-empty-icon">💬</div>
          <h4>${t('main.no_sessions')}</h4>
          <p class="muted">${t('main.no_sessions_desc')}</p>
          <button class="primary main-empty-btn" data-action="new-chat">${t('main.new_chat')}</button>
        </div>
      `;
      container.querySelector('[data-action="new-chat"]')?.addEventListener('click', () => navigateTo('chat'));
      return;
    }

    container.innerHTML = recent
      .map((s) => {
        const preview = s.messages.length > 0
          ? s.messages[s.messages.length - 1].content.slice(0, 60)
          : '';
        const date = s.updatedAt
          ? new Date(s.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        return `
          <div class="recent-session-item" data-id="${escapeHtml(s.id)}">
            <div class="recent-session-icon">📝</div>
            <div class="recent-session-content">
              <div class="recent-session-title">${escapeHtml(s.title)}</div>
              <div class="recent-session-preview muted">${escapeHtml(preview)}</div>
            </div>
            <div class="recent-session-meta">
              <span class="muted">${date}</span>
              <span class="recent-session-count">${s.messages.length} ${t('trace.messages')}</span>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.recent-session-item').forEach((item) => {
      item.addEventListener('click', () => {
        const id = (item as HTMLElement).dataset.id;
        if (id) {
          navigateTo('chat');
          setTimeout(() => {
            const sessionItem = document.querySelector(`.session-item[data-id="${id}"]`) as HTMLElement;
            if (sessionItem) sessionItem.click();
          }, 100);
        }
      });
    });
  } catch {
    container.innerHTML = `<p class="muted">Failed to load sessions</p>`;
  }
}

function renderMainView(container: HTMLElement): void {
  container.innerHTML = `
    <div class="main-container">
      <div class="main-hero">
        <div class="main-hero-badge">✨ AI Powered</div>
        <h1 class="main-title">${t('main.title')}</h1>
        <p class="main-description">${t('main.description')}</p>
      </div>

      <div class="main-section">
        <h3 class="main-section-title">${t('main.quick_actions')}</h3>
        <div class="quick-actions-grid">
          <div class="quick-action-card" data-action="new-chat">
            <div class="quick-action-icon">💬</div>
            <div class="quick-action-content">
              <h4>${t('main.new_chat')}</h4>
              <p class="muted">${t('main.new_chat_desc')}</p>
            </div>
            <div class="quick-action-arrow">→</div>
          </div>
          <div class="quick-action-card" data-action="memory">
            <div class="quick-action-icon">🧠</div>
            <div class="quick-action-content">
              <h4>${t('main.view_memory')}</h4>
              <p class="muted">${t('main.view_memory_desc')}</p>
            </div>
            <div class="quick-action-arrow">→</div>
          </div>
          <div class="quick-action-card" data-action="trace">
            <div class="quick-action-icon">📊</div>
            <div class="quick-action-content">
              <h4>${t('main.view_trace')}</h4>
              <p class="muted">${t('main.view_trace_desc')}</p>
            </div>
            <div class="quick-action-arrow">→</div>
          </div>
          <div class="quick-action-card" data-action="settings">
            <div class="quick-action-icon">⚙️</div>
            <div class="quick-action-content">
              <h4>${t('main.open_settings')}</h4>
              <p class="muted">${t('main.open_settings_desc')}</p>
            </div>
            <div class="quick-action-arrow">→</div>
          </div>
        </div>
      </div>

      <div class="main-two-col">
        <div class="main-section">
          <div class="main-section-header">
            <h3 class="main-section-title">${t('main.recent_sessions')}</h3>
          </div>
          <div id="main-recent-sessions" class="recent-sessions-list"></div>
        </div>

        <div class="main-section">
          <h3 class="main-section-title">${t('main.capabilities')}</h3>
          <div class="capabilities-list">
            <div class="capability-item">
              <div class="capability-icon">🤝</div>
              <div>
                <h4>${t('main.cap_multi_agent')}</h4>
                <p class="muted">${t('main.cap_multi_agent_desc')}</p>
              </div>
            </div>
            <div class="capability-item">
              <div class="capability-icon">🧠</div>
              <div>
                <h4>${t('main.cap_memory')}</h4>
                <p class="muted">${t('main.cap_memory_desc')}</p>
              </div>
            </div>
            <div class="capability-item">
              <div class="capability-icon">🔧</div>
              <div>
                <h4>${t('main.cap_tools')}</h4>
                <p class="muted">${t('main.cap_tools_desc')}</p>
              </div>
            </div>
            <div class="capability-item">
              <div class="capability-icon">📋</div>
              <div>
                <h4>${t('main.cap_plan')}</h4>
                <p class="muted">${t('main.cap_plan_desc')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('.quick-action-card').forEach((card) => {
    card.addEventListener('click', () => {
      const action = (card as HTMLElement).dataset.action;
      if (action) navigateTo(action);
    });
  });

  const recentSessionsEl = document.getElementById('main-recent-sessions');
  if (recentSessionsEl) {
    renderRecentSessions(recentSessionsEl);
  }
}

function mountMain(container: HTMLElement): void {
  renderMainView(container);
}

let mainInitialized = false;
const observer = new MutationObserver(() => {
  const container = document.getElementById('view-main');
  if (container && !container.querySelector('.main-container') && !mainInitialized) {
    mainInitialized = true;
    mountMain(container);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export { mountMain, mainInitialized };
