// @z-assistant/app-desktop — Chat panel with session management

declare const zApi: import('../preload').ZDesktopAPI;
import { t } from './i18n';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

let currentSessionId: string | null = null;

export async function mountChat(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div id="chat-layout">
      <div id="chat-sidebar">
        <div id="chat-sidebar-header">
          <h3>${t('chat.sessions')}</h3>
          <button id="chat-new-btn" class="primary" style="font-size:0.85em;padding:4px 10px">+ ${t('chat.new')}</button>
        </div>
        <div id="chat-session-list"></div>
      </div>
      <div id="chat-main">
        <div id="chat-messages"></div>
        <div id="chat-input-area">
          <textarea id="chat-input" rows="2" placeholder="${t('chat.placeholder')}"></textarea>
          <button id="chat-send" class="primary">${t('chat.send')}</button>
        </div>
      </div>
    </div>
  `;

  const sessionList = document.getElementById('chat-session-list')!;
  const messages = document.getElementById('chat-messages')!;
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('chat-send') as HTMLButtonElement;
  const newBtn = document.getElementById('chat-new-btn') as HTMLButtonElement;

  // ── Helper: add a message bubble ─────────────────────────────────
  function addMessage(role: string, content: string): void {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const label = role === 'user' ? t('chat.you') : t('chat.assistant');
    div.innerHTML = `<strong>${label}</strong><br>${escapeHtml(content)}`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Helper: show/hide progress indicator ─────────────────────────
  let progressEl: HTMLElement | null = null;
  function showProgress(phase: string, detail: string): void {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.className = 'message progress';
      messages.appendChild(progressEl);
    }
    const phaseLabels: Record<string, string> = {
      memory: 'Memory',
      plan: 'Planning',
      think: 'Thinking',
      tool: 'Tool',
      answer: 'Answering',
    };
    const label = phaseLabels[phase] || phase;
    progressEl.innerHTML = `<span class="progress-spinner"></span> <strong>${label}</strong>: ${escapeHtml(detail)}`;
    messages.scrollTop = messages.scrollHeight;
  }
  function hideProgress(): void {
    if (progressEl) {
      progressEl.remove();
      progressEl = null;
    }
  }

  // ── Load messages into the UI ─────────────────────────────────────
  function loadSessionMessages(sessionId: string): void {
    messages.innerHTML = '';
    zApi.getSession(sessionId).then((s) => {
      if (s) {
        for (const msg of s.messages) {
          addMessage(msg.role, msg.content);
        }
      }
    }).catch(() => {});
  }

  // ── Render session list ───────────────────────────────────────────
  async function renderSessionList(): Promise<void> {
    try {
      const sessions = await zApi.listSessions();
      sessionList.innerHTML = sessions
        .map((s) => {
          const active = s.id === currentSessionId ? ' active' : '';
          const preview = s.messages.length > 0
            ? s.messages[s.messages.length - 1].content.slice(0, 30)
            : '';
          return `<div class="session-item${active}" data-id="${escapeHtml(s.id)}">
            <div class="session-item-content">
              <div class="session-title">${escapeHtml(s.title)}</div>
              <div class="session-preview muted">${escapeHtml(preview)}</div>
            </div>
            <button class="session-delete-btn" title="${t('chat.delete')}" data-id="${escapeHtml(s.id)}">×</button>
          </div>`;
        })
        .join('');

      // Bind delete buttons
      sessionList.querySelectorAll('.session-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).dataset.id;
          if (!id) return;
          try {
            await zApi.deleteSession(id);
            if (currentSessionId === id) {
              currentSessionId = null;
              messages.innerHTML = '';
            }
            await renderSessionList();
          } catch (err) {
            console.error('Delete session error:', err);
          }
        });
      });

      // If no current session, auto-create one
      if (!currentSessionId || !sessions.find((s) => s.id === currentSessionId)) {
        if (sessions.length > 0) {
          currentSessionId = sessions[0].id;
          loadSessionMessages(currentSessionId);
        } else {
          const newS = await zApi.createSession();
          currentSessionId = newS.id;
          messages.innerHTML = '';
        }
        renderSessionList(); // re-render with active state
      }
    } catch {
      sessionList.innerHTML = `<div class="muted" style="padding:8px">Error loading sessions</div>`;
    }
  }

  // ── Send message ──────────────────────────────────────────────────
  async function sendMessage(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;

    // Ensure we have a session
    if (!currentSessionId) {
      try {
        const s = await zApi.createSession();
        currentSessionId = s.id;
        renderSessionList();
      } catch {
        sendBtn.disabled = false;
        return;
      }
    }

    // Save & display user message
    await zApi.appendMessage(currentSessionId, { role: 'user', content: text, timestamp: Date.now() });
    addMessage('user', text);
    renderSessionList();

    // Call LLM
    try {
      showProgress('plan', 'Starting...');
      const unsubProgress = zApi.onProgress((e) => {
        showProgress(e.phase, e.detail);
      });
      const { runId, result } = await zApi.runTask(text, currentSessionId);
      unsubProgress();
      hideProgress();
      const reply = result || `${t('chat.submitted')} ${runId}`;
      // Save & display assistant reply
      await zApi.appendMessage(currentSessionId, { role: 'assistant', content: reply, timestamp: Date.now() });
      addMessage('assistant', reply);
      renderSessionList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorText = `${t('chat.error')}: ${msg}`;
      await zApi.appendMessage(currentSessionId, { role: 'assistant', content: errorText, timestamp: Date.now() });
      addMessage('assistant', errorText);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // ── New session ───────────────────────────────────────────────────
  async function newSession(): Promise<void> {
    try {
      const s = await zApi.createSession();
      currentSessionId = s.id;
      messages.innerHTML = '';
      await renderSessionList();
      input.focus();
    } catch {}
  }

  // ── Event binding ─────────────────────────────────────────────────
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  newBtn.addEventListener('click', newSession);

  // Click session item → switch
  sessionList.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.session-item') as HTMLElement;
    if (item && item.dataset.id && item.dataset.id !== currentSessionId) {
      currentSessionId = item.dataset.id;
      loadSessionMessages(currentSessionId);
      renderSessionList();
    }
  });

  // Initialize
  await renderSessionList();
  input.focus();
}

// Auto-mount
const observer = new MutationObserver(() => {
  const container = document.getElementById('view-chat');
  if (container && !container.querySelector('#chat-layout')) {
    mountChat(container);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export {};
