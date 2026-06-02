import * as vscode from 'vscode';
import { exec } from 'child_process';

export interface TypeCheckResult {
  passed: boolean;
  errors: string[];
  exitCode: number;
}

export interface LintResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  exitCode: number;
}

export interface TestResult {
  passed: boolean;
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

  async verify(): Promise<VerifierOutput> {
    const [hasTsc, hasEslint, hasTestScript] = await Promise.all([
      this.hasFile('tsconfig.json'),
      this.hasLintConfig(),
      this.hasTestScript(),
    ]);

    const [typeCheck, lint, test] = await Promise.all([
      hasTsc ? this.runTypeCheck() : Promise.resolve(null),
      hasEslint ? this.runLint() : Promise.resolve(null),
      hasTestScript ? this.runTests() : Promise.resolve(null),
    ]);

    const issues: string[] = [];
    if (typeCheck && !typeCheck.passed) {
      issues.push(`TypeScript: ${typeCheck.errors.length} error(s)`);
    }
    if (lint && !lint.passed) {
      issues.push(`ESLint: ${lint.errors.length} error(s), ${lint.warnings.length} warning(s)`);
    }
    if (test && !test.passed) {
      issues.push(`Tests: failed (exit code ${test.exitCode})`);
    }

    const summaryLines: string[] = [];
    if (typeCheck) {
      summaryLines.push(`TypeScript: ${typeCheck.passed ? '✅ passed' : `❌ failed (${typeCheck.errors.length} errors)`}`);
    } else {
      summaryLines.push('TypeScript: ⏭️ skipped (no tsconfig.json)');
    }
    if (lint) {
      summaryLines.push(`ESLint: ${lint.passed ? '✅ passed' : `❌ failed (${lint.errors.length} errors, ${lint.warnings.length} warnings)`}`);
    } else {
      summaryLines.push('ESLint: ⏭️ skipped (no config found)');
    }
    if (test) {
      summaryLines.push(`Tests: ${test.passed ? '✅ passed' : '❌ failed'}`);
    } else {
      summaryLines.push('Tests: ⏭️ skipped (no test script)');
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

  private async runTypeCheck(): Promise<TypeCheckResult> {
    const result = await this.runCommand('npx tsc --noEmit 2>&1');
    const combinedOutput = result.stdout + result.stderr;
    const errors = combinedOutput.split('\n').filter(l => l.includes('error(') || l.includes('TS') || l.includes('error TS'));
    return {
      passed: result.exitCode === 0,
      errors: errors.length > 0 ? errors.slice(0, 20) : (result.exitCode !== 0 ? [combinedOutput.substring(0, 200)] : []),
      exitCode: result.exitCode,
    };
  }

  private async runLint(): Promise<LintResult> {
    const result = await this.runCommand('npx eslint . 2>&1');
    const lines = result.stdout ? result.stdout.split('\n').filter(l => l.trim()) : [];
    const errors = lines.filter(l => l.includes('error'));
    const warnings = lines.filter(l => l.includes('warning'));
    return {
      passed: result.exitCode === 0,
      errors: errors.slice(0, 20),
      warnings: warnings.slice(0, 20),
      exitCode: result.exitCode,
    };
  }

  private async runTests(): Promise<TestResult> {
    const result = await this.runCommand('npm test 2>&1');
    const output = result.stdout || result.stderr;
    return {
      passed: result.exitCode === 0,
      output: output.substring(0, 2000),
      exitCode: result.exitCode,
    };
  }
}