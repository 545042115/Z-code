// @z-assistant/app-desktop — renderer bootstrap (i18n)

import './chat';
import './trace';
import './settings';
import { t, loadLanguage } from './i18n';

function getView(): string {
  const m = location.search.match(/[?&]view=([^&]+)/);
  return m ? m[1] : 'main';
}

function showView(view: string): void {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(`view-${view}`);
  if (target) target.classList.add('active');
  document.querySelectorAll('#nav button').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.view === view);
  });
}

function applyNavTranslations(): void {
  const btnMain = document.querySelector('#nav button[data-view="main"]');
  const btnChat = document.querySelector('#nav button[data-view="chat"]');
  const btnTrace = document.querySelector('#nav button[data-view="trace"]');
  const btnSettings = document.querySelector('#nav button[data-view="settings"]');
  if (btnMain) btnMain.textContent = t('nav.main');
  if (btnChat) btnChat.textContent = t('nav.chat');
  if (btnTrace) btnTrace.textContent = t('nav.trace');
  if (btnSettings) btnSettings.textContent = t('nav.settings');
}

document.addEventListener('DOMContentLoaded', async () => {
  const app = document.getElementById('main');
  if (!app) return;

  // Load persisted language before rendering
  await loadLanguage();

  // Create view containers
  const views = ['main', 'chat', 'trace', 'settings'];
  for (const v of views) {
    const div = document.createElement('div');
    div.id = `view-${v}`;
    div.className = 'view';
    if (v === 'main') {
      div.innerHTML = `<div class="card"><h1>${t('main.title')}</h1><p class="muted">${t('main.description')}</p></div>`;
    }
    app.appendChild(div);
  }

  // Translate nav
  applyNavTranslations();

  // Nav click handlers
  document.querySelectorAll('#nav button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = (btn as HTMLElement).dataset.view!;
      showView(view);
    });
  });

  // Show initial view
  const initial = getView();
  showView(initial);
});

export {};
