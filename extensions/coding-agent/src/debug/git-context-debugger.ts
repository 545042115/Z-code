import * as vscode from 'vscode';
import { ContextManager } from '../context/context-manager';

export class GitContextDebugger {
  constructor(private readonly contextManager: ContextManager) {}

  async runDebug(): Promise<void> {
    if (!this.contextManager.isInitialized()) {
      vscode.window.showWarningMessage('Coding Agent is still initializing. Please wait.');
      return;
    }

    const query = await vscode.window.showInputBox({
      prompt: 'Enter a query to debug Git context collection',
      placeHolder: 'e.g., what changed after the refactor?',
    });

    if (!query) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Debugging Git context for: ${query}`,
        cancellable: false,
      },
      async () => {
        const report = await this.buildDebugReport(query);
        const doc = await vscode.workspace.openTextDocument({
          content: report,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    );
  }

  private async buildDebugReport(query: string): Promise<string> {
    const lines: string[] = [];
    const startTime = Date.now();

    // 1. Detect intent
    const intent = this.detectGitIntent(query);
    lines.push(`# Git Context Debug Report`);
    lines.push('');
    lines.push(`**Query:** ${query}`);
    lines.push(`**Git intent detected:** ${intent ? 'YES' : 'NO'}`);
    lines.push('');

    if (!intent) {
      lines.push('*No git-related intent detected. No git context will be collected.*');
      return lines.join('\n');
    }

    const git = this.contextManager.gitAnalyzer;
    if (!git.isInitialized) {
      lines.push('*Git analyzer is not initialized (not a git repository).*');
      return lines.join('\n');
    }

    // 2. Recent commits
    lines.push('## 1. Recent Commits');
    lines.push('');
    const commitsStart = Date.now();
    const commits = await git.getRecentCommits(10);
    lines.push(`*Latency: ${Date.now() - commitsStart}ms*`);
    lines.push('');
    if (commits.length === 0) {
      lines.push('No commits found.');
    } else {
      for (const c of commits) {
        lines.push(`- \`${c.hash.slice(0, 7)}\` ${c.message} — ${c.author} (${c.date})`);
      }
    }
    lines.push('');

    // 3. Changed files
    lines.push('## 2. Changed Files (Working Tree)');
    lines.push('');
    const changedStart = Date.now();
    const changedFiles = await git.getChangedFiles();
    lines.push(`*Latency: ${Date.now() - changedStart}ms*`);
    lines.push('');
    if (changedFiles.length === 0) {
      lines.push('No changes in working tree.');
    } else {
      for (const f of changedFiles) {
        lines.push(`- ${f.status.toUpperCase()}: ${f.path} (+${f.additions}/-${f.deletions})`);
      }
    }
    lines.push('');

    // 4. File histories for selected files
    lines.push('## 3. File Histories');
    lines.push('');
    const pkg = await this.contextManager.contextBuilder.build(query);
    const selectedFiles = pkg.selectedFiles.slice(0, 3);
    lines.push(`*Selected files for history lookup:* ${selectedFiles.join(', ') || 'none'}`);
    lines.push('');
    const histStart = Date.now();
    for (const file of selectedFiles) {
      const history = await git.getFileHistory(file, 5);
      if (history.length > 0) {
        lines.push(`### ${file}`);
        for (const h of history) {
          lines.push(`- \`${h.hash.slice(0, 7)}\` ${h.message} — ${h.author} (${h.date})`);
        }
        lines.push('');
      }
    }
    lines.push(`*Latency: ${Date.now() - histStart}ms*`);
    lines.push('');

    // 5. Recent diff
    lines.push('## 4. Recent Diff (HEAD~5..HEAD)');
    lines.push('');
    const diffStart = Date.now();
    const diff = await git.getDiffBetween('HEAD~5', 'HEAD');
    lines.push(`*Latency: ${Date.now() - diffStart}ms*`);
    lines.push('');
    if (diff.files.length === 0) {
      lines.push('No changes found.');
    } else {
      lines.push(`*Files changed: ${diff.files.length}*`);
      for (const f of diff.files.slice(0, 5)) {
        lines.push(`- ${f.status.toUpperCase()}: ${f.path} (+${f.additions}/-${f.deletions})`);
      }
      lines.push('');
      const formatted = git.formatDiffForPrompt(diff, 80);
      lines.push('```diff');
      lines.push(formatted);
      lines.push('```');
    }
    lines.push('');

    // 6. Final git context package
    lines.push('## 5. Final Git Context Package');
    lines.push('');
    const pkgStart = Date.now();
    const gitContextParts: string[] = [];
    if (commits.length > 0) {
      gitContextParts.push('## Recent Commits\n' + git.formatCommitsForPrompt(commits));
    }
    if (changedFiles.length > 0) {
      gitContextParts.push('## Changed Files in Working Tree\n' + changedFiles.map(f => `${f.status.toUpperCase()}: ${f.path} (+${f.additions}/-${f.deletions})`).join('\n'));
    }
    const historyParts: string[] = [];
    for (const file of selectedFiles) {
      const history = await git.getFileHistory(file, 5);
      if (history.length > 0) {
        historyParts.push(`### ${file}\n` + history.map(h => `  ${h.hash.slice(0, 7)} ${h.message} — ${h.author} (${h.date})`).join('\n'));
      }
    }
    if (historyParts.length > 0) {
      gitContextParts.push('## File Histories\n' + historyParts.join('\n\n'));
    }
    if (diff.files.length > 0) {
      gitContextParts.push('## Recent Changes (HEAD~5..HEAD)\n' + git.formatDiffForPrompt(diff, 50));
    }
    const finalGitContext = gitContextParts.join('\n\n');
    lines.push(`*Latency: ${Date.now() - pkgStart}ms*`);
    lines.push('');
    lines.push('```');
    lines.push(finalGitContext || '(empty)');
    lines.push('```');
    lines.push('');

    lines.push(`**Total debug time: ${Date.now() - startTime}ms**`);
    return lines.join('\n');
  }

  private detectGitIntent(request: string): boolean {
    const lower = request.toLowerCase();
    const gitKeywords = [
      'regression', 'recently broken', 'commit', 'history', 'changed',
      'after refactor', 'introduced bug', 'blame', 'who changed',
      'recent change', 'what changed', 'last modified', 'git log',
      'who wrote', 'who removed', 'when was',
    ];
    return gitKeywords.some(kw => lower.includes(kw));
  }
}
