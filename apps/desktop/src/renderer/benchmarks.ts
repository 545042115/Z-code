// @ziner/app-desktop — Benchmarks panel (P3 Harness)
//
// Shows available benchmark suites, Docker status, and lets the user
// run a suite and view results. Each case in the suite is a real
// GitHub repo fixture with a known bug — the agent's job is to fix
// the bug, and the grader runs the test suite to verify.

declare const zApi: import('../preload').ZDesktopAPI;
import { t } from './i18n';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

// ── Docker status ─────────────────────────────────────────────────────

async function checkDocker(): Promise<{ ok: boolean; version?: string; reason?: string }> {
  try {
    return await zApi.checkDocker();
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function renderDockerStatus(status: { ok: boolean; version?: string; reason?: string }): string {
  if (status.ok) {
    return `
      <div class="docker-status docker-ok">
        <span class="docker-icon">🐳</span>
        <div>
          <strong>${t('benchmarks.docker_available')}</strong>
          <span class="muted">${t('benchmarks.version')}: ${escapeHtml(status.version ?? 'unknown')}</span>
        </div>
      </div>`;
  }
  return `
    <div class="docker-status docker-unavailable">
      <span class="docker-icon">⚠️</span>
      <div>
        <strong>${t('benchmarks.docker_unavailable')}</strong>
        <span class="muted">${escapeHtml(status.reason ?? 'unknown error')}</span>
      </div>
    </div>`;
}

// ── Suite list ────────────────────────────────────────────────────────

async function loadSuites(): Promise<Array<{ id: string; name: string; cases: Array<{ id: string; name: string }> }>> {
  try {
    return await zApi.listBenchmarkSuites();
  } catch {
    return [];
  }
}

function renderSuiteCard(suite: { id: string; name: string; cases: Array<{ id: string; name: string }> }): string {
  return `
    <div class="card suite-card" data-suiteid="${escapeHtml(suite.id)}">
      <div class="suite-header">
        <h4>${escapeHtml(suite.name)}</h4>
        <span class="suite-case-count">${suite.cases.length} ${t('benchmarks.cases')}</span>
      </div>
      <div class="suite-cases">
        ${suite.cases.map((c) => `
          <div class="suite-case-item">
            <span class="case-icon">📝</span>
            <span class="case-name">${escapeHtml(c.name)}</span>
          </div>
        `).join('')}
      </div>
      <button class="primary run-suite-btn" data-suiteid="${escapeHtml(suite.id)}">
        ▶ ${t('benchmarks.run_suite')}
      </button>
    </div>`;
}

// ── Run results ───────────────────────────────────────────────────────

function renderResultSummary(summary: any): string {
  const passRate = summary.totalCases > 0
    ? ((summary.passedCases / summary.totalCases) * 100).toFixed(0)
    : 0;
  return `
    <div class="card result-summary-card">
      <div class="result-summary-header">
        <h3>${t('benchmarks.results')}</h3>
        <span class="result-duration">⏱ ${formatDuration(summary.totalDurationMs)}</span>
      </div>
      <div class="result-stats">
        <div class="result-stat">
          <span class="muted">${t('benchmarks.total')}</span>
          <strong>${summary.totalCases}</strong>
        </div>
        <div class="result-stat result-pass">
          <span class="muted">${t('benchmarks.passed')}</span>
          <strong>${summary.passedCases}</strong>
        </div>
        <div class="result-stat result-fail">
          <span class="muted">${t('benchmarks.failed')}</span>
          <strong>${summary.failedCases}</strong>
        </div>
        <div class="result-stat">
          <span class="muted">${t('benchmarks.mean_score')}</span>
          <strong>${summary.meanScore.toFixed(1)}</strong>
        </div>
      </div>
      <div class="pass-rate-bar">
        <div class="pass-rate-fill" style="width:${passRate}%"></div>
        <span class="pass-rate-label">${passRate}% ${t('benchmarks.pass_rate')}</span>
      </div>
    </div>`;
}

function renderEvaluationList(evaluations: any[]): string {
  return evaluations.map((ev) => {
    const passClass = ev.pass ? 'eval-pass' : 'eval-fail';
    const passIcon = ev.pass ? '✅' : '❌';
    return `
      <div class="card eval-card ${passClass}">
        <div class="eval-header">
          <span class="eval-icon">${passIcon}</span>
          <strong class="eval-id">${escapeHtml(ev.benchmarkId)}</strong>
          <span class="eval-score">${ev.total.toFixed(1)} / 3.0</span>
        </div>
        <div class="eval-scores">
          <div class="eval-score-item">
            <span class="muted">patchApplied</span>
            <span>${ev.scores.patchApplied ? '✅' : '❌'}</span>
          </div>
          <div class="eval-score-item">
            <span class="muted">testsPassed</span>
            <span>${ev.scores.testsPassed}</span>
          </div>
          <div class="eval-score-item">
            <span class="muted">buildClean</span>
            <span>${ev.scores.buildClean ? '✅' : '❌'}</span>
          </div>
        </div>
        ${ev.notes ? `<p class="muted eval-notes">${escapeHtml(ev.notes)}</p>` : ''}
        <div class="eval-footer">
          <span class="muted">${formatDuration(ev.durationMs)}</span>
          <span class="muted">${new Date(ev.timestamp).toLocaleTimeString()}</span>
        </div>
      </div>`;
  }).join('');
}

// ── Run a suite ───────────────────────────────────────────────────────

let isRunning = false;

async function runSuite(suiteId: string): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  const resultsContainer = document.getElementById('benchmark-results');
  if (resultsContainer) {
    resultsContainer.innerHTML = `
      <div class="card running-card">
        <div class="running-spinner"></div>
        <h4>${t('benchmarks.running')}</h4>
        <p class="muted">${t('benchmarks.running_desc')}</p>
      </div>`;
  }

  // Disable all run buttons
  document.querySelectorAll('.run-suite-btn').forEach((btn) => {
    (btn as HTMLButtonElement).disabled = true;
    (btn as HTMLButtonElement).textContent = t('benchmarks.running');
  });

  try {
    const summary = await zApi.runBenchmarkSuite(suiteId);
    if (resultsContainer) {
      resultsContainer.innerHTML =
        renderResultSummary(summary) +
        `<div class="eval-list">${renderEvaluationList(summary.evaluations)}</div>`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (resultsContainer) {
      resultsContainer.innerHTML = `
        <div class="card error-card">
          <h4>❌ ${t('benchmarks.run_failed')}</h4>
          <p class="muted">${escapeHtml(msg)}</p>
        </div>`;
    }
  } finally {
    isRunning = false;
    // Re-enable all run buttons
    document.querySelectorAll('.run-suite-btn').forEach((btn) => {
      (btn as HTMLButtonElement).disabled = false;
      const sid = (btn as HTMLElement).dataset.suiteid;
      if (sid) {
        (btn as HTMLButtonElement).textContent = `▶ ${t('benchmarks.run_suite')}`;
      }
    });
  }
}

// ── Mount ─────────────────────────────────────────────────────────────

function mountBenchmarks(container: HTMLElement): void {
  container.innerHTML = `
    <div class="benchmarks-container">
      <div class="benchmarks-header">
        <div>
          <h2>${t('benchmarks.title')}</h2>
          <p class="muted">${t('benchmarks.description')}</p>
        </div>
        <button id="benchmarks-refresh" class="secondary">🔄 ${t('benchmarks.refresh')}</button>
      </div>

      <div id="docker-status" class="card"></div>

      <div class="benchmarks-section">
        <h3>${t('benchmarks.available_suites')}</h3>
        <div id="suite-list" class="suite-grid"></div>
      </div>

      <div class="benchmarks-section">
        <h3>${t('benchmarks.results_title')}</h3>
        <div id="benchmark-results">
          <div class="card empty-card">
            <p class="muted">${t('benchmarks.no_results')}</p>
          </div>
        </div>
      </div>
    </div>`;

  const dockerEl = document.getElementById('docker-status');
  const suiteListEl = document.getElementById('suite-list');

  // Load docker status + suites in parallel
  void (async () => {
    const [status, suites] = await Promise.all([checkDocker(), loadSuites()]);
    if (dockerEl) dockerEl.innerHTML = renderDockerStatus(status);
    if (suiteListEl) {
      if (suites.length === 0) {
        suiteListEl.innerHTML = `<p class="muted">${t('benchmarks.no_suites')}</p>`;
      } else {
        suiteListEl.innerHTML = suites.map(renderSuiteCard).join('');
      }
    }
  })();

  // Refresh button
  document.getElementById('benchmarks-refresh')?.addEventListener('click', () => {
    mountBenchmarks(container);
  });

  // Run suite buttons (event delegation)
  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.run-suite-btn');
    if (btn) {
      const suiteId = (btn as HTMLElement).dataset.suiteid;
      if (suiteId) {
        void runSuite(suiteId);
      }
    }
  });
}

// Auto-mount via MutationObserver (same pattern as other views)
let benchmarksInitialized = false;
const observer = new MutationObserver(() => {
  const container = document.getElementById('view-benchmarks');
  if (container && !container.querySelector('.benchmarks-container') && !benchmarksInitialized) {
    benchmarksInitialized = true;
    mountBenchmarks(container);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export { mountBenchmarks, benchmarksInitialized };
