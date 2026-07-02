// @ziner/app-desktop — renderer bootstrap (i18n)
//
// Views are lazy-mounted via MutationObserver in each module.
// Top-level imports are fine — the observer defers DOM work until
// the view container actually appears in the DOM.

import './main';
import './chat';
import './trace';
import './memory';
import './settings';
import './confirmation';
import './benchmarks';
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
  const navItems = [
    { view: 'main', labelKey: 'nav.main' },
    { view: 'chat', labelKey: 'nav.chat' },
    { view: 'trace', labelKey: 'nav.trace' },
    { view: 'memory', labelKey: 'nav.memory' },
    { view: 'benchmarks', labelKey: 'nav.benchmarks' },
    { view: 'settings', labelKey: 'nav.settings' },
  ];

  navItems.forEach(({ view, labelKey }) => {
    const btn = document.querySelector(`#nav button[data-view="${view}"]`) as HTMLElement;
    if (!btn) return;
    const label = btn.querySelector('.nav-label');
    if (label) label.textContent = t(labelKey);
    btn.setAttribute('data-tooltip', t(labelKey));
  });
}

function setupWindowControls(): void {
  const api = (window as any).zApi;
  if (!api) return;

  const btnMin = document.getElementById('win-minimize');
  const btnMax = document.getElementById('win-maximize');
  const btnClose = document.getElementById('win-close');

  btnMin?.addEventListener('click', () => api.windowMinimize?.());
  btnMax?.addEventListener('click', () => api.windowMaximize?.());
  btnClose?.addEventListener('click', () => api.windowClose?.());

  const updateMaxButton = async () => {
    if (!btnMax) return;
    try {
      const maximized = await api.windowIsMaximized?.();
      if (maximized) {
        btnMax.title = 'Restore';
        const svg = btnMax.querySelector('svg');
        if (svg) {
          svg.innerHTML = '<path d="M2.5 1.5h5v5h-5v-5z M4.5 4.5h4v4h-4v-4z" fill="none" stroke="currentColor" stroke-width="0.8"/>';
        }
      } else {
        btnMax.title = 'Maximize';
        const svg = btnMax.querySelector('svg');
        if (svg) {
          svg.innerHTML = '<rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/>';
        }
      }
    } catch { /* ignore */ }
  };

  updateMaxButton();
  api.windowOnMaximizeChange?.(() => updateMaxButton());
}

document.addEventListener('DOMContentLoaded', async () => {
  const app = document.getElementById('main');
  if (!app) return;

  setupWindowControls();

  // Load persisted language before rendering
  await loadLanguage();

  // Create view containers
  const views = ['main', 'chat', 'trace', 'memory', 'benchmarks', 'settings'];
  for (const v of views) {
    const div = document.createElement('div');
    div.id = `view-${v}`;
    div.className = 'view';
    app.appendChild(div);
  }

  // Translate nav
  applyNavTranslations();

  // Nav click handlers
  document.querySelectorAll('#nav button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // If a confirmation modal is active, ignore nav clicks so the user
      // cannot switch views while a tool decision is pending.
      const overlay = document.getElementById('confirmation-overlay');
      if (overlay?.classList.contains('active')) {
        return;
      }
      const view = (btn as HTMLElement).dataset.view!;
      showView(view);
    });
  });

  // Show initial view
  const initial = getView();
  showView(initial);
});

export {};
