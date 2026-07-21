// IPlatformCapabilities — platform capability declaration.
//
// Platforms implement this interface to declare what they can do.
// Tools declare their requirements via ToolMetadata.requires.
// The Orchestrator checks capabilities before invoking tools.
//
// All methods are optional — a platform only implements what it supports.

export interface IPlatformCapabilities {
  // ── File System ──────────────────────────────────────────────

  /** Read a file. Desktop: any path. Mobile: limited to Documents dir. */
  readFile?(path: string): Promise<string>;
  /** Write a file. Desktop: any path. Mobile: limited to Documents dir. */
  writeFile?(path: string, content: string): Promise<void>;
  /** List files in a directory. Desktop only (Mobile sandboxed). */
  listFiles?(dir: string): Promise<string[]>;

  // ── Process Execution (Desktop only) ─────────────────────────

  /** Execute a shell command. Desktop only. */
  exec?(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  // ── Native Mobile Capabilities ───────────────────────────────

  /** Show a local notification. */
  notify?(title: string, body: string): Promise<void>;
  /** Vibrate the device. */
  vibrate?(pattern: number | number[]): Promise<void>;
  /** Share text via system share sheet. */
  share?(text: string, title?: string): Promise<void>;
  /** Copy text to clipboard. */
  copyToClipboard?(text: string): Promise<void>;

  // ── Browser Automation (Desktop only) ────────────────────────

  /** Take a screenshot. Desktop only. */
  screenshot?(): Promise<string>;

  // ── Docker (Desktop only) ─────────────────────────────────────

  /** Check if Docker is available. */
  dockerAvailable?(): Promise<boolean>;
}

/** Check if a platform has a specific capability. */
export function hasCapability(caps: IPlatformCapabilities, name: string): boolean {
  return typeof (caps as Record<string, unknown>)[name] === 'function';
}

/** Check if a platform supports all required capabilities. */
export function hasAllCapabilities(caps: IPlatformCapabilities, required: string[]): boolean {
  return required.every((r) => hasCapability(caps, r));
}
