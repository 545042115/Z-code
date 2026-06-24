// @z-assistant/app-desktop — Chat panel with session management
//
// Features:
//   - Create / switch / delete sessions (with confirmation)
//   - Export session as JSON or Markdown
//   - Progress indicator during LLM calls
//   - Markdown rendering for assistant messages

declare const zApi: import('../preload').ZDesktopAPI;
import { t } from './i18n';

declare global {
  interface Window {
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void;
      render: (id: string, source: string) => Promise<{ svg: string }>;
    };
  }
}

// Mermaid.js is loaded on-demand from CDN only when an assistant message
// contains a ````mermaid` code block. This keeps the renderer bundle small.
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
let mermaidLoaded = false;

async function loadMermaid(): Promise<typeof window.mermaid> {
  if (typeof window.mermaid !== 'undefined') {
    return window.mermaid;
  }
  if (mermaidLoaded) {
    // Already loading; wait up to 10s.
    for (let i = 0; i < 100; i++) {
      if (typeof window.mermaid !== 'undefined') return window.mermaid;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Mermaid library failed to load from CDN');
  }
  mermaidLoaded = true;

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MERMAID_CDN;
    script.async = true;
    script.onload = () => {
      if (typeof window.mermaid !== 'undefined') {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
          mindmap: { padding: 16 },
        });
        resolve(window.mermaid);
      } else {
        reject(new Error('Mermaid global not found after script load'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load Mermaid from CDN'));
    document.head.appendChild(script);
  });
}

// Cache rendered SVG keyed by the mermaid source text to avoid re-rendering.
const mermaidSvgCache = new Map<string, string>();

async function renderMermaidInElement(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>('.mermaid');
  if (blocks.length === 0) return;

  const mermaid = await loadMermaid();
  for (const block of Array.from(blocks)) {
    const source = block.textContent ?? '';
    const cached = mermaidSvgCache.get(source);
    if (cached) {
      block.innerHTML = cached;
      continue;
    }
    try {
      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
      const { svg } = await mermaid!.render(id, source);
      mermaidSvgCache.set(source, svg);
      block.innerHTML = svg;
    } catch (err) {
      console.warn('Mermaid render failed:', err);
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Simple Markdown renderer ──────────────────────────────────────────

function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (must be before inline code)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const trimmed = code.trim();
    if (lang.toLowerCase() === 'mermaid') {
      // Mermaid diagrams are rendered into SVG by mermaid.run() after insertion.
      return `<div class="mermaid" style="background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;margin:6px 0">${trimmed}</div>`;
    }
    return `<pre style="background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;font-size:0.88em;line-height:1.4;margin:6px 0"><code>${trimmed}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg);padding:1px 4px;border-radius:3px;font-size:0.88em">$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4 style="margin:8px 0 4px">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="margin:10px 0 4px">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 style="margin:12px 0 4px">$1</h2>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr style="margin:8px 0;border:none;border-top:1px solid var(--border-light)">');

  // Tables: | col | col |
  html = html.replace(/^\|(.+)\|$/gm, (_m, row) => {
    const cells = row.split('|').map((c: string) => c.trim());
    // Skip separator rows (| --- | --- |)
    if (cells.every((c: string) => /^-+$/.test(c))) return '';
    const cellHtml = cells.map((c: string) => `<td style="padding:2px 8px;border:1px solid var(--border-light);text-align:center">${c}</td>`).join('');
    return `<table style="border-collapse:collapse;margin:6px 0;font-size:0.88em;width:auto"><tr>${cellHtml}</tr></table>`;
  });

  // Lists: - item or * item
  html = html.replace(/^[*-] (.+)$/gm, '<li style="margin:2px 0">$1</li>');
  html = html.replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul style="margin:4px 0;padding-left:20px">$&</ul>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

let currentSessionId: string | null = null;

// ── Planning mode state ───────────────────────────────────────────────
// User-selectable planning mode: 'auto' (default, auto-detect based on
// task complexity), 'simple' (native ReAct), or 'hierarchical' (LLM
// generates milestones + steps). Switchable via slash commands.
type PlanningMode = 'simple' | 'hierarchical' | 'auto';
let currentPlanningMode: PlanningMode = 'auto';

const PLANNING_MODE_COMMANDS: Record<string, PlanningMode> = {
  '/simple': 'simple',
  '/hierarchical': 'hierarchical',
  '/plan': 'hierarchical',
  '/auto': 'auto',
};

const PLANNING_MODE_LABELS: Record<PlanningMode, string> = {
  simple: 'Simple (ReAct)',
  hierarchical: 'Hierarchical (milestones)',
  auto: 'Auto (detect)',
};

const PLANNING_MODE_SHORT_LABELS: Record<PlanningMode, string> = {
  simple: 'Simple',
  hierarchical: 'Plan',
  auto: 'Auto',
};

const PLANNING_MODE_ORDER: PlanningMode[] = ['auto', 'simple', 'hierarchical'];

// ── Confirm dialog helpers ────────────────────────────────────────────

let pendingDeleteId: string | null = null;

function showConfirmDialog(message: string, onConfirm: () => void): void {
  const dialog = document.getElementById('chat-confirm-dialog')!;
  const msgEl = dialog.querySelector('p')!;
  const yesBtn = document.getElementById('chat-confirm-yes')!;
  const noBtn = document.getElementById('chat-confirm-no')!;

  msgEl.textContent = message;
  dialog.style.display = 'flex';

  const cleanup = () => {
    dialog.style.display = 'none';
    yesBtn.removeEventListener('click', handleYes);
    noBtn.removeEventListener('click', handleNo);
  };

  const handleYes = () => {
    cleanup();
    onConfirm();
  };
  const handleNo = () => {
    cleanup();
  };

  yesBtn.addEventListener('click', handleYes);
  noBtn.addEventListener('click', handleNo);
}

// ── Export helpers ────────────────────────────────────────────────────

async function exportSession(sessionId: string, format: 'json' | 'markdown'): Promise<void> {
  try {
    const content = await zApi.exportSession(sessionId, format);
    const session = await zApi.getSession(sessionId);
    const ext = format === 'json' ? 'json' : 'md';
    const filename = `${session?.title ?? 'chat'}_${sessionId.slice(-8)}.${ext}`;

    // Create a download via Blob
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Export error:', msg);
  }
}

// ── Mount ─────────────────────────────────────────────────────────────

export async function mountChat(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div id="chat-layout">
      <div id="chat-sidebar">
        <div id="chat-sidebar-header">
          <h3>${t('chat.sessions')}</h3>
          <div class="row" style="gap:4px">
            <button id="chat-new-btn" class="primary" style="font-size:0.78em;padding:4px 8px">+ ${t('chat.new')}</button>
            <button id="chat-export-btn" class="secondary" style="font-size:0.78em;padding:4px 8px" title="${t('chat.export')}">${t('chat.export')}</button>
          </div>
        </div>
        <div id="chat-session-list"></div>
      </div>
      <div id="chat-main">
        <div id="chat-messages"></div>
        <div id="chat-memory-context" style="display:none;padding:4px 8px;border-top:1px solid var(--border-light);background:var(--bg-soft);font-size:0.78em;max-height:80px;overflow-y:auto"></div>
        <div id="chat-input-area">
          <div id="chat-mode-indicator" style="display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:0.75em;color:var(--text-secondary);border-top:1px solid var(--border-light)">
            <button id="chat-mode-btn" class="secondary" type="button" style="font-size:0.85em;padding:2px 8px;border-radius:var(--radius-sm);display:inline-flex;align-items:center;gap:4px" title="${t('chat.mode_hint')}">
              <span>${t('chat.mode')}</span>
              <strong id="chat-mode-current">Auto</strong>
              <span style="opacity:0.6">▾</span>
            </button>
          </div>
          <textarea id="chat-input" rows="2" placeholder="${t('chat.placeholder')}"></textarea>
          <button id="chat-recall-btn" class="secondary" title="${t('memory.recall_hint')}" style="padding:10px 12px;min-height:42px;font-size:0.85em">${t('memory.recall')}</button>
          <button id="chat-send" class="primary">${t('chat.send')}</button>
        </div>
      </div>
    </div>
    <div id="chat-confirm-dialog" class="modal" style="display:none;">
      <div class="modal-content">
        <p>${t('chat.confirmDelete')}</p>
        <div class="row" style="justify-content:flex-end;margin-top:12px;gap:8px">
          <button id="chat-confirm-no" class="secondary">${t('chat.no')}</button>
          <button id="chat-confirm-yes" class="primary danger">${t('chat.yes')}</button>
        </div>
      </div>
    </div>
    <div id="chat-recall-dialog" class="modal" style="display:none;">
      <div class="modal-content" style="max-width:500px">
        <h4 style="margin:0 0 8px">${t('memory.recall_result')}</h4>
        <input id="chat-recall-query" type="text" placeholder="${t('memory.search_placeholder')}" style="margin-bottom:8px">
        <div id="chat-recall-results" style="max-height:300px;overflow-y:auto"></div>
        <div class="row" style="justify-content:flex-end;margin-top:8px;gap:8px">
          <button id="chat-recall-close" class="secondary">${t('chat.no')}</button>
        </div>
      </div>
    </div>
  `;

  const sessionList = document.getElementById('chat-session-list')!;
  const messages = document.getElementById('chat-messages')!;
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('chat-send') as HTMLButtonElement;
  const newBtn = document.getElementById('chat-new-btn') as HTMLButtonElement;
  const exportBtn = document.getElementById('chat-export-btn') as HTMLButtonElement;
  const modeBtn = document.getElementById('chat-mode-btn') as HTMLButtonElement;

  // ── Helper: add a message bubble ─────────────────────────────────
  async function addMessage(role: string, content: string): Promise<void> {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const label = role === 'user' ? t('chat.you') : t('chat.assistant');
    if (role === 'user') {
      div.innerHTML = `<strong>${label}</strong><br>${escapeHtml(content)}`;
    } else {
      div.innerHTML = `<strong>${label}</strong><br>${renderMarkdown(content)}`;
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;

    // Render any Mermaid diagrams in assistant messages (on-demand load + cache).
    if (role === 'assistant') {
      await renderMermaidInElement(div);
    }
  }

  // ── Helper: create an empty streaming assistant bubble ───────────
  // Returns an object with an `append(delta)` method that incrementally
  // appends plain text (no markdown re-render per chunk — too expensive
  // on high-frequency streams) and a `finalize(content)` method that
  // runs the full markdown + Mermaid render on the complete text.
  function startStreamingMessage(): { bubble: HTMLElement; append: (d: string) => void; finalize: (content: string) => Promise<void> } {
    const div = document.createElement('div');
    div.className = 'message assistant streaming';
    const label = t('chat.assistant');
    // During streaming, render the body as plain text inside a <span>
    // so appends are O(1) (no re-parsing the whole message).
    const bodySpan = document.createElement('span');
    bodySpan.className = 'stream-body';
    div.innerHTML = `<strong>${label}</strong><br>`;
    div.appendChild(bodySpan);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;

    return {
      bubble: div,
      append(delta: string) {
        bodySpan.textContent = (bodySpan.textContent ?? '') + delta;
        // Auto-scroll to keep the latest chunk in view.
        messages.scrollTop = messages.scrollHeight;
      },
      async finalize(content: string) {
        // Replace the streaming span with a freshly-rendered markdown
        // version (so headers, code blocks, links, tables, etc. show up).
        div.classList.remove('streaming');
        bodySpan.outerHTML = renderMarkdown(content);
        await renderMermaidInElement(div);
      },
    };
  }

  // ── Helper: add a system (non-agent) message bubble ──────────────
  function addSystemMessage(content: string): void {
    const div = document.createElement('div');
    div.className = 'message system';
    div.style.cssText = 'text-align:center;font-size:0.82em;color:var(--text-secondary);background:var(--bg-soft);border-radius:var(--radius-md);padding:6px 10px;margin:4px 0';
    div.textContent = content;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Helper: update the planning mode indicator ───────────────────
  function updateModeIndicator(): void {
    const el = document.getElementById('chat-mode-current');
    if (el) el.textContent = PLANNING_MODE_SHORT_LABELS[currentPlanningMode];
  }

  // ── Helper: cycle to the next planning mode ──────────────────────
  function cyclePlanningMode(): void {
    const idx = PLANNING_MODE_ORDER.indexOf(currentPlanningMode);
    currentPlanningMode = PLANNING_MODE_ORDER[(idx + 1) % PLANNING_MODE_ORDER.length];
    updateModeIndicator();
    addSystemMessage(`${t('chat.mode_switched')} ${PLANNING_MODE_LABELS[currentPlanningMode]}`);
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
  async function loadSessionMessages(sessionId: string): Promise<void> {
    messages.innerHTML = '';
    try {
      const s = await zApi.getSession(sessionId);
      if (s) {
        for (const msg of s.messages) {
          await addMessage(msg.role, msg.content);
        }
      }
    } catch {
      // ignore
    }
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
            <div class="session-item-actions">
              <button class="session-export-btn" title="${t('chat.export')}" data-id="${escapeHtml(s.id)}">↓</button>
              <button class="session-delete-btn" title="${t('chat.delete')}" data-id="${escapeHtml(s.id)}">×</button>
            </div>
          </div>`;
        })
        .join('');

      // Bind delete buttons with confirmation
      sessionList.querySelectorAll('.session-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).dataset.id;
          if (!id) return;
          showConfirmDialog(t('chat.confirmDelete'), async () => {
            try {
              await zApi.deleteSession(id!);
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
      });

      // Bind export buttons on session items
      sessionList.querySelectorAll('.session-export-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).dataset.id;
          if (!id) return;
          // Export as markdown by default from session list
          await exportSession(id, 'markdown');
        });
      });

      // If no current session, auto-create one
      if (!currentSessionId || !sessions.find((s) => s.id === currentSessionId)) {
        if (sessions.length > 0) {
          currentSessionId = sessions[0].id;
          await loadSessionMessages(currentSessionId);
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

  // ── Memory context hint ─────────────────────────────────────────
  const memoryContextEl = document.getElementById('chat-memory-context')!;
  let memoryContextTimeout: ReturnType<typeof setTimeout> | null = null;

  async function updateMemoryContext(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length < 4) {
      memoryContextEl.style.display = 'none';
      return;
    }
    try {
      const hits = await zApi.recallMemory(trimmed, 3);
      if (hits.length === 0) {
        memoryContextEl.style.display = 'none';
        return;
      }
      memoryContextEl.innerHTML = hits
        .map((h) => {
          const content = h.memory.content.length > 80
            ? h.memory.content.slice(0, 80) + '…'
            : h.memory.content;
          return `<span style="display:inline-block;padding:1px 6px;margin:1px 2px;border-radius:3px;background:var(--accent-soft);color:var(--accent);cursor:pointer" title="${t('memory.recall_hint')}">${escapeHtml(content)}</span>`;
        })
        .join('');
      memoryContextEl.style.display = 'block';
    } catch {
      memoryContextEl.style.display = 'none';
    }
  }

  // Debounced input listener for memory context
  input.addEventListener('input', () => {
    if (memoryContextTimeout) clearTimeout(memoryContextTimeout);
    memoryContextTimeout = setTimeout(() => updateMemoryContext(input.value), 500);
  });

  // ── Send message ──────────────────────────────────────────────────
  async function sendMessage(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;

    // ── Parse planning mode slash commands ───────────────────────
    // /simple /hierarchical /plan /auto → switch mode (bare) or send
    //   the remaining text with the new mode (command + text).
    // /mode → show the current planning mode.
    const firstToken = text.split(/\s+/)[0].toLowerCase();
    if (PLANNING_MODE_COMMANDS[firstToken]) {
      currentPlanningMode = PLANNING_MODE_COMMANDS[firstToken];
      updateModeIndicator();
      const restText = text.slice(firstToken.length).trim();
      if (!restText) {
        addSystemMessage(`${t('chat.mode_switched')} ${PLANNING_MODE_LABELS[currentPlanningMode]}`);
        sendBtn.disabled = false;
        input.focus();
        return;
      }
      // Command + text: send the rest with the new mode
      await runAgentTask(restText);
      return;
    }
    if (firstToken === '/mode') {
      addSystemMessage(`${t('chat.mode_current')} ${PLANNING_MODE_LABELS[currentPlanningMode]}`);
      sendBtn.disabled = false;
      input.focus();
      return;
    }

    await runAgentTask(text);
  }

  // ── Run agent task with the current planning mode ────────────────
  async function runAgentTask(task: string): Promise<void> {
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
    await zApi.appendMessage(currentSessionId, { role: 'user', content: task, timestamp: Date.now() });
    await addMessage('user', task);
    renderSessionList();

    // Call LLM
    try {
      showProgress('plan', 'Starting...');
      const unsubProgress = zApi.onProgress((e) => {
        showProgress(e.phase, e.detail);
      });

      // Create the streaming assistant bubble up front so chunks
      // arriving before `runTask` resolves can be appended in place.
      // When the run completes, `finalize` re-renders the accumulated
      // text as full markdown (replacing the plain-text span).
      const stream = startStreamingMessage();
      let accumulated = '';
      const unsubStream = zApi.onStreamChunk((e) => {
        if (e.delta) {
          accumulated += e.delta;
          stream.append(e.delta);
        }
      });

      try {
        const { runId, result } = await zApi.runTask(task, currentSessionId, currentPlanningMode);
        const reply = result || accumulated || `${t('chat.submitted')} ${runId}`;
        // Prefer the streamed text when available (matches what the user
        // saw), fall back to the IPC-returned `result` otherwise.
        const finalText = accumulated || reply;
        await zApi.appendMessage(currentSessionId, { role: 'assistant', content: finalText, timestamp: Date.now() });
        await stream.finalize(finalText);
        renderSessionList();
      } finally {
        unsubStream();
        unsubProgress();
        hideProgress();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorText = `${t('chat.error')}: ${msg}`;
      await zApi.appendMessage(currentSessionId, { role: 'assistant', content: errorText, timestamp: Date.now() });
      await addMessage('assistant', errorText);
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

  // ── Export current session ────────────────────────────────────────
  async function exportCurrentSession(): Promise<void> {
    if (!currentSessionId) return;
    // Show a simple format picker
    const format = confirm('Export as Markdown? Click OK for Markdown, Cancel for JSON.')
      ? 'markdown'
      : 'json';
    await exportSession(currentSessionId, format);
  }

  // ── Memory recall dialog ─────────────────────────────────────────
  const recallBtn = document.getElementById('chat-recall-btn') as HTMLButtonElement;
  const recallDialog = document.getElementById('chat-recall-dialog')!;
  const recallQuery = document.getElementById('chat-recall-query') as HTMLInputElement;
  const recallResults = document.getElementById('chat-recall-results')!;
  const recallClose = document.getElementById('chat-recall-close') as HTMLButtonElement;

  function openRecallDialog(): void {
    recallQuery.value = '';
    recallResults.innerHTML = `<p class="muted">${t('memory.recall_empty')}</p>`;
    recallDialog.style.display = 'flex';
    setTimeout(() => recallQuery.focus(), 100);
  }

  async function performRecall(): Promise<void> {
    const query = recallQuery.value.trim();
    if (!query) {
      recallResults.innerHTML = `<p class="muted">${t('memory.recall_empty')}</p>`;
      return;
    }
    recallResults.innerHTML = `<p class="muted">${t('memory.loading')}</p>`;
    try {
      const hits = await zApi.recallMemory(query, 5);
      if (hits.length === 0) {
        recallResults.innerHTML = `<p class="muted">${t('memory.recall_empty')}</p>`;
        return;
      }
      recallResults.innerHTML = hits
        .map((h, i) => {
          const content = h.memory.content.length > 150
            ? h.memory.content.slice(0, 150) + '…'
            : h.memory.content;
          const score = (h.score * 100).toFixed(0);
          return `<div class="recall-hit" data-index="${i}" style="cursor:pointer;padding:8px 10px;margin:4px 0;background:var(--bg);border-radius:var(--radius-md);border:1px solid var(--border-light);transition:all var(--transition)">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="memory-kind" style="font-size:0.75em;padding:1px 6px;border-radius:3px;background:var(--accent-soft);color:var(--accent)">${escapeHtml(h.memory.kind)}</span>
              <span class="muted" style="font-size:0.78em">${score}%</span>
            </div>
            <p style="margin:4px 0 0;font-size:0.88em;color:var(--text-secondary);white-space:pre-wrap">${escapeHtml(content)}</p>
          </div>`;
        })
        .join('');

      // Click to insert into input
      recallResults.querySelectorAll('.recall-hit').forEach((el) => {
        el.addEventListener('click', () => {
          const idx = parseInt((el as HTMLElement).dataset.index!, 10);
          const hit = hits[idx];
          if (hit) {
            input.value = hit.memory.content;
            input.focus();
            recallDialog.style.display = 'none';
          }
        });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      recallResults.innerHTML = `<p class="status error">${escapeHtml(msg)}</p>`;
    }
  }

  recallBtn.addEventListener('click', openRecallDialog);
  recallClose.addEventListener('click', () => { recallDialog.style.display = 'none'; });
  recallQuery.addEventListener('input', performRecall);
  recallQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      performRecall();
    }
  });

  // ── Event binding ─────────────────────────────────────────────────
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  newBtn.addEventListener('click', newSession);
  exportBtn.addEventListener('click', exportCurrentSession);
  modeBtn.addEventListener('click', cyclePlanningMode);

  // Click session item → switch
  sessionList.addEventListener('click', async (e) => {
    const item = (e.target as HTMLElement).closest('.session-item') as HTMLElement;
    if (item && item.dataset.id && item.dataset.id !== currentSessionId) {
      currentSessionId = item.dataset.id;
      await loadSessionMessages(currentSessionId);
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
