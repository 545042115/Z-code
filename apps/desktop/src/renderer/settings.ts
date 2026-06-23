// @z-assistant/app-desktop — Settings panel (i18n + model support)

declare const zApi: import('../preload').ZDesktopAPI;
import { t, setLanguage, getLanguage, loadLanguage, type Language } from './i18n';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function applyTranslations(): void {
  // Nav buttons
  (document.querySelector('#nav button[data-view="main"]') as HTMLElement)!.textContent = t('nav.main');
  (document.querySelector('#nav button[data-view="chat"]') as HTMLElement)!.textContent = t('nav.chat');
  (document.querySelector('#nav button[data-view="trace"]') as HTMLElement)!.textContent = t('nav.trace');
  (document.querySelector('#nav button[data-view="settings"]') as HTMLElement)!.textContent = t('nav.settings');
  // Main view
  const mainView = document.getElementById('view-main');
  if (mainView) {
    mainView.innerHTML = `<div class="card"><h1>${t('main.title')}</h1><p class="muted">${t('main.description')}</p></div>`;
  }
}

function renderSettings(container: HTMLElement): void {
  container.innerHTML = `
    <div class="stack">
      <div class="card">
        <h3>${t('settings.language')}</h3>
        <label class="stack">
          <select id="settings-lang">
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <div class="card">
        <h3>${t('settings.model')}</h3>
        <label class="stack">
          <span>${t('settings.provider')}</span>
          <select id="settings-provider">
            <option value="sglang">${t('provider.sglang')}</option>
            <option value="openai">${t('provider.openai')}</option>
            <option value="anthropic">${t('provider.anthropic')}</option>
            <option value="deepseek">${t('provider.deepseek')}</option>
            <option value="gemini">${t('provider.gemini')}</option>
            <option value="ollama">${t('provider.ollama')}</option>
            <option value="custom">${t('provider.custom')}</option>
          </select>
        </label>
        <label class="stack" style="margin-top:8px">
          <span>${t('settings.model_name')}</span>
          <input id="settings-model" type="text" placeholder="${t('settings.model_placeholder')}">
        </label>
        <label class="stack" style="margin-top:8px">
          <span>${t('settings.api_key')}</span>
          <input id="settings-apikey" type="password" placeholder="sk-...">
        </label>
        <label class="stack" style="margin-top:8px">
          <span>${t('settings.api_endpoint')}</span>
          <input id="settings-endpoint" type="text" placeholder="https://api.openai.com/v1">
        </label>
      </div>
      <div class="card">
        <h3>${t('settings.memory')}</h3>
        <label class="row">
          <input id="settings-memory" type="checkbox">
          <span>${t('settings.memory_label')}</span>
        </label>
        <div class="row" style="margin-top:8px;gap:8px">
          <button id="settings-goto-memory" class="secondary" style="font-size:0.82em">${t('memory.go_to')}</button>
          <button id="settings-export-memory" class="secondary" style="font-size:0.82em">${t('memory.export')}</button>
          <button id="settings-purge-memory" class="secondary danger" style="font-size:0.82em">${t('memory.purge')}</button>
        </div>
        <p class="muted" style="font-size:0.82em;margin-top:4px">${t('memory.manage_desc')}</p>
      </div>
      <div class="card">
        <h3>${t('settings.storage')}</h3>
        <label class="stack">
          <span>${t('settings.data_dir')}</span>
          <div class="row">
            <input id="settings-storage" type="text" placeholder="C:\Users\...\.z-assistant\desktop" style="flex:1">
            <button id="settings-browse" class="primary" style="white-space:nowrap">浏览</button>
          </div>
        </label>
        <p class="muted" style="font-size:0.85em;margin-top:4px">此路径在重启后生效</p>
      </div>
      <div class="card">
        <h3>${t('settings.project')}</h3>
        <label class="stack">
          <span>${t('settings.project_dir')}</span>
          <div class="row">
            <input id="settings-projectdir" type="text" placeholder="F:\Z-code" style="flex:1">
            <button id="settings-browse-project" class="primary" style="white-space:nowrap">浏览</button>
          </div>
        </label>
        <p class="muted" style="font-size:0.85em;margin-top:4px">文件操作和 Shell 命令的工作目录</p>
      </div>
      <div class="card">
        <h3>安全 / Safety</h3>
        <label class="row">
          <input id="settings-dryrun" type="checkbox">
          <span>Dry-run 模式（模拟执行，不产生副作用）</span>
        </label>
        <p class="muted" style="font-size:0.82em;margin-top:4px">启用后，Agent 的所有工具调用将被模拟执行，仅返回"将要做什么"的描述，方便预览完整计划后再正式执行。</p>
      </div>
      <div class="card">
        <h3>${t('settings.tool_policy_title')}</h3>
        <p class="muted" style="font-size:0.82em;margin-bottom:8px">${t('settings.tool_policy_desc')}</p>
        <label class="stack" style="margin-top:8px">
          <span>${t('settings.tool_policy_allow')}</span>
          <textarea id="settings-tool-allow" rows="2" placeholder="read_file, web_search, mcp_*"></textarea>
        </label>
        <label class="stack" style="margin-top:8px">
          <span>${t('settings.tool_policy_deny')}</span>
          <textarea id="settings-tool-deny" rows="2" placeholder="run_terminal, write_file"></textarea>
        </label>
        <p class="muted" style="font-size:0.78em;margin-top:4px">${t('settings.tool_policy_hint')}</p>
      </div>
      <div class="card">
        <h3>${t('settings.budget_title')}</h3>
        <p class="muted" style="font-size:0.82em;margin-bottom:8px">${t('settings.budget_desc')}</p>
        <label class="row" style="margin-top:8px;gap:12px">
          <span style="min-width:120px">${t('settings.budget_tokens')}</span>
          <input id="settings-budget-tokens" type="number" style="flex:1" min="0" step="1000">
        </label>
        <label class="row" style="margin-top:8px;gap:12px">
          <span style="min-width:120px">${t('settings.budget_usd')}</span>
          <input id="settings-budget-usd" type="number" style="flex:1" min="0" step="0.1">
        </label>
        <label class="row" style="margin-top:8px;gap:12px">
          <span style="min-width:120px">${t('settings.budget_day_usd')}</span>
          <input id="settings-budget-day-usd" type="number" style="flex:1" min="0" step="0.1">
        </label>
      </div>
      <div class="card">
        <h3>${t('settings.wechat_title')}</h3>
        <p class="muted" style="font-size:0.85em;margin-bottom:8px;color:#eab308">${t('settings.wechat_hook_warning')}</p>
        <label class="row" style="margin-top:8px">
          <span style="min-width:80px">微信昵称</span>
          <input id="settings-wch-nickname" type="text" placeholder="你的微信昵称，群聊@你时才会回复" style="flex:1">
        </label>
        <div class="row" style="margin-top:8px">
          <button id="settings-wch-connect" class="primary" style="white-space:nowrap">${t('settings.wechat_hook_connect')}</button>
          <button id="settings-wch-disconnect" class="secondary" style="white-space:nowrap">${t('settings.wechat_hook_disconnect')}</button>
          <span id="settings-wch-status" class="muted" style="margin-left:8px">${t('settings.wechat_hook_disconnected')}</span>
        </div>
        <p id="settings-wch-debug" class="muted" style="font-size:0.8em;margin-top:4px"></p>
      </div>
      <div class="card">
        <h3>${t('settings.qq_title')}</h3>
        <p class="muted" style="font-size:0.85em;margin-bottom:8px">${t('settings.qq_desc')}</p>
        <label class="row" style="margin-top:8px">
          <span style="min-width:80px">WebSocket 地址</span>
          <input id="settings-qq-wsurl" type="text" placeholder="ws://localhost:3001" style="flex:1">
        </label>
        <label class="row" style="margin-top:4px">
          <span style="min-width:80px">Access Token</span>
          <input id="settings-qq-token" type="password" placeholder="NapCat 配置中的 accessToken（可选）" style="flex:1">
        </label>
        <label class="row" style="margin-top:4px">
          <span style="min-width:80px">QQ 昵称</span>
          <input id="settings-qq-nickname" type="text" placeholder="你的 QQ 昵称，群聊@你时才会回复" style="flex:1">
        </label>
        <div class="row" style="margin-top:8px">
          <button id="settings-qq-connect" class="primary" style="white-space:nowrap">${t('settings.qq_connect')}</button>
          <button id="settings-qq-disconnect" class="secondary" style="white-space:nowrap">${t('settings.qq_disconnect')}</button>
          <span id="settings-qq-status" class="muted" style="margin-left:8px">${t('settings.qq_disconnected')}</span>
        </div>
        <p id="settings-qq-debug" class="muted" style="font-size:0.8em;margin-top:4px"></p>
      </div>
      <div class="card">
        <h3>${t('settings.profile_title')}</h3>
        <label class="row" style="margin-bottom:8px">
          <input id="settings-profile-enabled" type="checkbox">
          <span>${t('settings.profile_enable')}</span>
        </label>
        <div style="margin-top:8px;font-size:0.9em">
          <span>${t('settings.profile_msg_count')}: </span><strong id="settings-profile-count">0</strong>
        </div>
        <div style="margin-top:4px;font-size:0.9em">
          <span>${t('settings.profile_desc')}: </span>
          <p id="settings-profile-desc" class="muted" style="margin-top:2px;white-space:pre-wrap">${t('settings.profile_none')}</p>
        </div>
        <div class="row" style="margin-top:8px">
          <button id="settings-profile-rebuild" class="secondary" style="white-space:nowrap">${t('settings.profile_rebuild')}</button>
          <button id="settings-profile-clear" class="secondary danger" style="white-space:nowrap">${t('settings.profile_clear')}</button>
        </div>
      </div>
      <div class="card">
        <h3>${t('settings.mcp_title')}</h3>
        <p class="muted" style="font-size:0.85em;margin-bottom:8px">${t('settings.mcp_desc')}</p>
        <label class="stack" style="margin-top:8px">
          <span>${t('settings.mcd_token')}</span>
          <div class="row" style="gap:4px">
            <input id="settings-mcd-token" class="secured" type="text" placeholder="${t('settings.mcd_token_placeholder')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="flex:1">
            <button id="settings-mcd-token-toggle" class="secondary" type="button" style="white-space:nowrap;font-size:0.8em;padding:4px 8px">显示</button>
          </div>
        </label>
        <p class="muted" style="font-size:0.82em;margin-top:4px">${t('settings.mcd_token_hint')}</p>
        <label class="stack" style="margin-top:12px">
          <span>${t('settings.amap_key')}</span>
          <div class="row" style="gap:4px">
            <input id="settings-amap-key" class="secured" type="text" placeholder="${t('settings.amap_key_placeholder')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="flex:1">
            <button id="settings-amap-key-toggle" class="secondary" type="button" style="white-space:nowrap;font-size:0.8em;padding:4px 8px">显示</button>
          </div>
        </label>
        <p class="muted" style="font-size:0.82em;margin-top:4px">${t('settings.amap_key_hint')}</p>
      </div>
      <div class="card">
        <h3>${t('settings.always_rules_title')}</h3>
        <p class="muted" style="font-size:0.85em;margin-bottom:8px">${t('settings.always_rules_desc')}</p>
        <div id="settings-always-rules-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
      <div class="card">
        <h3>${t('settings.skill_review_title')}</h3>
        <p class="muted" style="font-size:0.85em;margin-bottom:8px">${t('settings.skill_review_desc')}</p>
        <div class="row" style="margin-bottom:12px;gap:8px">
          <button id="settings-discover-skills" class="secondary" style="white-space:nowrap">${t('settings.discover_skills')}</button>
          <button id="settings-refresh-skills" class="secondary" style="white-space:nowrap">${t('settings.refresh_skills')}</button>
          <span id="settings-skill-status" class="muted"></span>
        </div>
        <div id="settings-skill-queue" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
      <button id="settings-save" class="primary">${t('settings.save')}</button>
      <span id="settings-status" class="muted"></span>
    </div>
  `;

  const langSelect = document.getElementById('settings-lang') as HTMLSelectElement;
  const provider = document.getElementById('settings-provider') as HTMLSelectElement;
  const model = document.getElementById('settings-model') as HTMLInputElement;
  const apiKey = document.getElementById('settings-apikey') as HTMLInputElement;
  const endpoint = document.getElementById('settings-endpoint') as HTMLInputElement;
  const memory = document.getElementById('settings-memory') as HTMLInputElement;
  const storage = document.getElementById('settings-storage') as HTMLInputElement;
  const dryRun = document.getElementById('settings-dryrun') as HTMLInputElement;
  const toolAllow = document.getElementById('settings-tool-allow') as HTMLTextAreaElement;
  const toolDeny = document.getElementById('settings-tool-deny') as HTMLTextAreaElement;
  const budgetTokens = document.getElementById('settings-budget-tokens') as HTMLInputElement;
  const budgetUsd = document.getElementById('settings-budget-usd') as HTMLInputElement;
  const budgetDayUsd = document.getElementById('settings-budget-day-usd') as HTMLInputElement;
  const browseBtn = document.getElementById('settings-browse') as HTMLButtonElement;
  const projectDir = document.getElementById('settings-projectdir') as HTMLInputElement;
  const browseProjectBtn = document.getElementById('settings-browse-project') as HTMLButtonElement;
  const saveBtn = document.getElementById('settings-save') as HTMLButtonElement;
  const status = document.getElementById('settings-status')!;
  const mcdToken = document.getElementById('settings-mcd-token') as HTMLInputElement;
  const mcdTokenToggle = document.getElementById('settings-mcd-token-toggle') as HTMLButtonElement;
  const amapKey = document.getElementById('settings-amap-key') as HTMLInputElement;
  const amapKeyToggle = document.getElementById('settings-amap-key-toggle') as HTMLButtonElement;

  // Profile elements
  const profileEnabled = document.getElementById('settings-profile-enabled') as HTMLInputElement;
  const profileCount = document.getElementById('settings-profile-count') as HTMLElement;
  const profileDesc = document.getElementById('settings-profile-desc') as HTMLElement;
  const profileRebuildBtn = document.getElementById('settings-profile-rebuild') as HTMLButtonElement;
  const profileClearBtn = document.getElementById('settings-profile-clear') as HTMLButtonElement;

  async function load(): Promise<void> {
    const s = await zApi.getSettings() as any;
    langSelect.value = s.language || 'zh-CN';
    provider.value = s.defaultModel.provider;
    model.value = s.defaultModel.name;
    apiKey.value = s.apiKey || '';
    endpoint.value = s.apiEndpoint || '';
    memory.checked = s.memoryEnabled;
    storage.value = s.storageDir;
    projectDir.value = s.projectDir || '';
    dryRun.checked = !!s.dryRun;
    toolAllow.value = (s.toolPolicy?.allow ?? []).join(', ');
    toolDeny.value = (s.toolPolicy?.deny ?? []).join(', ');
    budgetTokens.value = String(s.budget?.perRunTokens ?? 1_000_000);
    budgetUsd.value = String(s.budget?.perRunUsd ?? 5);
    budgetDayUsd.value = String(s.budget?.perDayUsd ?? 50);
    mcdToken.value = s.mcdMcpToken || '';
    amapKey.value = s.amapApiKey || '';
    // Load profile data
    await updateProfileDisplay();
  }

  // Language switch applies immediately
  langSelect.addEventListener('change', () => {
    const lang = langSelect.value as Language;
    setLanguage(lang);
    // Re-render settings with new language
    renderSettings(container);
    // Re-bind load on new elements
    const newLangSelect = document.getElementById('settings-lang') as HTMLSelectElement;
    if (newLangSelect) newLangSelect.value = lang;
    load();
    applyTranslations();
  });

  // Browse button — open native folder picker via IPC
  browseBtn.addEventListener('click', async () => {
    try {
      browseBtn.disabled = true;
      const dir = await zApi.selectDirectory();
      if (dir) storage.value = dir;
    } catch (err: unknown) {
      status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      browseBtn.disabled = false;
    }
  });

  // ── WeChat Hook event handlers ──────────────────────────────
  const wchConnectBtn = document.getElementById('settings-wch-connect') as HTMLButtonElement;
  const wchDisconnectBtn = document.getElementById('settings-wch-disconnect') as HTMLButtonElement;
  const wchStatusEl = document.getElementById('settings-wch-status') as HTMLSpanElement;
  const wchNickname = document.getElementById('settings-wch-nickname') as HTMLInputElement;
  const wchDebug = document.getElementById('settings-wch-debug') as HTMLParagraphElement;

  // Load saved nickname
  const savedHookNickname = localStorage.getItem('wechat-hook-nickname') || '';
  if (savedHookNickname) wchNickname.value = savedHookNickname;

  wchConnectBtn.addEventListener('click', async () => {
    try {
      wchConnectBtn.disabled = true;
      wchStatusEl.textContent = t('settings.wechat_hook_connecting');
      wchStatusEl.style.color = '';
      const nick = wchNickname.value.trim();
      localStorage.setItem('wechat-hook-nickname', nick);
      const status = await zApi.startWeChatHook({ nickname: nick || undefined }) as any;
      if (status.online) {
        wchStatusEl.textContent = `已连接 (${status.nickname})`;
        wchStatusEl.style.color = 'var(--success)';
      } else {
        wchStatusEl.textContent = '连接失败';
      }
      if (status.lastPollInfo) wchDebug.textContent = status.lastPollInfo;
    } catch (err: unknown) {
      wchStatusEl.textContent = `连接失败: ${err instanceof Error ? err.message : String(err)}`;
      wchStatusEl.style.color = '';
    } finally {
      wchConnectBtn.disabled = false;
    }
  });

  // Listen for WeChat Hook status updates
  const unsubWCH = zApi.onWeChatHookStatus((s: any) => {
    if (s.online) {
      wchStatusEl.textContent = `已连接 (${s.nickname})`;
      wchStatusEl.style.color = 'var(--success)';
    } else {
      wchStatusEl.textContent = t('settings.wechat_hook_disconnected');
      wchStatusEl.style.color = '';
    }
    if (s.lastPollInfo) wchDebug.textContent = `消息数: ${s.messageCount} | ${s.lastPollInfo}`;
  });

  wchDisconnectBtn.addEventListener('click', async () => {
    try {
      wchDisconnectBtn.disabled = true;
      await zApi.stopWeChatHook();
      wchStatusEl.textContent = t('settings.wechat_hook_disconnected');
      wchStatusEl.style.color = '';
      wchDebug.textContent = '';
    } catch (err: unknown) {
      console.error(err);
    } finally {
      wchDisconnectBtn.disabled = false;
    }
  });

  // ── QQ OneBot event handlers (NapCat + OneBot protocol) ────
  const qqConnectBtn = document.getElementById('settings-qq-connect') as HTMLButtonElement;
  const qqDisconnectBtn = document.getElementById('settings-qq-disconnect') as HTMLButtonElement;
  const qqStatusEl = document.getElementById('settings-qq-status') as HTMLSpanElement;
  const qqWsUrl = document.getElementById('settings-qq-wsurl') as HTMLInputElement;
  const qqToken = document.getElementById('settings-qq-token') as HTMLInputElement;
  const qqNickname = document.getElementById('settings-qq-nickname') as HTMLInputElement;
  const qqDebug = document.getElementById('settings-qq-debug') as HTMLParagraphElement;

  // Load saved wsUrl, token and nickname
  const savedWsUrl = localStorage.getItem('qq-wsurl') || '';
  if (savedWsUrl) qqWsUrl.value = savedWsUrl;
  const savedQqToken = localStorage.getItem('qq-token') || '';
  if (savedQqToken) qqToken.value = savedQqToken;
  const savedQqNickname = localStorage.getItem('qq-nickname') || '';
  if (savedQqNickname) qqNickname.value = savedQqNickname;

  qqConnectBtn.addEventListener('click', async () => {
    try {
      qqConnectBtn.disabled = true;
      qqStatusEl.textContent = '连接中...';
      qqStatusEl.style.color = '';
      const wsUrl = qqWsUrl.value.trim() || 'ws://localhost:3001';
      const token = qqToken.value.trim();
      const nick = qqNickname.value.trim();
      localStorage.setItem('qq-wsurl', wsUrl);
      localStorage.setItem('qq-token', token);
      localStorage.setItem('qq-nickname', nick);
      await zApi.startQQ({ wsUrl, accessToken: token || undefined, nickname: nick || undefined });
      qqStatusEl.textContent = '已连接';
      qqStatusEl.style.color = 'var(--success)';
    } catch (err: unknown) {
      qqStatusEl.textContent = `连接失败: ${err instanceof Error ? err.message : String(err)}`;
      qqStatusEl.style.color = '';
    } finally {
      qqConnectBtn.disabled = false;
    }
  });

  // Listen for QQ status updates
  const unsubQQ = zApi.onQQStatus((s: any) => {
    if (s.online) {
      qqStatusEl.textContent = `已连接 (${s.nickname || s.userId})`;
      qqStatusEl.style.color = 'var(--success)';
    } else {
      qqStatusEl.textContent = s.nickname || '未连接';
      qqStatusEl.style.color = '';
    }
    if (s.lastEvent) qqDebug.textContent = `消息数: ${s.messageCount} | ${s.lastEvent}`;
  });

  qqDisconnectBtn.addEventListener('click', async () => {
    try {
      qqDisconnectBtn.disabled = true;
      await zApi.stopQQ();
      qqStatusEl.textContent = '已断开';
      qqStatusEl.style.color = '';
    } catch (err: unknown) {
      console.error(err);
    } finally {
      qqDisconnectBtn.disabled = false;
    }
  });

  // ── Profile handlers ─────────────────────────────────────────

  async function updateProfileDisplay(): Promise<void> {
    try {
      const p = await zApi.getProfile() as any;
      profileEnabled.checked = p.enabled !== false;
      profileCount.textContent = String(p.count ?? 0);
      profileDesc.textContent = p.description || t('settings.profile_none');
    } catch {
      profileCount.textContent = '0';
      profileDesc.textContent = t('settings.profile_none');
    }
  }

  profileEnabled.addEventListener('change', async () => {
    await zApi.setProfileEnabled(profileEnabled.checked);
  });

  profileRebuildBtn.addEventListener('click', async () => {
    profileRebuildBtn.disabled = true;
    try {
      await zApi.rebuildProfile();
      await updateProfileDisplay();
    } catch (err: unknown) {
      console.error(err);
    } finally {
      profileRebuildBtn.disabled = false;
    }
  });

  profileClearBtn.addEventListener('click', async () => {
    if (!confirm(t('settings.profile_clear_confirm'))) return;
    profileClearBtn.disabled = true;
    try {
      await zApi.clearProfile();
      await updateProfileDisplay();
    } catch (err: unknown) {
      console.error(err);
    } finally {
      profileClearBtn.disabled = false;
    }
  });

  // ── Memory management buttons ───────────────────────────────
  const gotoMemoryBtn = document.getElementById('settings-goto-memory') as HTMLButtonElement;
  const exportMemoryBtn = document.getElementById('settings-export-memory') as HTMLButtonElement;
  const purgeMemoryBtn = document.getElementById('settings-purge-memory') as HTMLButtonElement;

  gotoMemoryBtn.addEventListener('click', () => {
    // Switch to memory view
    const memBtn = document.querySelector('#nav button[data-view="memory"]') as HTMLElement;
    if (memBtn) memBtn.click();
  });

  exportMemoryBtn.addEventListener('click', async () => {
    try {
      const data = await zApi.exportMemories();
      const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memories_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      status.textContent = `Export error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  purgeMemoryBtn.addEventListener('click', async () => {
    if (!confirm(t('memory.purge_confirm'))) return;
    try {
      const count = await zApi.purgeMemories();
      status.textContent = `Purged ${count} memories`;
    } catch (err: unknown) {
      status.textContent = `Purge error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  // ── Skill Review Queue handlers ─────────────────────────────
  const discoverSkillsBtn = document.getElementById('settings-discover-skills') as HTMLButtonElement;
  const refreshSkillsBtn = document.getElementById('settings-refresh-skills') as HTMLButtonElement;
  const skillStatus = document.getElementById('settings-skill-status') as HTMLSpanElement;
  const skillQueue = document.getElementById('settings-skill-queue') as HTMLDivElement;
  const alwaysRulesList = document.getElementById('settings-always-rules-list') as HTMLDivElement;

  async function renderSkillQueue(): Promise<void> {
    try {
      skillStatus.textContent = t('settings.loading_skills');
      const candidates = await zApi.listSkillCandidates();
      skillQueue.innerHTML = '';
      if (candidates.length === 0) {
        skillQueue.innerHTML = `<p class="muted">${t('settings.no_skill_candidates')}</p>`;
        skillStatus.textContent = '';
        return;
      }
      for (const c of candidates) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.padding = '12px';
        card.innerHTML = `
          <div class="row" style="justify-content:space-between;align-items:flex-start">
            <div>
              <strong>${c.draft.name}</strong>
              <p class="muted" style="margin:2px 0 0;font-size:0.85em">${c.draft.description}</p>
              <p class="muted" style="margin:2px 0 0;font-size:0.78em">tags: ${c.draft.tags.join(', ')} | priority: ${c.draft.priority} | confidence: ${Math.round(c.confidence * 100)}%</p>
            </div>
            <div class="row" style="gap:6px">
              <button class="secondary approve-skill" data-id="${c.id}" style="font-size:0.8em;padding:4px 8px">${t('settings.approve_skill')}</button>
              <button class="secondary danger reject-skill" data-id="${c.id}" style="font-size:0.8em;padding:4px 8px">${t('settings.reject_skill')}</button>
            </div>
          </div>
          <details style="margin-top:8px;font-size:0.85em">
            <summary>${t('settings.view_skill_body')}</summary>
            <pre style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:4px;margin-top:6px">${c.draft.body.replace(/</g, '&lt;')}</pre>
          </details>
        `;
        skillQueue.appendChild(card);
      }
      skillStatus.textContent = `${candidates.length} ${t('settings.skill_candidates_count')}`;

      skillQueue.querySelectorAll('.approve-skill').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLButtonElement).dataset.id!;
          (btn as HTMLButtonElement).disabled = true;
          try {
            await zApi.approveSkillCandidate(id);
            await renderSkillQueue();
          } catch (err: unknown) {
            skillStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
      });
      skillQueue.querySelectorAll('.reject-skill').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLButtonElement).dataset.id!;
          (btn as HTMLButtonElement).disabled = true;
          try {
            await zApi.rejectSkillCandidate(id);
            await renderSkillQueue();
          } catch (err: unknown) {
            skillStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
      });
    } catch (err: unknown) {
      skillStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function renderAlwaysRules(): Promise<void> {
    try {
      const rules = await zApi.listAlwaysRules();
      alwaysRulesList.innerHTML = '';
      if (rules.length === 0) {
        alwaysRulesList.innerHTML = `<p class="muted">${t('settings.no_always_rules')}</p>`;
        return;
      }
      for (const r of rules) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.padding = '10px';
        const patterns = r.argPatterns && Object.keys(r.argPatterns).length > 0
          ? Object.entries(r.argPatterns).map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`).join(', ')
          : t('settings.always_rules_all_args');
        const statusClass = r.decision === 'always-allow' ? 'ok' : 'error';
        card.innerHTML = `
          <div class="row" style="justify-content:space-between;align-items:flex-start">
            <div>
              <strong>${escapeHtml(r.toolName)}</strong>
              <span class="status ${statusClass}" style="margin-left:8px;font-size:0.78em">${r.decision}</span>
              <p class="muted" style="margin:2px 0 0;font-size:0.82em">${patterns}</p>
            </div>
            <button class="secondary danger remove-always-rule" data-id="${r.id}" style="font-size:0.8em;padding:4px 8px">${t('settings.always_rules_remove')}</button>
          </div>
        `;
        alwaysRulesList.appendChild(card);
      }
      alwaysRulesList.querySelectorAll('.remove-always-rule').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLButtonElement).dataset.id!;
          (btn as HTMLButtonElement).disabled = true;
          try {
            await zApi.removeAlwaysRule(id);
            await renderAlwaysRules();
          } catch (err: unknown) {
            console.error(err);
          }
        });
      });
    } catch (err: unknown) {
      alwaysRulesList.innerHTML = `<p class="muted">Error: ${err instanceof Error ? err.message : String(err)}</p>`;
    }
  }

  discoverSkillsBtn.addEventListener('click', async () => {
    discoverSkillsBtn.disabled = true;
    try {
      skillStatus.textContent = t('settings.discovering_skills');
      const result = await zApi.runSuccessSkillDiscovery();
      skillStatus.textContent = `${t('settings.discovered')}: ${result.candidates} skills, ${result.facts} facts`;
      await renderSkillQueue();
    } catch (err: unknown) {
      skillStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      discoverSkillsBtn.disabled = false;
    }
  });

  refreshSkillsBtn.addEventListener('click', () => renderSkillQueue());

  // ── Browse project directory
  browseProjectBtn.addEventListener('click', async () => {
    try {
      browseProjectBtn.disabled = true;
      const dir = await zApi.selectDirectory();
      if (dir) projectDir.value = dir;
    } catch (err: unknown) {
      status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      browseProjectBtn.disabled = false;
    }
  });

  mcdTokenToggle.addEventListener('click', () => {
    const secured = mcdToken.classList.toggle('secured');
    mcdTokenToggle.textContent = secured ? '隐藏' : '显示';
  });

  amapKeyToggle.addEventListener('click', () => {
    const secured = amapKey.classList.toggle('secured');
    amapKeyToggle.textContent = secured ? '隐藏' : '显示';
  });

  function parseListInput(value: string): string[] {
    return value
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  saveBtn.addEventListener('click', async () => {
    try {
      await zApi.setSettings({
        defaultModel: { provider: provider.value, name: model.value.trim() },
        memoryEnabled: memory.checked,
        language: langSelect.value,
        apiKey: apiKey.value,
        apiEndpoint: endpoint.value,
        storageDir: storage.value.trim() || undefined,
        projectDir: projectDir.value.trim() || undefined,
        dryRun: dryRun.checked,
        toolPolicy: {
          allow: parseListInput(toolAllow.value),
          deny: parseListInput(toolDeny.value),
        },
        budget: {
          perRunTokens: Math.max(0, Number(budgetTokens.value) || 0),
          perRunUsd: Math.max(0, Number(budgetUsd.value) || 0),
          perDayUsd: Math.max(0, Number(budgetDayUsd.value) || 0),
        },
        mcdMcpToken: mcdToken.value.trim() || undefined,
        amapApiKey: amapKey.value.trim() || undefined,
      } as any);
      status.textContent = t('settings.saved');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = `${t('chat.error')}: ${msg}`;
    }
  });

  load();

  // Initial skill queue load
  renderSkillQueue();
  renderAlwaysRules();

  // Refresh profile status periodically
  updateProfileDisplay();
  setInterval(() => {
    updateProfileDisplay();
  }, 5000);
}

export function mountSettings(container: HTMLElement): void {
  renderSettings(container);
}

// Auto-mount
const observer = new MutationObserver(() => {
  const container = document.getElementById('view-settings');
  if (container && !container.querySelector('#settings-lang')) {
    mountSettings(container);
    applyTranslations();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export {};
