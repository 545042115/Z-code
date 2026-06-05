import * as vscode from 'vscode';
import { ContextManager } from '../context/context-manager';

export class VerificationDebugger {
  constructor(private readonly contextManager: ContextManager) {}

  async runDebug(): Promise<void> {
    if (!this.contextManager.isInitialized()) {
      vscode.window.showWarningMessage('Coding Agent is still initializing. Please wait.');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running verification debug...',
        cancellable: false,
      },
      async () => {
        const report = await this.buildDebugReport();
        const doc = await vscode.workspace.openTextDocument({
          content: report,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    );
  }

  private async buildDebugReport(): Promise<string> {
    const lines: string[] = [];
    const verifier = this.contextManager.runtimeVerifier;

    lines.push('# Verification Debug Report');
    lines.push('');

    if (!verifier.isInitialized) {
      lines.push('*Runtime verifier is not initialized.*');
      return lines.join('\n');
    }

    const config = verifier.projectConfig;
    lines.push(`**Detected project type:** ${config?.type || 'unknown'}`);
    lines.push(`**Build command:** ${config?.buildCommand || '(none)'}`);
    lines.push(`**Test command:** ${config?.testCommand || '(none)'}`);
    lines.push(`**Lint command:** ${config?.lintCommand || '(none)'}`);
    lines.push('');

    // Build
    lines.push('## 1. Build Verification');
    lines.push('');
    const buildResult = await verifier.verifyBuild();
    lines.push(`- **Command:** \`${buildResult.command || 'N/A'}\``);
    lines.push(`- **Exit code:** ${buildResult.exitCode}`);
    lines.push(`- **Duration:** ${buildResult.durationMs}ms`);
    lines.push(`- **Status:** ${buildResult.skipped ? '⏭️ skipped' : buildResult.passed ? '✅ passed' : '❌ failed'}`);
    lines.push('');
    if (buildResult.diagnostics.length > 0) {
      lines.push('### Diagnostics');
      for (const d of buildResult.diagnostics) {
        const loc = d.file ? `${d.file}:${d.line || 0}:${d.column || 0}` : 'global';
        lines.push(`- [${d.severity.toUpperCase()}] ${loc} — ${d.message}`);
      }
      lines.push('');
    }
    if (!buildResult.skipped && buildResult.stdout) {
      lines.push('### Output (first 30 lines)');
      lines.push('```');
      lines.push(buildResult.stdout.split('\n').slice(0, 30).join('\n'));
      lines.push('```');
      lines.push('');
    }

    // Tests
    lines.push('## 2. Test Verification');
    lines.push('');
    const testResult = await verifier.verifyTests();
    lines.push(`- **Command:** \`${testResult.command || 'N/A'}\``);
    lines.push(`- **Exit code:** ${testResult.exitCode}`);
    lines.push(`- **Duration:** ${testResult.durationMs}ms`);
    lines.push(`- **Status:** ${testResult.skipped ? '⏭️ skipped' : testResult.passed ? '✅ passed' : '❌ failed'}`);
    lines.push('');
    if (testResult.diagnostics.length > 0) {
      lines.push('### Diagnostics');
      for (const d of testResult.diagnostics) {
        const loc = d.file ? `${d.file}:${d.line || 0}:${d.column || 0}` : 'global';
        lines.push(`- [${d.severity.toUpperCase()}] ${loc} — ${d.message}`);
      }
      lines.push('');
    }
    if (!testResult.skipped && testResult.stdout) {
      lines.push('### Output (first 30 lines)');
      lines.push('```');
      lines.push(testResult.stdout.split('\n').slice(0, 30).join('\n'));
      lines.push('```');
      lines.push('');
    }

    // Lint
    lines.push('## 3. Lint Verification');
    lines.push('');
    const lintResult = await verifier.verifyLint();
    lines.push(`- **Command:** \`${lintResult.command || 'N/A'}\``);
    lines.push(`- **Exit code:** ${lintResult.exitCode}`);
    lines.push(`- **Duration:** ${lintResult.durationMs}ms`);
    lines.push(`- **Status:** ${lintResult.skipped ? '⏭️ skipped' : lintResult.passed ? '✅ passed' : '❌ failed'}`);
    lines.push('');
    if (lintResult.diagnostics.length > 0) {
      lines.push('### Diagnostics');
      for (const d of lintResult.diagnostics) {
        const loc = d.file ? `${d.file}:${d.line || 0}:${d.column || 0}` : 'global';
        lines.push(`- [${d.severity.toUpperCase()}] ${loc} — ${d.message}`);
      }
      lines.push('');
    }
    if (!lintResult.skipped && lintResult.stdout) {
      lines.push('### Output (first 30 lines)');
      lines.push('```');
      lines.push(lintResult.stdout.split('\n').slice(0, 30).join('\n'));
      lines.push('```');
      lines.push('');
    }

    // Patch verification
    lines.push('## 4. Patch Verification (Build + Tests + Lint on failure)');
    lines.push('');
    const patchResults = await verifier.verifyPatch([]);
    lines.push(`*Ran ${patchResults.length} verification steps*`);
    lines.push('');
    for (const r of patchResults) {
      lines.push(`- ${r.type.toUpperCase()}: ${r.skipped ? '⏭️ skipped' : r.passed ? '✅ passed' : '❌ failed'} (\`${r.command || 'N/A'}\`, ${r.durationMs}ms)`);
    }
    lines.push('');

    // Formatted prompt output
    lines.push('## 5. Formatted Prompt Output');
    lines.push('');
    lines.push('```');
    lines.push(verifier.formatResultsForPrompt([buildResult, testResult, lintResult]));
    lines.push('```');

    return lines.join('\n');
  }
}
