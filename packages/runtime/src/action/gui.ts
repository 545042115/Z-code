// @z-assistant/runtime — GUI automation actions
//
// Low-level mouse / keyboard / clipboard / window control.
// These actions run at the operating system level (not inside a browser).

export type GUIActionType =
  | 'mouse_move'
  | 'mouse_click'
  | 'mouse_dblclick'
  | 'mouse_drag'
  | 'keyboard_type'
  | 'keyboard_press'
  | 'keyboard_hotkey'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'window_minimize'
  | 'window_maximize'
  | 'window_focus';

export interface GUIAction {
  type: GUIActionType;
  /** Screen coordinates (for mouse actions). */
  x?: number;
  y?: number;
  /** Text or key name. */
  text?: string;
  /** Keys for hotkey (e.g. ['Control', 'c']). */
  keys?: string[];
}

export interface GUIResult {
  success: boolean;
  error?: string;
  /** Data read from clipboard (for clipboard_read). */
  data?: string;
}

export interface IGUIProvider {
  readonly name: string;
  execute(action: GUIAction): Promise<GUIResult>;
  /** Get primary display size. */
  screenSize(): Promise<{ width: number; height: number }>;
}

/**
 * No-op GUI provider for headless / server environments.
 */
export function createNoopGUIProvider(): IGUIProvider {
  return {
    name: 'noop',
    async execute() {
      return { success: true };
    },
    async screenSize() {
      return { width: 0, height: 0 };
    },
  };
}

/**
 * Desktop GUI provider using OS-level automation (PowerShell on Windows,
 * osascript on macOS, xdotool on Linux).
 */
export function createDesktopGUIProvider(): IGUIProvider {
  const { execSync } = require('child_process');

  function shell(cmd: string, timeout = 10000): string {
    return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
  }

  return {
    name: 'desktop-gui',

    async execute(action: GUIAction): Promise<GUIResult> {
      try {
        const platform = process.platform;
        switch (action.type) {
          case 'mouse_move': {
            if (platform === 'darwin') {
              shell(`osascript -e 'tell application "System Events" to set mouse position to {${action.x ?? 0}, ${action.y ?? 0}}'`);
            } else if (platform === 'win32') {
              shell(`powershell -Command "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${action.x ?? 0}, ${action.y ?? 0})"`);
            } else {
              shell(`xdotool mousemove ${action.x ?? 0} ${action.y ?? 0}`);
            }
            return { success: true };
          }
          case 'mouse_click': {
            if (platform === 'win32') {
              shell(`powershell -Command "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${action.x ?? 0}, ${action.y ?? 0}); [System.Windows.Forms.SendKeys]::SendWait('{Click}')"`);
            } else {
              await this.execute({ type: 'mouse_move', x: action.x, y: action.y });
              if (platform === 'darwin') shell(`osascript -e 'tell application "System Events" to click at {${action.x ?? 0}, ${action.y ?? 0}}'`);
              else shell('xdotool click 1');
            }
            return { success: true };
          }
          case 'mouse_dblclick': {
            if (platform === 'win32') {
              shell(`powershell -Command "[System.Windows.Forms.SendKeys]::SendWait('{DoubleClick}')"`);
            } else if (platform === 'darwin') {
              shell(`osascript -e 'tell application "System Events" to double click at {${action.x ?? 0}, ${action.y ?? 0}}'`);
            } else {
              shell('xdotool click --repeat 2 1');
            }
            return { success: true };
          }
          case 'mouse_drag': {
            if (platform === 'linux') {
              shell(`xdotool mousedown 1 mousemove ${action.x ?? 0} ${action.y ?? 0} mouseup 1`);
            }
            return { success: true };
          }
          case 'keyboard_type': {
            if (platform === 'win32') {
              shell(`powershell -Command "[System.Windows.Forms.SendKeys]::SendWait('${(action.text ?? '').replace(/'/g, "''")}')"`);
            } else if (platform === 'darwin') {
              const escaped = (action.text ?? '').replace(/"/g, '\\"');
              shell(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
            } else {
              shell(`xdotool type --delay 50 "${(action.text ?? '').replace(/"/g, '\\"')}"`);
            }
            return { success: true };
          }
          case 'keyboard_press': {
            if (platform === 'win32') {
              shell(`powershell -Command "[System.Windows.Forms.SendKeys]::SendWait('{${action.text}}')"`);
            } else if (platform === 'darwin') {
              shell(`osascript -e 'tell application "System Events" to key code ${keyCode(action.text ?? 'Return')}'`);
            } else {
              shell(`xdotool key ${action.text ?? 'Return'}`);
            }
            return { success: true };
          }
          case 'keyboard_hotkey': {
            if (platform === 'win32') {
              const combo = (action.keys ?? []).join('^');
              shell(`powershell -Command "[System.Windows.Forms.SendKeys]::SendWait('^${combo}')"`);
            } else if (platform === 'darwin') {
              const combo = (action.keys ?? []).map((k) => k.toLowerCase()).join(', ');
              shell(`osascript -e 'tell application "System Events" to keystroke "${action.keys?.[action.keys.length - 1] ?? ''}" using {${combo}}'`);
            } else {
              shell(`xdotool key ${(action.keys ?? []).join('+').toLowerCase()}`);
            }
            return { success: true };
          }
          case 'clipboard_read': {
            if (platform === 'darwin') {
              const data = shell('pbpaste');
              return { success: true, data };
            } else if (platform === 'win32') {
              const data = shell(`powershell -Command "Get-Clipboard"`);
              return { success: true, data };
            } else {
              const data = shell('xclip -o -selection clipboard');
              return { success: true, data };
            }
          }
          case 'clipboard_write': {
            if (platform === 'darwin') {
              shell(`echo "${(action.text ?? '').replace(/"/g, '\\"')} | pbcopy"`);
            } else if (platform === 'win32') {
              shell(`echo "${(action.text ?? '').replace(/"/g, '\\"')} | clip"`);
            } else {
              shell(`echo "${(action.text ?? '').replace(/"/g, '\\"')} | xclip -selection clipboard"`);
            }
            return { success: true };
          }
          default:
            return { success: true };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },

    async screenSize() {
      const platform = process.platform;
      if (platform === 'darwin') {
        const out = shell(`osascript -e 'tell application "Finder" to get bounds of window of desktop'`);
        const parts = out.split(', ').map(Number);
        return { width: parts[2] || 1920, height: parts[3] || 1080 };
      } else if (platform === 'win32') {
        const out = shell(`powershell -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width.ToString() + ' ' + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height.ToString()"`);
        const parts = out.split(' ').map(Number);
        return { width: parts[0] || 1920, height: parts[1] || 1080 };
      } else {
        return { width: 1920, height: 1080 };
      }
    },
  };
}

const KEY_CODE_MAP: Record<string, number> = {
  'Return': 36,
  'Enter': 36,
  'Tab': 48,
  'Escape': 53,
  'Delete': 51,
  'Backspace': 51,
  'Space': 49,
  'ArrowUp': 126,
  'ArrowDown': 125,
  'ArrowLeft': 123,
  'ArrowRight': 124,
};

function keyCode(key: string): number {
  return KEY_CODE_MAP[key] ?? 36;
}
