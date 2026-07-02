// @ziner/runtime — Computer Use security policy
//
// Action safety classification, risk levels, and danger operation
// interception for both web (browser) and OS-level (GUI) actions.

export type ActionRiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface ActionSafetyRule {
  /** Action type to match. */
  type: string;
  /** What to check in the action payload. */
  check: (payload: Record<string, unknown>) => boolean;
  /** Risk level if check passes. */
  risk: ActionRiskLevel;
  /** Human-readable warning message. */
  warning: string;
}

// ── Web action safety ──────────────────────────────────────────────────

export const WEB_ACTION_RULES: ActionSafetyRule[] = [
  // Check danger URL patterns first (most specific → highest priority).
  {
    type: 'navigate',
    check: (p) => {
      const url = (p.url as string) || '';
      return isDangerUrl(url);
    },
    risk: 'critical',
    warning: 'This page appears to perform a destructive operation (delete/remove/cancel).',
  },
  // Non-HTTPS URLs.
  {
    type: 'navigate',
    check: (p) => typeof p.url === 'string' && !p.url.startsWith('https://'),
    risk: 'medium',
    warning: 'Navigating to a non-HTTPS URL. Data may be transmitted in plaintext.',
  },
  // Default safe navigation.
  { type: 'navigate', check: () => true, risk: 'safe', warning: '' },
  { type: 'click', check: () => true, risk: 'safe', warning: '' },
  { type: 'type', check: () => true, risk: 'safe', warning: '' },
  { type: 'scroll', check: () => true, risk: 'safe', warning: '' },
  { type: 'wait', check: () => true, risk: 'safe', warning: '' },
  { type: 'screenshot', check: () => true, risk: 'safe', warning: '' },
  { type: 'reload', check: () => true, risk: 'safe', warning: '' },
  { type: 'back', check: () => true, risk: 'safe', warning: '' },
  { type: 'forward', check: () => true, risk: 'safe', warning: '' },

  // Typing into password fields.
  {
    type: 'type',
    check: (p) => String(p.elementId ?? '').includes('password'),
    risk: 'low',
    warning: 'Typing into a password field. The agent will see the input.',
  },
];

// ── GUI action safety ──────────────────────────────────────────────────

export const GUI_ACTION_RULES: ActionSafetyRule[] = [
  { type: 'mouse_move', check: () => true, risk: 'safe', warning: '' },
  { type: 'mouse_click', check: () => true, risk: 'safe', warning: '' },
  { type: 'clipboard_read', check: () => true, risk: 'low', warning: 'Reading clipboard content. Sensitive data may be exposed.' },
  { type: 'clipboard_write', check: () => true, risk: 'low', warning: 'Writing to clipboard.' },
  { type: 'keyboard_type', check: () => true, risk: 'safe', warning: '' },

  // Simulating hotkeys that could be dangerous.
  {
    type: 'keyboard_hotkey',
    check: (p) => {
      const keys = (p.keys as string[]) || [];
      const danger = keys.includes('Delete') || keys.includes('Backspace');
      return danger;
    },
    risk: 'high',
    warning: 'Hotkey may perform a delete/remove operation.',
  },
  // Window close / quit.
  {
    type: 'keyboard_hotkey',
    check: (p) => {
      const keys = (p.keys as string[]) || [];
      return keys.some((k) => ['F4', 'q', 'w'].includes(k.toLowerCase())) &&
        keys.some((k) => ['alt', 'control', 'command', 'meta'].includes(k.toLowerCase()));
    },
    risk: 'medium',
    warning: 'This hotkey may close an application or window.',
  },
];

// ── Danger URL patterns (web navigation blockers) ──────────────────────

const DANGER_URL_PATTERNS = [
  /\/delete-account/,
  /\/cancel-subscription/,
  /\/remove-billing/,
  /\/terminate/,
  /\/destroy/,
  /bank.*transfer/,
  /payment.*confirm/,
  /\/reset.*password/,
  /\/deactivate/,
];

export function isDangerUrl(url: string): boolean {
  return DANGER_URL_PATTERNS.some((p) => p.test(url));
}

// ── Classify & intercept ───────────────────────────────────────────────

export interface ActionClassification {
  risk: ActionRiskLevel;
  warning: string;
  blocked: boolean;
}

/**
 * Classify a web (browser) action by its risk level.
 * Returns the classification result.
 */
export function classifyWebAction(type: string, payload: Record<string, unknown>): ActionClassification {
  for (const rule of WEB_ACTION_RULES) {
    if (rule.type === type && rule.check(payload)) {
      return {
        risk: rule.risk,
        warning: rule.warning,
        blocked: rule.risk === 'critical',
      };
    }
  }
  return { risk: 'safe', warning: '', blocked: false };
}

/**
 * Classify a GUI / OS-level action by its risk level.
 */
export function classifyGUIAction(type: string, payload: Record<string, unknown>): ActionClassification {
  // If navigating to a danger URL via OS-level automation, block it.
  if (type === 'keyboard_type' && payload.text) {
    const url = String(payload.text);
    if (url.startsWith('http') && isDangerUrl(url)) {
      return {
        risk: 'critical',
        warning: 'This URL performs a dangerous operation. Blocked.',
        blocked: true,
      };
    }
  }

  for (const rule of GUI_ACTION_RULES) {
    if (rule.type === type && rule.check(payload)) {
      return {
        risk: rule.risk,
        warning: rule.warning,
        blocked: rule.risk === 'critical',
      };
    }
  }
  return { risk: 'safe', warning: '', blocked: false };
}
