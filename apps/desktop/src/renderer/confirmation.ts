// @z-assistant/app-desktop — P1-2 HITL Confirmation Modal (renderer)
//
// Listens for ConfirmationRequest events from the main process and shows
// a modal with the tool name, risk badge, reason, and a preview of the
// action. The user can Allow / Deny / Always Allow / Always Deny.
//
// The modal is injected into the DOM on first load and re-used for every
// request. Only one request is shown at a time; if a new request arrives
// while one is pending, it queues (the main process holds the Promise).

declare const zApi: import('../preload').ZDesktopAPI;
import type { ConfirmationRequest, Decision, RiskLevel } from '@z-assistant/contracts';

// ── Queue state ────────────────────────────────────────────────────────

interface QueuedRequest {
  req: ConfirmationRequest;
  shown: boolean;
}

const queue: QueuedRequest[] = [];
let currentRequest: ConfirmationRequest | null = null;
let modalEl: HTMLElement | null = null;

// ── Risk badge labels ──────────────────────────────────────────────────

const RISK_LABELS: Record<RiskLevel, string> = {
  safe: 'Safe',
  low: 'Low Risk',
  medium: 'Medium Risk',
  high: 'High Risk',
  critical: 'Critical',
};

const RISK_DESCRIPTIONS: Record<RiskLevel, string> = {
  safe: 'This action is considered safe and was auto-approved.',
  low: 'Low-risk action. Confirmation recommended but not required.',
  medium: 'Medium-risk action. Please review before approving.',
  high: 'High-risk action. Carefully review the preview before approving.',
  critical: 'Critical action. This should be blocked automatically.',
};

// ── DOM helpers ────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function ensureModal(): HTMLElement {
  if (modalEl) return modalEl;

  const overlay = document.createElement('div');
  overlay.id = 'confirmation-overlay';
  overlay.innerHTML = `
    <div class="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="confirmation-title">
      <div class="confirmation-header">
        <h3 id="confirmation-title">Action Confirmation</h3>
        <span class="confirmation-risk-badge" id="confirmation-risk-badge"></span>
      </div>
      <div class="confirmation-body">
        <p class="confirmation-reason" id="confirmation-reason"></p>
        <div class="confirmation-tool">
          <span>Tool:</span>
          <code id="confirmation-tool-name"></code>
        </div>
        <div class="confirmation-preview" id="confirmation-preview" style="display:none">
          <div class="confirmation-preview-title" id="confirmation-preview-title"></div>
          <pre class="confirmation-preview-content" id="confirmation-preview-content"></pre>
        </div>
      </div>
      <div class="confirmation-actions">
        <button id="confirmation-btn-always-deny" title="Deny this and all future calls to this tool">Always Deny</button>
        <button id="confirmation-btn-deny" class="danger">Deny</button>
        <button id="confirmation-btn-always-allow" title="Allow this and all future calls to this tool">Always Allow</button>
        <button id="confirmation-btn-allow" class="primary">Allow</button>
      </div>
      <div class="confirmation-footer" id="confirmation-footer"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Wire button handlers.
  const wire = (id: string, decision: Decision) => {
    const btn = overlay.querySelector(`#${id}`) as HTMLButtonElement;
    btn.addEventListener('click', () => onDecision(decision));
  };
  wire('confirmation-btn-allow', 'allow');
  wire('confirmation-btn-deny', 'deny');
  wire('confirmation-btn-always-allow', 'always-allow');
  wire('confirmation-btn-always-deny', 'always-deny');

  // Esc → deny; Enter → allow.
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDecision('deny');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onDecision('allow');
    }
  });

  modalEl = overlay;
  return overlay;
}

// ── Render a request ───────────────────────────────────────────────────

function renderRequest(req: ConfirmationRequest): void {
  const overlay = ensureModal();
  const badge = overlay.querySelector('#confirmation-risk-badge') as HTMLElement;
  const reason = overlay.querySelector('#confirmation-reason') as HTMLElement;
  const toolName = overlay.querySelector('#confirmation-tool-name') as HTMLElement;
  const previewWrap = overlay.querySelector('#confirmation-preview') as HTMLElement;
  const previewTitle = overlay.querySelector('#confirmation-preview-title') as HTMLElement;
  const previewContent = overlay.querySelector('#confirmation-preview-content') as HTMLElement;
  const footer = overlay.querySelector('#confirmation-footer') as HTMLElement;
  const title = overlay.querySelector('#confirmation-title') as HTMLElement;

  title.textContent = 'Action Confirmation';
  badge.textContent = RISK_LABELS[req.risk];
  badge.className = `confirmation-risk-badge ${req.risk}`;
  reason.textContent = req.reason || RISK_DESCRIPTIONS[req.risk];
  toolName.textContent = req.invocation.toolName;

  // Render preview if present.
  if (req.preview && req.preview.content) {
    previewWrap.style.display = 'block';
    previewTitle.textContent = req.preview.title || req.preview.kind;
    previewContent.className = `confirmation-preview-content ${req.preview.kind}`;
    previewContent.textContent = req.preview.content;
  } else {
    previewWrap.style.display = 'none';
  }

  // Footer: timestamp + request id (truncated).
  const ts = new Date(req.createdAt).toLocaleTimeString();
  footer.textContent = `Requested at ${ts} · id ${req.id.slice(0, 8)}`;

  // Disable Allow buttons for critical risk.
  const allowBtn = overlay.querySelector('#confirmation-btn-allow') as HTMLButtonElement;
  const alwaysAllowBtn = overlay.querySelector('#confirmation-btn-always-allow') as HTMLButtonElement;
  const isCritical = req.risk === 'critical';
  allowBtn.disabled = isCritical;
  alwaysAllowBtn.disabled = isCritical;

  overlay.classList.add('active');
  // Focus the Allow button for keyboard users (unless critical).
  setTimeout(() => {
    const focusTarget = isCritical
      ? overlay.querySelector<HTMLButtonElement>('#confirmation-btn-deny')
      : allowBtn;
    focusTarget?.focus();
  }, 50);
}

function hideModal(): void {
  if (modalEl) modalEl.classList.remove('active');
}

// ── Decision handler ───────────────────────────────────────────────────

async function onDecision(decision: Decision): Promise<void> {
  if (!currentRequest) return;
  const req = currentRequest;
  currentRequest = null;
  hideModal();
  try {
    await zApi.confirmAction(req.id, decision);
  } catch (e) {
    console.error('[confirmation] confirmAction failed:', e);
  }
  // Show next queued request if any.
  showNext();
}

// ── Queue management ───────────────────────────────────────────────────

function showNext(): void {
  if (currentRequest) return;
  const next = queue.shift();
  if (!next) return;
  currentRequest = next.req;
  renderRequest(currentRequest);
}

function enqueueRequest(req: ConfirmationRequest): void {
  queue.push({ req, shown: false });
  showNext();
}

// ── Bootstrap ──────────────────────────────────────────────────────────

let initialized = false;

export function initConfirmationModal(): void {
  if (initialized) return;
  initialized = true;
  zApi.onConfirmationRequest((req) => {
    enqueueRequest(req);
  });
}

// Auto-init on DOMContentLoaded (safe to call from index.ts import).
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => initConfirmationModal());
}

export {};
