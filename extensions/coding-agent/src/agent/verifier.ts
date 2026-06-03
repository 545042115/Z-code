import * as vscode from 'vscode';
import { exec } from 'child_process';

export interface TypeCheckResult {
  passed: boolean;
  skipped: boolean;
  errors: string[];
  exitCode: number;
}

export interface LintResult {
  passed: boolean;
  skipped: boolean;
  errors: string[];
  warnings: string[];
  exitCode: number;
}

export interface TestResult {
  passed: boolean;
  skipped: boolean;
  output: string;
  exitCode: number;
}

export interface VerifierOutput {
  typeCheck: TypeCheckResult | null;
  lint: LintResult | null;
  test: TestResult | null;
  summary: string;
  hasIssues: boolean;
}

export class Verifier {
  private workspaceRoot: string;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  }

  /**
   * 检查是否有任何验证工具可用。
   */
  async isAvailable(): Promise<boolean> {
    const [hasTsc, hasEslint, hasTestScript] = await Promise.all([
      this.hasFile('tsconfig.json'),
      this.hasLintConfig(),
      this.hasTestScript(),
    ]);
    return hasTsc || hasEslint || hasTestScript;
  }

  async verify(): Promise<VerifierOutput> {
    const [hasTsc, hasEslint, hasTestScript] = await Promise.all([
      this.hasFile('tsconfig.json'),
      this.hasLintConfig(),
      this.hasTestScript(),
    ]);

    // 没有任何验证工具可用时，返回空结果，避免输出噪音
    if (!hasTsc && !hasEslint && !hasTestScript) {
      return {
        typeCheck: null,
        lint: null,
        test: null,
        summary: '',
        hasIssues: false,
      };
    }

    const [typeCheck, lint, test] = await Promise.all([
      hasTsc ? this.runTypeCheck() : Promise.resolve(null),
      hasEslint ? this.runLint() : Promise.resolve(null),
      hasTestScript ? this.runTests() : Promise.resolve(null),
    ]);

    const issues: string[] = [];
    if (typeCheck && !typeCheck.passed && !typeCheck.skipped) {
      issues.push(`TypeScript: ${typeCheck.errors.length} error(s)`);
    }
    if (lint && !lint.passed && !lint.skipped) {
      issues.push(`ESLint: ${lint.errors.length} error(s), ${lint.warnings.length} warning(s)`);
    }
    if (test && !test.passed && !test.skipped) {
      issues.push(`Tests: failed (exit code ${test.exitCode})`);
    }

    const summaryLines: string[] = [];
    if (typeCheck) {
      if (typeCheck.skipped) {
        summaryLines.push('TypeScript: ⏭️ skipped (tool not available)');
      } else {
        summaryLines.push(`TypeScript: ${typeCheck.passed ? '✅ passed' : `❌ failed (${typeCheck.errors.length} errors)`}`);
      }
    }
    if (lint) {
      if (lint.skipped) {
        summaryLines.push('ESLint: ⏭️ skipped (tool not available)');
      } else {
        summaryLines.push(`ESLint: ${lint.passed ? '✅ passed' : `❌ failed (${lint.errors.length} errors, ${lint.warnings.length} warnings)`}`);
      }
    }
    if (test) {
      if (test.skipped) {
        summaryLines.push('Tests: ⏭️ skipped (tool not available)');
      } else {
        summaryLines.push(`Tests: ${test.passed ? '✅ passed' : '❌ failed'}`);
      }
    }

    const detailParts: string[] = [];
    if (typeCheck && !typeCheck.passed) {
      detailParts.push(`\nTypeScript errors:\n${typeCheck.errors.slice(0, 10).join('\n')}`);
    }
    if (lint && !lint.passed) {
      detailParts.push(`\nESLint errors:\n${lint.errors.slice(0, 10).join('\n')}`);
      if (lint.warnings.length > 0) {
        detailParts.push(`\nESLint warnings:\n${lint.warnings.slice(0, 10).join('\n')}`);
      }
    }
    if (test && !test.passed) {
      detailParts.push(`\nTest output:\n${test.output.substring(0, 1000)}`);
    }

    const summary = summaryLines.join('\n') + detailParts.join('');

    return {
      typeCheck,
      lint,
      test,
      summary,
      hasIssues: issues.length > 0,
    };
  }

  private async hasFile(fileName: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRoot), fileName);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async hasLintConfig(): Promise<boolean> {
    const configFiles = [
      '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.yaml', '.eslintrc.yml',
      'eslint.config.js', 'eslint.config.mjs',
    ];
    for (const file of configFiles) {
      if (await this.hasFile(file)) return true;
    }
    return false;
  }

  private async hasTestScript(): Promise<boolean> {
    try {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRoot), 'package.json');
      const content = await vscode.workspace.fs.readFile(uri);
      const pkg = JSON.parse(new TextDecoder().decode(content));
      return !!(pkg.scripts && pkg.scripts.test);
    } catch {
      return false;
    }
  }

  private parseStructuredErrors(output: string): { file: string; line: number; column: number; message: string }[] {
    const structured: { file: string; line: number; column: number; message: string }[] = [];
    const pattern = /^(.+?)\((\d+),(\d+)\):\s*(error\s+TS\d+:\s*.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      structured.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: match[4],
      });
    }
    return structured;
  }

  private runCommand(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      exec(cmd, { cwd: this.workspaceRoot, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          exitCode: err ? (err.code || 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
    });
  }

  private async checkCommandExists(command: string): Promise<boolean> {
    try {
      const result = await this.runCommand(`where ${command} 2>nul || which ${command} 2>/dev/null`);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async runTypeCheck(): Promise<TypeCheckResult> {
    if (!(await this.checkCommandExists('npx'))) {
      return { passed: true, skipped: true, errors: [], exitCode: 0 };
    }
    const result = await this.runCommand('npx tsc --noEmit 2>&1');
    const combinedOutput = result.stdout + result.stderr;
    const errors = combinedOutput.split('\n').filter(l => /error TS\d+/.test(l));
    const structuredErrors = this.parseStructuredErrors(combinedOutput);
    return {
      passed: result.exitCode === 0,
      skipped: false,
      errors: structuredErrors.length > 0 
        ? structuredErrors.slice(0, 20).map(e => `${e.file}(${e.line},${e.column}): ${e.message}`)
        : (errors.length > 0 ? errors.slice(0, 20) : (result.exitCode !== 0 ? [combinedOutput.substring(0, 500)] : [])),
      exitCode: result.exitCode,
    };
  }

  private async runLint(): Promise<LintResult> {
    if (!(await this.checkCommandExists('npx'))) {
      return { passed: true, skipped: true, errors: [], warnings: [], exitCode: 0 };
    }
    const result = await this.runCommand('npx eslint . 2>&1');
    const lines = result.stdout ? result.stdout.split('\n').filter(l => l.trim()) : [];
    const errors = lines.filter(l => l.includes('error'));
    const warnings = lines.filter(l => l.includes('warning'));
    return {
      passed: result.exitCode === 0,
      skipped: false,
      errors: errors.slice(0, 20),
      warnings: warnings.slice(0, 20),
      exitCode: result.exitCode,
    };
  }

  private async runTests(): Promise<TestResult> {
    if (!(await this.checkCommandExists('npm'))) {
      return { passed: true, skipped: true, output: '', exitCode: 0 };
    }
    const result = await this.runCommand('npm test 2>&1');
    const output = result.stdout || result.stderr;
    return {
      passed: result.exitCode === 0,
      skipped: false,
      output: output.substring(0, 2000),
      exitCode: result.exitCode,
    };
  }
}