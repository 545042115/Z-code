import * as vscode from 'vscode';

export interface WorkspaceFile {
  path: string;
  extension: string;
  size: number;
  lastModified: number;
}

export interface WorkspaceInfo {
  rootPath: string;
  files: WorkspaceFile[];
  directories: string[];
  fileCount: number;
  totalSize: number;
  extensions: string[];
}

export type FileChangeHandler = (uri: vscode.Uri) => void;

export class WorkspaceScanner {
  private files: WorkspaceFile[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private onChangeHandlers: FileChangeHandler[] = [];

  readonly SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c',
    '.h', '.hpp', '.cs', '.swift', '.kt', '.scala', '.rb', '.php', '.vue',
    '.svelte', '.astro', '.mjs', '.cjs', '.mts', '.cts', '.d.ts',
  ]);

  getFiles(): WorkspaceFile[] {
    return this.files;
  }

  onFileChange(handler: FileChangeHandler): void {
    this.onChangeHandlers.push(handler);
  }

  async scan(): Promise<WorkspaceInfo> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    const dirs = new Set<string>();
    const scanned: WorkspaceFile[] = [];

    for (const folder of vscode.workspace.workspaceFolders || []) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/__pycache__/**}'
      );

      for (const uri of uris) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const ext = uri.fsPath.substring(uri.fsPath.lastIndexOf('.'));
          dirs.add(uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/') || uri.fsPath.lastIndexOf('\\')));
          scanned.push({
            path: uri.fsPath,
            extension: ext,
            size: stat.size,
            lastModified: stat.mtime,
          });
        } catch {
          continue;
        }
      }
    }

    this.files = scanned;

    return {
      rootPath,
      files: scanned,
      directories: Array.from(dirs).sort(),
      fileCount: scanned.length,
      totalSize: scanned.reduce((sum, f) => sum + f.size, 0),
      extensions: Array.from(new Set(scanned.map(f => f.extension))).sort(),
    };
  }

  watch(): vscode.Disposable {
    if (this.watcher) {
      this.watcher.dispose();
    }

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const onEvent = async (uri: vscode.Uri) => {
      const ext = uri.fsPath.substring(uri.fsPath.lastIndexOf('.'));
      if (!this.SOURCE_EXTENSIONS.has(ext)) return;

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const existing = this.files.findIndex(f => f.path === uri.fsPath);
        const entry: WorkspaceFile = {
          path: uri.fsPath,
          extension: ext,
          size: stat.size,
          lastModified: stat.mtime,
        };
        if (existing >= 0) {
          this.files[existing] = entry;
        } else {
          this.files.push(entry);
        }
        this.onChangeHandlers.forEach(h => h(uri));
      } catch {
        this.files = this.files.filter(f => f.path !== uri.fsPath);
      }
    };

    const disposable = vscode.Disposable.from(
      this.watcher.onDidCreate(onEvent),
      this.watcher.onDidChange(onEvent),
      this.watcher.onDidDelete((uri) => {
        this.files = this.files.filter(f => f.path !== uri.fsPath);
        this.onChangeHandlers.forEach(h => h(uri));
      })
    );

    return disposable;
  }

  getSourceFiles(): WorkspaceFile[] {
    return this.files.filter(f => this.SOURCE_EXTENSIONS.has(f.extension));
  }

  getFilesInDirectory(dirPath: string): WorkspaceFile[] {
    const normalized = dirPath.replace(/\\/g, '/');
    return this.files.filter(f =>
      f.path.replace(/\\/g, '/').startsWith(normalized)
    );
  }

  getRecentlyModified(limit: number = 20): WorkspaceFile[] {
    return [...this.files]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit);
  }
}