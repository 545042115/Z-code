// Computer Use Service — Windows UIAutomation-based desktop automation
//
// Uses Windows Automation API (UIAutomation) to find windows, read UI
// element text, and simulate input. No OCR, no screenshots, no DLL injection.
//
// Requirements: Windows 7+ (UIAutomationCore.dll is built-in)

import { exec } from 'child_process';

export interface WindowInfo {
  title: string;
  className: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pid: number;
  visible: boolean;
}

export interface UIElement {
  name: string;
  className: string;
  automationId: string;
  controlType: string;
  bounds: { x: number; y: number; width: number; height: number };
  isEnabled: boolean;
  isVisible: boolean;
  /** Text content of the element (if available) */
  text: string;
  /** Children elements */
  children: UIElement[];
}

export class ComputerUseService {
  private _ready = false;

  async init(): Promise<void> {
    this._ready = true;
  }

  async destroy(): Promise<void> {
    this._ready = false;
  }

  get ready(): boolean { return this._ready; }

  // ── Window Detection ───────────────────────────────────────────

  /** Find all windows matching a title substring. */
  async findWindows(titleSubstring: string): Promise<WindowInfo[]> {
    const script = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${titleSubstring}*")
      $found = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
      $result = @()
      foreach ($el in $found) {
        $rect = $el.Current.BoundingRectangle
        $result += "$($el.Current.Name)|$($el.Current.ClassName)|$($rect.Left)|$($rect.Top)|$($rect.Width)|$($rect.Height)|$($el.Current.ProcessId)|True"
      }
      if ($result.Count -eq 0) { Write-Output "__EMPTY__" }
      else { $result | ForEach-Object { Write-Output $_ } }
    `;
    const out = await this._ps(script);
    if (out.trim() === '__EMPTY__' || !out.trim()) return [];
    const lines = out.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('|');
      return {
        title: parts[0],
        className: parts[1],
        x: parseInt(parts[2], 10),
        y: parseInt(parts[3], 10),
        width: parseInt(parts[4], 10),
        height: parseInt(parts[5], 10),
        pid: parseInt(parts[6], 10),
        visible: parts[7] === 'True',
      };
    });
  }

  /** Bring a window to the foreground. */
  async focusWindow(titleSubstring: string): Promise<boolean> {
    const script = `
      Add-Type -AssemblyName UIAutomationClient
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${titleSubstring}*")
      $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($el -ne $null) {
        $pattern = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) {
          $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
        }
        $el.SetFocus()
        Write-Output "True"
      } else {
        Write-Output "False"
      }
    `;
    const out = await this._ps(script);
    return out.trim() === 'True';
  }

  /** Get the bounding rectangle of a window. */
  async getWindowRect(titleSubstring: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const windows = await this.findWindows(titleSubstring);
    if (windows.length === 0) return null;
    const w = windows[0];
    return { x: w.x, y: w.y, width: w.width, height: w.height };
  }

  // ── UI Element Reading ─────────────────────────────────────────

  /**
   * Get the full UI element tree of a window as a structured object.
   * Uses UIAutomation's ContentViewWalker to get meaningful elements.
   */
  async getWindowUI(titleSubstring: string): Promise<UIElement | null> {
    const script = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${titleSubstring}*")
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($win -eq $null) { Write-Output "__NULL__"; return }

      function Get-ElementInfo($el, $depth) {
        $rect = $el.Current.BoundingRectangle
        $text = ""
        # Try to get text from various patterns
        $valPattern = $null
        $textPattern = $null
        $legacyPattern = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valPattern)) {
          $text = $valPattern.Current.Value
        } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
          $text = $textPattern.DocumentRange.GetText(-1)
        } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacyPattern)) {
          $text = $legacyPattern.Current.Name
        }
        if (-not $text) { $text = "" }
        $text = $text.Replace("|", " ").Replace("\`n", " ").Replace("\`r", " ")
        $info = "$($el.Current.Name)|$($el.Current.ClassName)|$($el.Current.AutomationId)|$($el.Current.LocalizedControlType)|$($rect.Left)|$($rect.Top)|$($rect.Width)|$($rect.Height)|$($el.Current.IsEnabled)|$($el.Current.IsOffscreen)|$text"
        Write-Output ("  " * $depth + $info)
        $walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker
        $child = $walker.GetFirstChild($el)
        while ($child -ne $null) {
          Get-ElementInfo $child ($depth + 1)
          $child = $walker.GetNextSibling($child)
        }
      }

      Get-ElementInfo $win 0
    `;
    const out = await this._ps(script);
    if (out.trim() === '__NULL__' || !out.trim()) return null;
    const lines = out.trim().split('\n').filter(Boolean);
    return this._parseUIElements(lines);
  }

  /**
   * Read all visible text from a window by walking the UI tree.
   * Returns a flat array of text strings with their element info.
   */
  async readWindowText(titleSubstring: string): Promise<Array<{ text: string; controlType: string; name: string }>> {
    const script = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${titleSubstring}*")
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($win -eq $null) { Write-Output "__NULL__"; return }

      function Get-Texts($el) {
        $text = ""
        $valPattern = $null
        $textPattern = $null
        $legacyPattern = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valPattern)) {
          $text = $valPattern.Current.Value
        } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
          $text = $textPattern.DocumentRange.GetText(-1)
        } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacyPattern)) {
          $text = $legacyPattern.Current.Name
        }
        if ($text -and $text.Trim()) {
          $safe = $text.Replace("|", " ").Replace("\`n", " ").Replace("\`r", " ").Trim()
          if ($safe) {
            Write-Output "$($el.Current.LocalizedControlType)|$($el.Current.Name)|$safe"
          }
        }
        $walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker
        $child = $walker.GetFirstChild($el)
        while ($child -ne $null) {
          Get-Texts $child
          $child = $walker.GetNextSibling($child)
        }
      }

      Get-Texts $win
    `;
    const out = await this._ps(script);
    if (out.trim() === '__NULL__' || !out.trim()) return [];
    const lines = out.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('|');
      return { controlType: parts[0] || '', name: parts[1] || '', text: parts.slice(2).join('|') };
    });
  }

  /**
   * Find a specific UI element by name (or partial name) within a window.
   */
  async findElement(windowTitle: string, elementName: string): Promise<UIElement | null> {
    const script = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${windowTitle}*")
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($win -eq $null) { Write-Output "__NULL__"; return }

      $cond2 = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${elementName}*")
      $el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond2)
      if ($el -eq $null) { Write-Output "__NULL__"; return }

      $rect = $el.Current.BoundingRectangle
      $text = ""
      $valPattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valPattern)) {
        $text = $valPattern.Current.Value
      }
      Write-Output "$($el.Current.Name)|$($el.Current.ClassName)|$($el.Current.AutomationId)|$($el.Current.LocalizedControlType)|$($rect.Left)|$($rect.Top)|$($rect.Width)|$($rect.Height)|$($el.Current.IsEnabled)|$($el.Current.IsOffscreen)|$text"
    `;
    const out = await this._ps(script);
    if (out.trim() === '__NULL__' || !out.trim()) return null;
    const parts = out.trim().split('|');
    return {
      name: parts[0],
      className: parts[1],
      automationId: parts[2],
      controlType: parts[3],
      bounds: {
        x: parseInt(parts[4], 10),
        y: parseInt(parts[5], 10),
        width: parseInt(parts[6], 10),
        height: parseInt(parts[7], 10),
      },
      isEnabled: parts[8] === 'True',
      isVisible: parts[9] !== 'True',
      text: parts.slice(10).join('|'),
      children: [],
    };
  }

  /**
   * Click a UI element by finding it and invoking its InvokePattern
   * or clicking at its center point.
   */
  async clickElement(windowTitle: string, elementName: string): Promise<boolean> {
    const script = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type -AssemblyName System.Windows.Forms
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${windowTitle}*")
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($win -eq $null) { Write-Output "False"; return }

      $cond2 = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${elementName}*")
      $el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond2)
      if ($el -eq $null) { Write-Output "False"; return }

      # Try InvokePattern first
      $invokePattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
        $invokePattern.Invoke()
        Write-Output "True"
        return
      }

      # Try TogglePattern
      $togglePattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$togglePattern)) {
        $togglePattern.Toggle()
        Write-Output "True"
        return
      }

      # Fallback: click at center point
      $rect = $el.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        $x = [int]($rect.Left + $rect.Width / 2)
        $y = [int]($rect.Top + $rect.Height / 2)
        [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
        Start-Sleep -Milliseconds 100
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class Mouse {
            [DllImport("user32.dll")]
            public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
          }
"@
        [Mouse]::mouse_event(0x02, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [Mouse]::mouse_event(0x04, 0, 0, 0, 0)
        Write-Output "True"
      } else {
        Write-Output "False"
      }
    `;
    const out = await this._ps(script);
    return out.trim() === 'True';
  }

  /**
   * Set text in an input field by finding it and using ValuePattern.
   */
  async setText(windowTitle: string, elementName: string, text: string): Promise<boolean> {
    const escaped = text.replace(/'/g, "''");
    const script = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${windowTitle}*")
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($win -eq $null) { Write-Output "False"; return }

      $cond2 = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "*${elementName}*")
      $el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond2)
      if ($el -eq $null) { Write-Output "False"; return }

      $valPattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valPattern)) {
        $valPattern.SetValue('${escaped}')
        Write-Output "True"
      } else {
        Write-Output "False"
      }
    `;
    const out = await this._ps(script);
    return out.trim() === 'True';
  }

  // ── Mouse & Keyboard (fallback) ────────────────────────────────

  async getCursorPos(): Promise<{ x: number; y: number }> {
    const out = await this._ps(`
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Mouse {
          [DllImport("user32.dll")]
          public static extern bool GetCursorPos(out POINT lpPoint);
          public struct POINT { public int X; public int Y; }
        }
"@
      $p = New-Object 'Mouse+POINT'
      [Mouse]::GetCursorPos([ref]$p)
      Write-Output "$($p.X),$($p.Y)"
    `);
    const [x, y] = out.trim().split(',').map(Number);
    return { x, y };
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this._ps(`
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Mouse {
          [DllImport("user32.dll")]
          public static extern bool SetCursorPos(int X, int Y);
        }
"@
      [Mouse]::SetCursorPos(${x}, ${y})
    `);
  }

  async mouseClick(): Promise<void> {
    await this._ps(`
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Mouse {
          [DllImport("user32.dll")]
          public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
        }
"@
      [Mouse]::mouse_event(0x02, 0, 0, 0, 0)
      Start-Sleep -Milliseconds 50
      [Mouse]::mouse_event(0x04, 0, 0, 0, 0)
    `);
  }

  async mouseClickAt(x: number, y: number): Promise<void> {
    await this.mouseMove(x, y);
    await this.mouseClick();
  }

  async typeText(text: string): Promise<void> {
    const escaped = text.replace(/'/g, "''");
    await this._ps(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
    `);
  }

  async pressKey(key: string): Promise<void> {
    await this._ps(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('{${key}}')
    `);
  }

  async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Helpers ────────────────────────────────────────────────────

  private _parseUIElements(lines: string[], depth = 0): UIElement | null {
    if (lines.length === 0) return null;
    const first = lines[0];
    const indent = first.search(/\S/);
    const parts = first.trim().split('|');
    if (parts.length < 11) return null;

    const elem: UIElement = {
      name: parts[0],
      className: parts[1],
      automationId: parts[2],
      controlType: parts[3],
      bounds: {
        x: parseInt(parts[4], 10),
        y: parseInt(parts[5], 10),
        width: parseInt(parts[6], 10),
        height: parseInt(parts[7], 10),
      },
      isEnabled: parts[8] === 'True',
      isVisible: parts[9] !== 'True',
      text: parts.slice(10).join('|'),
      children: [],
    };

    // Parse children (lines with greater indent)
    let i = 1;
    while (i < lines.length) {
      const childIndent = lines[i].search(/\S/);
      if (childIndent <= indent) break;
      const childLines = [lines[i]];
      i++;
      while (i < lines.length && lines[i].search(/\S/) > childIndent) {
        childLines.push(lines[i]);
        i++;
      }
      const child = this._parseUIElements(childLines, childIndent);
      if (child) elem.children.push(child);
    }

    return elem;
  }

  private _ps(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = exec(
        'powershell -NoProfile -NonInteractive -Command -',
        { timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            if (stdout) resolve(stdout.trim());
            else reject(new Error(`PowerShell error: ${stderr || err.message}`));
          } else {
            resolve(stdout.trim());
          }
        }
      );
      if (proc.stdin) {
        proc.stdin.write(script);
        proc.stdin.end();
      }
    });
  }
}
