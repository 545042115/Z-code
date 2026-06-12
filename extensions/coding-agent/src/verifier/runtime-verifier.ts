import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface VerificationDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

export interface VerificationResult {
  type: 'build' | 'test' | 'lint' | 'custom';
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  diagnostics: VerificationDiagnostic[];
  passed: boolean;
  skipped: boolean;
}

export interface ProjectConfig {
  type: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo' | 'go' | 'python' | 'unknown';
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  packageManager?: string;
}

/**
 * RuntimeVerifier runs build, test, lint, and custom commands
 * and parses their output into structured diagnostics.
 */
export class RuntimeVerifier {
  private workspaceRoot: string;
  private projectRoot: string;
  private config: ProjectConfig | null = null;
  private initialized = false;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.projectRoot = this.workspaceRoot;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.config = await this.detectProjectConfig();
    this.initialized = true;
    console.log(`[RuntimeVerifier] Detected project type: ${this.config.type}`);
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get projectConfig(): ProjectConfig | null {
    return this.config;
  }

  get detectedProjectRoot(): string {
    return this.projectRoot;
  }

  /** Run the project's build command. */
  async verifyBuild(): Promise<VerificationResult> {
    await this.initialize();
    const cmd = this.config?.buildCommand;
    if (!cmd) {
      return this.skippedResult('build', 'No build command detected');
    }
    return this.runAndParse(cmd, 'build');
  }

  /** Run the project's test command. */
  async verifyTests(): Promise<VerificationResult> {
    await this.initialize();
    const cmd = this.config?.testCommand;
    if (!cmd) {
      return this.skippedResult('test', 'No test command detected');
    }
    return this.runAndParse(cmd, 'test');
  }

  /** Run the project's lint command. */
  async verifyLint(): Promise<VerificationResult> {
    await this.initialize();
    const cmd = this.config?.lintCommand;
    if (!cmd) {
      return this.skippedResult('lint', 'No lint command detected');
    }
    return this.runAndParse(cmd, 'lint');
  }

  /** Run an arbitrary command and parse its output. */
  async verifyCommand(command: string): Promise<VerificationResult> {
    await this.initialize();
    return this.runAndParse(command, 'custom');
  }

  /**
   * Run build + tests for a set of changed files.
   * Returns combined results.
   */
  async verifyPatch(filesChanged: string[]): Promise<VerificationResult[]> {
    await this.initialize();
    const results: VerificationResult[] = [];

    const buildResult = await this.verifyBuild();
    results.push(buildResult);

    const testResult = await this.verifyTests();
    results.push(testResult);

    // If tests or build failed, also run lint for extra signal
    if ((!buildResult.passed && !buildResult.skipped) || (!testResult.passed && !testResult.skipped)) {
      const lintResult = await this.verifyLint();
      results.push(lintResult);
    }

    return results;
  }

  /** Format results into a concise string for LLM prompts. */
  formatResultsForPrompt(results: VerificationResult[]): string {
    if (results.length === 0) return '(no verification results)';

    const lines: string[] = ['## Verification Results'];
    for (const r of results) {
      if (r.skipped) {
        lines.push(`- ${r.type.toUpperCase()}: skipped (${r.stderr || 'no command'})`);
        continue;
      }
      const icon = r.passed ? '✅' : '❌';
      lines.push(`- ${icon} ${r.type.toUpperCase()}: \`${r.command}\` — exit ${r.exitCode}, ${r.durationMs}ms`);
      if (!r.passed && r.diagnostics.length > 0) {
        for (const d of r.diagnostics.slice(0, 10)) {
          const loc = d.file ? `${this.shortenPath(d.file)}:${d.line || 0}` : 'global';
          lines.push(`  [${d.severity.toUpperCase()}] ${loc} — ${d.message.slice(0, 120)}`);
        }
        if (r.diagnostics.length > 10) {
          lines.push(`  ... and ${r.diagnostics.length - 10} more`);
        }
      }
    }
    return lines.join('\n');
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async detectProjectConfig(): Promise<ProjectConfig> {
    const root = await this.resolveProjectRoot();
    this.projectRoot = root;
    if (!root) return { type: 'unknown' };

    // Node.js ecosystem
    if (await this.fileExists('package.json')) {
      return await this.detectNodeProject();
    }

    // Rust
    if (await this.fileExists('Cargo.toml')) {
      return {
        type: 'cargo',
        buildCommand: 'cargo build',
        testCommand: 'cargo test',
        lintCommand: 'cargo clippy',
      };
    }

    // Go
    if (await this.fileExists('go.mod')) {
      return {
        type: 'go',
        buildCommand: 'go build ./...',
        testCommand: 'go test ./...',
        lintCommand: 'go vet ./...',
      };
    }

    // Python
    if (await this.fileExists('setup.py') || await this.fileExists('pyproject.toml') || await this.fileExists('requirements.txt')) {
      const testCmd = await this.fileExists('pytest.ini') || await this.fileExists('pyproject.toml')
        ? 'pytest'
        : (await this.fileExists('tox.ini') ? 'tox' : 'python -m unittest discover');
      return {
        type: 'python',
        buildCommand: undefined,
        testCommand: testCmd,
        lintCommand: 'flake8 .',
      };
    }

    return { type: 'unknown' };
  }

  private async detectNodeProject(): Promise<ProjectConfig> {
    const root = this.projectRoot;

    // Detect package manager
    let pm = 'npm';
    if (await this.fileExists('pnpm-lock.yaml')) pm = 'pnpm';
    else if (await this.fileExists('yarn.lock')) pm = 'yarn';
    else if (await this.fileExists('bun.lockb')) pm = 'bun';
    else if (await this.fileExists('package-lock.json')) pm = 'npm';

    // Read package.json scripts
    let scripts: Record<string, string> = {};
    try {
      const pkgUri = vscode.Uri.joinPath(vscode.Uri.file(root), 'package.json');
      const bytes = await vscode.workspace.fs.readFile(pkgUri);
      const pkg = JSON.parse(new TextDecoder().decode(bytes));
      scripts = pkg.scripts || {};
    } catch {
      // ignore
    }

    const run = (script: string) => `${pm} ${pm === 'npm' ? 'run ' : ''}${script}`;

    let buildCommand = scripts.build ? run('build') : undefined;
    const testCommand = scripts.test ? run('test') : undefined;
    let lintCommand = scripts.lint ? run('lint') : undefined;

    // Fallback lint command
    if (!lintCommand) {
      const hasEslint = await this.fileExists('.eslintrc') || await this.fileExists('.eslintrc.json') || await this.fileExists('.eslintrc.js') || await this.fileExists('eslint.config.js') || await this.fileExists('eslint.config.mjs');
      if (hasEslint) {
        lintCommand = `${pm === 'npm' ? 'npx' : pm} eslint .`;
      }
    }

    // Fallback build for TS projects
    if (!buildCommand && (await this.fileExists('tsconfig.json'))) {
      buildCommand = `${pm === 'npm' ? 'npx' : pm} tsc --noEmit`;
    }

    return { type: pm as any, buildCommand, testCommand, lintCommand, packageManager: pm };
  }

  private async runAndParse(command: string, type: VerificationResult['type']): Promise<VerificationResult> {
    const start = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.projectRoot,
        timeout: 120000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const duration = Date.now() - start;
      const combined = stdout + '\n' + stderr;
      const diagnostics = this.parseDiagnostics(combined, type);
      return {
        type,
        command,
        exitCode: 0,
        durationMs: duration,
        stdout: stdout || '',
        stderr: stderr || '',
        diagnostics,
        passed: diagnostics.filter(d => d.severity === 'error').length === 0,
        skipped: false,
      };
    } catch (err: any) {
      const duration = Date.now() - start;
      const stdout = err.stdout || '';
      const stderr = err.stderr || '';
      const combined = stdout + '\n' + stderr;
      const diagnostics = this.parseDiagnostics(combined, type);
      return {
        type,
        command,
        exitCode: err.code || 1,
        durationMs: duration,
        stdout,
        stderr,
        diagnostics,
        passed: false,
        skipped: false,
      };
    }
  }

  private parseDiagnostics(output: string, type: VerificationResult['type']): VerificationDiagnostic[] {
    const diagnostics: VerificationDiagnostic[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // TypeScript / tsc
      const tsMatch = trimmed.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s*(TS\d+:\s*.+)$/i);
      if (tsMatch) {
        diagnostics.push({
          file: tsMatch[1],
          line: parseInt(tsMatch[2], 10),
          column: parseInt(tsMatch[3], 10),
          severity: tsMatch[4].toLowerCase() === 'error' ? 'error' : 'warning',
          message: tsMatch[5],
          source: 'tsc',
        });
        continue;
      }

      // ESLint
      const eslintMatch = trimmed.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)\s+\S+$/);
      if (eslintMatch) {
        diagnostics.push({
          file: eslintMatch[1],
          line: parseInt(eslintMatch[2], 10),
          column: parseInt(eslintMatch[3], 10),
          severity: eslintMatch[4].toLowerCase() === 'error' ? 'error' : 'warning',
          message: eslintMatch[5],
          source: 'eslint',
        });
        continue;
      }

      // Jest failure
      const jestMatch = trimmed.match(/FAIL\s+(.+)/);
      if (jestMatch) {
        diagnostics.push({
          file: jestMatch[1],
          severity: 'error',
          message: 'Test suite failed',
          source: 'jest',
        });
        continue;
      }

      // Cargo error
      const cargoMatch = trimmed.match(/^error\[(E\d+)\]:\s*(.+)$/);
      if (cargoMatch) {
        diagnostics.push({
          severity: 'error',
          message: `${cargoMatch[1]}: ${cargoMatch[2]}`,
          source: 'cargo',
        });
        continue;
      }

      // Cargo location line
      const cargoLocMatch = trimmed.match(/^\s*-->\s*(.+?):(\d+):(\d+)$/);
      if (cargoLocMatch && diagnostics.length > 0 && diagnostics[diagnostics.length - 1].source === 'cargo' && !diagnostics[diagnostics.length - 1].file) {
        diagnostics[diagnostics.length - 1].file = cargoLocMatch[1];
        diagnostics[diagnostics.length - 1].line = parseInt(cargoLocMatch[2], 10);
        diagnostics[diagnostics.length - 1].column = parseInt(cargoLocMatch[3], 10);
        continue;
      }

      // Go error
      const goMatch = trimmed.match(/^(.+\.go):(\d+):(\d+):\s*(.+)$/);
      if (goMatch) {
        diagnostics.push({
          file: goMatch[1],
          line: parseInt(goMatch[2], 10),
          column: parseInt(goMatch[3], 10),
          severity: 'error',
          message: goMatch[4],
          source: 'go',
        });
        continue;
      }

      // Python pytest failure
      const pytestMatch = trimmed.match(/^FAILED\s+(.+?)::/);
      if (pytestMatch) {
        diagnostics.push({
          file: pytestMatch[1],
          severity: 'error',
          message: 'Test failed',
          source: 'pytest',
        });
        continue;
      }

      // Python traceback
      const pyTraceMatch = trimmed.match(/^\s*File\s+"(.+?)",\s*line\s*(\d+),\s*in\s*.+$/);
      if (pyTraceMatch) {
        diagnostics.push({
          file: pyTraceMatch[1],
          line: parseInt(pyTraceMatch[2], 10),
          severity: 'error',
          message: 'Python exception',
          source: 'python',
        });
        continue;
      }
    }

    return diagnostics;
  }

  private skippedResult(type: VerificationResult['type'], reason: string): VerificationResult {
    return {
      type,
      command: '',
      exitCode: 0,
      durationMs: 0,
      stdout: '',
      stderr: reason,
      diagnostics: [],
      passed: true,
      skipped: true,
    };
  }

  private async fileExists(fileName: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(this.projectRoot), fileName);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveProjectRoot(): Promise<string> {
    if (!this.workspaceRoot) return '';

    const activeFile = vscode.window.activeTextEditor?.document.uri;
    if (activeFile?.scheme === 'file') {
      const containingRoot = await this.findNearestProjectRoot(activeFile);
      if (containingRoot) return containingRoot;
    }

    const workspaceUri = vscode.Uri.file(this.workspaceRoot);
    if (await this.hasProjectMarker(workspaceUri)) {
      return this.workspaceRoot;
    }

    const commonNestedRoots = [
      'extensions/coding-agent',
      'frontend',
      'backend',
      'app',
      'server',
      'client',
      'packages/app',
    ];

    for (const rel of commonNestedRoots) {
      const candidate = vscode.Uri.joinPath(workspaceUri, ...rel.split('/'));
      if (await this.hasProjectMarker(candidate)) {
        return candidate.fsPath;
      }
    }

    return this.workspaceRoot;
  }

  private async findNearestProjectRoot(fileUri: vscode.Uri): Promise<string | undefined> {
    let current = vscode.Uri.joinPath(fileUri, '..');
    const workspacePath = this.workspaceRoot.replace(/\\/g, '/').toLowerCase();

    while (current.fsPath.replace(/\\/g, '/').toLowerCase().startsWith(workspacePath)) {
      if (await this.hasProjectMarker(current)) {
        return current.fsPath;
      }
      const parent = vscode.Uri.joinPath(current, '..');
      if (parent.fsPath === current.fsPath) break;
      current = parent;
    }

    return undefined;
  }

  private async hasProjectMarker(root: vscode.Uri): Promise<boolean> {
    const markers = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'requirements.txt'];
    for (const marker of markers) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, marker));
        return true;
      } catch {
        // keep checking
      }
    }
    return false;
  }

  private shortenPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return parts.join('/');
    return parts.slice(-3).join('/');
  }
}
