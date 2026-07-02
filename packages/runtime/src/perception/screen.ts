// @ziner/runtime — screen perception
//
// Screen capture abstraction. On Desktop, this uses the OS screenshot
// API (via Electron's desktopCapturer or system-level screenshot tools).
// In headless environments, it's a no-op; the BrowserAgent captures
// its own screenshots via Playwright.

export interface ScreenCaptureResult {
  /** Base64-encoded PNG of the screen. */
  screenshotBase64: string;
  /** Screen dimensions. */
  width: number;
  height: number;
  /** Timestamp. */
  capturedAt: number;
}

export interface IScreenProvider {
  readonly name: string;
  /** Capture a screenshot of the primary display. */
  capture(): Promise<ScreenCaptureResult>;
  /** Capture a screenshot of a specific display/region. */
  captureRegion(x: number, y: number, width: number, height: number): Promise<ScreenCaptureResult>;
}

/**
 * No-op screen provider for headless / server environments.
 * Returns an empty placeholder screenshot.
 */
export function createNoopScreenProvider(): IScreenProvider {
  return {
    name: 'noop',
    async capture() {
      return { screenshotBase64: '', width: 0, height: 0, capturedAt: Date.now() };
    },
    async captureRegion(_x, _y, _w, _h) {
      return { screenshotBase64: '', width: 0, height: 0, capturedAt: Date.now() };
    },
  };
}

/**
 * Desktop screen provider that shells out to a system screenshot command.
 * Suitable on macOS (screencapture), Windows (PowerShell), and Linux (import).
 */
export function createDesktopScreenProvider(): IScreenProvider {
  const { execSync } = require('child_process');
  const { tmpdir } = require('os');
  const { join } = require('path');
  const { readFileSync, unlinkSync } = require('fs');

  function capture(path: string): Buffer {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync(`screencapture -x -t png "${path}"`, { timeout: 10000 });
    } else if (platform === 'win32') {
      execSync(
        `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ` +
        `ForEach-Object { $b = $_; Add-Type -AssemblyName System.Drawing; ` +
        `$bitmap = New-Object System.Drawing.Bitmap $b.Width, $b.Height; ` +
        `$graphics = [System.Drawing.Graphics]::FromImage($bitmap); ` +
        `$graphics.CopyFromScreen($b.X, $b.Y, 0, 0, $bitmap.Size); ` +
        `$bitmap.Save('${path}', [System.Drawing.Imaging.ImageFormat]::Png); "`,
        { timeout: 15000 }
      );
    } else {
      // Linux
      execSync(`import -window root "${path}"`, { timeout: 10000 });
    }
    return readFileSync(path);
  }

  return {
    name: 'desktop-screen',
    async capture() {
      const tmp = join(tmpdir(), `z-screen-${Date.now()}.png`);
      try {
        const buf = capture(tmp);
        return {
          screenshotBase64: buf.toString('base64'),
          width: 1920,
          height: 1080,
          capturedAt: Date.now(),
        };
      } finally {
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
    },
    async captureRegion(x, y, w, h) {
      const tmp = join(tmpdir(), `z-screen-${Date.now()}.png`);
      try {
        const buf = capture(tmp);
        return {
          screenshotBase64: buf.toString('base64'),
          width: w,
          height: h,
          capturedAt: Date.now(),
        };
      } finally {
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
    },
  };
}
