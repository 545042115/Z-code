import * as vscode from 'vscode';

export interface WorkspaceFile {
  path: string;
  extension: string;
  size: number;
  lastModified: number;
  /** 该文件所属的工作区根目录路径 */
  workspaceRoot: string;
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
export type FileDeleteHandler = (uri: vscode.Uri) => void;

export class WorkspaceScanner {
  private files: WorkspaceFile[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private onChangeHandlers: FileChangeHandler[] = [];
  private onDeleteHandlers: FileDeleteHandler[] = [];

  readonly SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c',
    '.h', '.hpp', '.cs', '.swift', '.kt', '.scala', '.rb', '.php', '.vue',
    '.svelte', '.astro', '.mjs', '.cjs', '.mts', '.cts', '.d.ts',
  ]);

  private readonly EXCLUDE_DIR_SEGMENTS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
    'Pods', 'Carthage', '.cache', '.gradle', 'target', 'DerivedData',
    '.venv', 'venv', 'env', '.tox', 'vendor', '.cargo', '.rustup',
    'coverage', '.nyc_output', '.parcel-cache', '.turbo',
  ]);

  private isExcludedPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    return segments.some(seg => this.EXCLUDE_DIR_SEGMENTS.has(seg));
  }

  getFiles(): WorkspaceFile[] {
    return this.files.filter(f => !this.isExcludedPath(f.path));
  }

  /**
   * 获取主工作区根目录路径（第一个 workspace folder）。
   * 多工作区场景下，以此作为"当前项目"的根目录。
   */
  getPrimaryWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  }

  /**
   * 获取主工作区的文件（排除依赖目录）。
   * 多工作区场景下，只返回第一个 workspace folder 下的文件，
   * 避免其他工作区的文件污染上下文。
   */
  getPrimaryWorkspaceFiles(): WorkspaceFile[] {
    const primaryRoot = this.getPrimaryWorkspaceRoot();
    if (!primaryRoot) return this.getFiles();
    return this.files.filter(f =>
      !this.isExcludedPath(f.path) &&
      f.path.replace(/\\/g, '/').startsWith(primaryRoot.replace(/\\/g, '/'))
    );
  }

  /**
   * 获取主工作区的源码文件。
   */
  getPrimaryWorkspaceSourceFiles(): WorkspaceFile[] {
    const primaryRoot = this.getPrimaryWorkspaceRoot();
    if (!primaryRoot) return this.getSourceFiles();
    return this.files.filter(f =>
      this.SOURCE_EXTENSIONS.has(f.extension) &&
      !this.isExcludedPath(f.path) &&
      f.path.replace(/\\/g, '/').startsWith(primaryRoot.replace(/\\/g, '/'))
    );
  }

  onFileChange(handler: FileChangeHandler): void {
    this.onChangeHandlers.push(handler);
  }

  onFileDelete(handler: FileDeleteHandler): void {
    this.onDeleteHandlers.push(handler);
  }

  async scan(): Promise<WorkspaceInfo> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    const dirs = new Set<string>();
    const scanned: WorkspaceFile[] = [];

    for (const folder of vscode.workspace.workspaceFolders || []) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/__pycache__/**,**/Pods/**,**/Carthage/**,**/vendor/bundle/**,**/.cache/**,**/.gradle/**,**/target/**,**/DerivedData/**,**/.venv/**,**/venv/**,**/env/**,**/.tox/**}'
      );

      for (const uri of uris) {
        try {
          // 二次过滤：排除依赖目录中的文件（findFiles 的 glob 排除可能不完整）
          if (this.isExcludedPath(uri.fsPath)) continue;

          const stat = await vscode.workspace.fs.stat(uri);
          const ext = uri.fsPath.substring(uri.fsPath.lastIndexOf('.'));
          dirs.add(uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/') || uri.fsPath.lastIndexOf('\\')));
          scanned.push({
            path: uri.fsPath,
            extension: ext,
            size: stat.size,
            lastModified: stat.mtime,
            workspaceRoot: folder.uri.fsPath,
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
          workspaceRoot: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || '',
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
        this.onDeleteHandlers.forEach(h => h(uri));
      })
    );

    return disposable;
  }

  getSourceFiles(): WorkspaceFile[] {
    return this.files.filter(f => this.SOURCE_EXTENSIONS.has(f.extension) && !this.isExcludedPath(f.path));
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