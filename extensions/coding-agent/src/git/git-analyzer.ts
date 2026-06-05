import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
  refs?: string;
}

export interface FileHistoryEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface BlameLine {
  line: number;
  content: string;
  commitHash: string;
  author: string;
  date: string;
  summary: string;
}

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  additions: number;
  deletions: number;
  patch: string;
}

export interface GitDiff {
  fromRef?: string;
  toRef?: string;
  files: GitDiffFile[];
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'unknown';
  additions: number;
  deletions: number;
}

/**
 * GitAnalyzer provides repository history awareness via raw git commands.
 * Safe to use when workspace is not a git repo — all methods return empty results.
 */
export class GitAnalyzer {
  private repoRoot: string | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.initialized = false;
      return;
    }

    try {
      const { stdout } = await execAsync('git rev-parse --show-toplevel', {
        cwd: workspaceFolder.uri.fsPath,
        timeout: 5000,
      });
      this.repoRoot = stdout.trim();
      this.initialized = true;
      console.log(`[GitAnalyzer] Initialized at ${this.repoRoot}`);
    } catch {
      this.initialized = false;
      console.log('[GitAnalyzer] Not a git repository');
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  private async execGit(args: string): Promise<string> {
    if (!this.repoRoot) {
      throw new Error('Git analyzer not initialized');
    }
    const { stdout } = await execAsync(`git ${args}`, {
      cwd: this.repoRoot,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
    });
    return stdout;
  }

  /** Parse a null-separated pretty format into CommitInfo objects. */
  private parseCommits(raw: string): CommitInfo[] {
    const commits: CommitInfo[] = [];
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      const parts = line.split('\0');
      if (parts.length >= 4) {
        commits.push({
          hash: parts[0],
          message: parts[1],
          author: parts[2],
          date: parts[3],
          refs: parts[4] || undefined,
        });
      }
    }
    return commits;
  }

  /** Get recent commits. Returns empty array if not a git repo. */
  async getRecentCommits(limit: number = 10): Promise<CommitInfo[]> {
    if (!this.initialized) return [];
    try {
      const raw = await this.execGit(
        `log --pretty=format:"%H%x00%s%x00%an%x00%ad%x00%d" --date=iso -n ${limit}`
      );
      return this.parseCommits(raw);
    } catch (err) {
      console.error('[GitAnalyzer] getRecentCommits failed:', err);
      return [];
    }
  }

  /** Get commit history for a specific file. */
  async getFileHistory(file: string, limit: number = 20): Promise<FileHistoryEntry[]> {
    if (!this.initialized) return [];
    try {
      const raw = await this.execGit(
        `log --pretty=format:"%H%x00%s%x00%an%x00%ad%x00" --date=iso --follow -n ${limit} -- "${file}"`
      );
      return this.parseCommits(raw).map(c => ({
        hash: c.hash,
        message: c.message,
        author: c.author,
        date: c.date,
      }));
    } catch (err) {
      console.error('[GitAnalyzer] getFileHistory failed:', err);
      return [];
    }
  }

  /** Get diff of working tree against HEAD. */
  async getWorkingTreeDiff(): Promise<GitDiff> {
    if (!this.initialized) return { files: [] };
    try {
      const patch = await this.execGit('diff HEAD --no-color');
      return this.parseDiff(patch);
    } catch (err) {
      console.error('[GitAnalyzer] getWorkingTreeDiff failed:', err);
      return { files: [] };
    }
  }

  /** Get diff between two refs (commit hashes, branches, tags). */
  async getDiffBetween(from: string, to: string): Promise<GitDiff> {
    if (!this.initialized) return { fromRef: from, toRef: to, files: [] };
    try {
      const patch = await this.execGit(`diff ${from} ${to} --no-color`);
      return this.parseDiff(patch, from, to);
    } catch (err) {
      console.error('[GitAnalyzer] getDiffBetween failed:', err);
      return { fromRef: from, toRef: to, files: [] };
    }
  }

  /**
   * Get blame information for a file.
   * If line is provided, returns only that line. Otherwise returns all lines.
   */
  async getBlame(file: string, line?: number): Promise<BlameLine[]> {
    if (!this.initialized) return [];
    try {
      const rangeArg = line !== undefined ? `-L ${line},${line}` : '';
      const raw = await this.execGit(`blame --line-porcelain ${rangeArg} -- "${file}"`);
      return this.parseBlame(raw);
    } catch (err) {
      console.error('[GitAnalyzer] getBlame failed:', err);
      return [];
    }
  }

  /** Get list of files changed in working tree (staged + unstaged). */
  async getChangedFiles(): Promise<ChangedFile[]> {
    if (!this.initialized) return [];
    try {
      // staged changes
      const stagedRaw = await this.execGit('diff --cached --numstat --no-color');
      const stagedFiles = this.parseNumstat(stagedRaw, 'staged');

      // unstaged changes
      const unstagedRaw = await this.execGit('diff --numstat --no-color');
      const unstagedFiles = this.parseNumstat(unstagedRaw, 'unstaged');

      // untracked files
      const untrackedRaw = await this.execGit('ls-files --others --exclude-standard');
      const untrackedFiles: ChangedFile[] = untrackedRaw
        .split('\n')
        .filter(p => p.trim().length > 0)
        .map(p => ({ path: p.trim(), status: 'untracked', additions: 0, deletions: 0 }));

      // Merge and deduplicate: unstaged overrides staged for same path
      const map = new Map<string, ChangedFile>();
      for (const f of stagedFiles) map.set(f.path, f);
      for (const f of unstagedFiles) map.set(f.path, f);
      for (const f of untrackedFiles) if (!map.has(f.path)) map.set(f.path, f);

      return Array.from(map.values());
    } catch (err) {
      console.error('[GitAnalyzer] getChangedFiles failed:', err);
      return [];
    }
  }

  /** Format a CommitInfo array into a concise string for LLM prompts. */
  formatCommitsForPrompt(commits: CommitInfo[]): string {
    if (commits.length === 0) return '(no commit history available)';
    return commits
      .map((c, i) => `${i + 1}. \`${c.hash.slice(0, 7)}\` ${c.message} — ${c.author} (${c.date})`)
      .join('\n');
  }

  /** Format a GitDiff into a concise string for LLM prompts. */
  formatDiffForPrompt(diff: GitDiff, maxLines: number = 200): string {
    if (diff.files.length === 0) return '(no changes)';
    const lines: string[] = [];
    if (diff.fromRef && diff.toRef) {
      lines.push(`Diff: ${diff.fromRef} → ${diff.toRef}`);
    } else {
      lines.push('Working tree changes:');
    }

    for (const f of diff.files) {
      lines.push(`\n${f.status.toUpperCase()} ${f.path}${f.oldPath && f.oldPath !== f.path ? ` (from ${f.oldPath})` : ''} (+${f.additions}/-${f.deletions})`);
      const patchLines = f.patch.split('\n');
      if (patchLines.length > maxLines) {
        lines.push(...patchLines.slice(0, maxLines));
        lines.push(`... (${patchLines.length - maxLines} more lines)`);
      } else {
        lines.push(...patchLines);
      }
    }
    return lines.join('\n');
  }

  /** Parse `git diff` output into structured GitDiff. */
  private parseDiff(raw: string, fromRef?: string, toRef?: string): GitDiff {
    const files: GitDiffFile[] = [];
    const lines = raw.split('\n');
    let currentFile: GitDiffFile | null = null;
    let patchLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (currentFile) {
          currentFile.patch = patchLines.join('\n');
          files.push(currentFile);
        }
        currentFile = {
          path: '',
          status: 'unknown',
          additions: 0,
          deletions: 0,
          patch: '',
        };
        patchLines = [];
      } else if (line.startsWith('--- ')) {
        const oldPath = line.slice(4).replace(/^a\//, '');
        if (currentFile && oldPath !== '/dev/null') {
          currentFile.oldPath = oldPath;
        }
      } else if (line.startsWith('+++ ')) {
        const newPath = line.slice(4).replace(/^b\//, '');
        if (currentFile) {
          currentFile.path = newPath === '/dev/null' ? (currentFile.oldPath || '') : newPath;
        }
      } else if (line.startsWith('new file mode')) {
        if (currentFile) currentFile.status = 'added';
      } else if (line.startsWith('deleted file mode')) {
        if (currentFile) currentFile.status = 'deleted';
      } else if (line.startsWith('rename from')) {
        if (currentFile) {
          currentFile.status = 'renamed';
          currentFile.oldPath = line.slice(12);
        }
      } else if (line.startsWith('rename to')) {
        if (currentFile) currentFile.path = line.slice(10);
      } else if (line.startsWith('+')) {
        if (currentFile) currentFile.additions++;
        patchLines.push(line);
      } else if (line.startsWith('-')) {
        if (currentFile) currentFile.deletions++;
        patchLines.push(line);
      } else {
        patchLines.push(line);
      }
    }

    if (currentFile) {
      currentFile.patch = patchLines.join('\n');
      if (currentFile.status === 'unknown' && currentFile.additions > 0 && currentFile.deletions > 0) {
        currentFile.status = 'modified';
      }
      files.push(currentFile);
    }

    return { fromRef, toRef, files };
  }

  /** Parse `git blame --line-porcelain` output. */
  private parseBlame(raw: string): BlameLine[] {
    const lines: BlameLine[] = [];
    const blocks = raw.split('\n\t');
    let currentLine = 1;

    for (const block of blocks) {
      const parts = block.split('\n');
      if (parts.length < 2) continue;

      const hash = parts[0].split(' ')[0];
      let author = '';
      let date = '';
      let summary = '';
      let content = '';

      for (const p of parts) {
        if (p.startsWith('author ')) author = p.slice(7);
        if (p.startsWith('author-time ')) {
          const ts = parseInt(p.slice(12), 10);
          date = new Date(ts * 1000).toISOString();
        }
        if (p.startsWith('summary ')) summary = p.slice(8);
        if (p.startsWith('\t')) content = p.slice(1);
      }

      if (content) {
        lines.push({
          line: currentLine,
          content,
          commitHash: hash,
          author,
          date,
          summary,
        });
        currentLine++;
      }
    }

    return lines;
  }

  /** Parse `git diff --numstat` output. */
  private parseNumstat(raw: string, _source: 'staged' | 'unstaged'): ChangedFile[] {
    const files: ChangedFile[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length < 3) continue;
      const additions = parseInt(parts[0], 10) || 0;
      const deletions = parseInt(parts[1], 10) || 0;
      const path = parts[2];
      files.push({ path, status: 'modified', additions, deletions });
    }
    return files;
  }
}
