import * as path from 'path';
import * as vscode from 'vscode';
import { AgentCore, AgentState, EditOperation, PlanSnapshot } from '../agent/agent-core';
import { ConfigManager, LLMConfigProfile } from '../config/config-manager';

interface ReviewableEditOperation extends EditOperation {
  status: 'pending' | 'applied' | 'failed' | 'reverted';
  error?: string;
  originalExists?: boolean;
  originalContent?: string;
  modifiedContent?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'error' | 'state' | 'editOps' | 'plan';
  content: string;
  ops?: string[];
  editBatchId?: string;
  editOps?: ReviewableEditOperation[];
  planId?: string;
  planTitle?: string;
  planMode?: 'compact' | 'full';
  planItems?: PlanSnapshot['items'];
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatStorageState {
  sessions: ChatSession[];
  activeSessionId: string | null;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly VIEW_TYPE = 'codingAgent.chat';
  private static readonly STORAGE_KEY = 'codingAgent.chatState';
  private static readonly LEGACY_STORAGE_KEY = 'codingAgent.chatMessages';
  private static readonly DIFF_SCHEME = 'coding-agent-diff';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private isRunning: boolean = false;
  private sessions: ChatSession[] = [];
  private activeSessionId: string | null = null;
  private pendingRestore: boolean = false;
  private readonly diffContents = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentCore,
    private readonly extensionContext: vscode.ExtensionContext
  ) {
    this.loadState();
    this.extensionContext.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(ChatViewProvider.DIFF_SCHEME, {
        provideTextDocumentContent: (uri) => {
          const params = new URLSearchParams(uri.query);
          return this.diffContents.get(params.get('id') || '') ?? '';
        },
      })
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'sendMessage':
            await this.handleSendMessage(message.text);
            break;
          case 'stopAgent':
            this.handleStopAgent();
            break;
          case 'revertEditBatch':
            await this.handleRevertEditBatch(message.batchId);
            break;
          case 'revertEditFile':
            await this.handleRevertEditFile(message.batchId, message.filePath);
            break;
          case 'viewFileEdits':
            await this.handleViewFileEdits(message.batchId, message.filePath);
            break;
          case 'viewSingleEdit':
            await this.handleViewSingleEdit(message.batchId, message.idempotentKey);
            break;
          case 'toggleProfile':
            await this.handleSwitchProfile();
            break;
          case 'createSession':
            this.handleCreateSession();
            break;
          case 'switchSession':
            this.handleSwitchSession(message.sessionId);
            break;
          case 'deleteSession':
            this.handleDeleteSession(message.sessionId);
            break;
          case 'exportSession':
            await this.handleExportSession();
            break;
          case 'ready':
            this.postProfiles();
            this.postSessions();
            this.restoreMessages();
            break;
        }
      },
      null,
      this.disposables
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postProfiles();
        this.postSessions();
        this.restoreMessages();
      }
    });
  }

  refresh(): void {
    this.postProfiles();
    this.postSessions();
  }

  private getStorage(): vscode.Memento {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? this.extensionContext.workspaceState
      : this.extensionContext.globalState;
  }

  private loadState(): void {
    const storage = this.getStorage();
    const stored = storage.get<ChatStorageState | ChatMessage[]>(ChatViewProvider.STORAGE_KEY);
    const legacyMessages = storage.get<ChatMessage[]>(ChatViewProvider.LEGACY_STORAGE_KEY, []);

    if (Array.isArray(stored)) {
      const migrated = this.createSession('历史会话');
      migrated.messages = stored;
      migrated.updatedAt = Date.now();
      this.sessions = [migrated];
      this.activeSessionId = migrated.id;
      this.persistState();
      void storage.update(ChatViewProvider.LEGACY_STORAGE_KEY, undefined);
      return;
    }

    if ((!stored || !Array.isArray((stored as ChatStorageState).sessions)) && legacyMessages.length > 0) {
      const migrated = this.createSession('历史会话');
      migrated.messages = legacyMessages;
      migrated.updatedAt = Date.now();
      this.sessions = [migrated];
      this.activeSessionId = migrated.id;
      this.persistState();
      void storage.update(ChatViewProvider.LEGACY_STORAGE_KEY, undefined);
      return;
    }

    if (stored && Array.isArray(stored.sessions) && stored.sessions.length > 0) {
      this.sessions = stored.sessions;
      this.activeSessionId = stored.activeSessionId;
    }

    this.ensureActiveSession();
  }

  private persistState(): void {
    const state: ChatStorageState = {
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
    };
    void this.getStorage().update(ChatViewProvider.STORAGE_KEY, state);
  }

  private restoreMessages(): void {
    const activeSession = this.ensureActiveSession();
    this.postMessage({
      type: 'restoreHistory',
      messages: activeSession.messages,
      sessionId: activeSession.id,
      sessionTitle: activeSession.title,
    });
  }

  private ensureActiveSession(): ChatSession {
    if (this.sessions.length === 0) {
      const session = this.createSession();
      this.sessions = [session];
      this.activeSessionId = session.id;
      this.persistState();
      return session;
    }

    const activeSession = this.sessions.find(s => s.id === this.activeSessionId);
    if (activeSession) {
      return activeSession;
    }

    this.activeSessionId = this.sessions[0].id;
    this.persistState();
    return this.sessions[0];
  }

  private createSession(title?: string): ChatSession {
    const now = Date.now();
    const seq = this.sessions.length + 1;
    return {
      id: `chat-${now}-${Math.random().toString(36).slice(2, 8)}`,
      title: title || `新会话 ${seq}`,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private getActiveSession(): ChatSession {
    return this.ensureActiveSession();
  }

  private postSessions(): void {
    const activeId = this.ensureActiveSession().id;
    const ordered = [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    this.postMessage({
      type: 'updateSessions',
      sessions: ordered.map(s => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        isActive: s.id === activeId,
      })),
      activeSessionId: activeId,
    });
  }

  private appendMessage(message: ChatMessage): void {
    const session = this.getActiveSession();
    session.messages.push(message);
    session.updatedAt = Date.now();
    this.persistState();
    this.postSessions();
  }

  private updateActiveSessionMessage(
    predicate: (message: ChatMessage) => boolean,
    updater: (message: ChatMessage) => ChatMessage
  ): ChatMessage | null {
    const session = this.getActiveSession();
    const index = session.messages.findIndex(predicate);
    if (index === -1) {
      return null;
    }
    const nextMessage = updater(session.messages[index]);
    session.messages[index] = nextMessage;
    session.updatedAt = Date.now();
    this.persistState();
    this.postSessions();
    return nextMessage;
  }

  private createReviewableEditMessage(ops: EditOperation[]): ChatMessage {
    const batchId = `edit-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      role: 'editOps',
      content: `待确认修改 ${ops.length} 项`,
      ops: ops.map(op => op.path),
      editBatchId: batchId,
      editOps: ops.map(op => ({
        ...op,
        status: 'pending' as const,
      })),
    };
  }

  private resolveWorkspacePath(filePath: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('No workspace folder open');
    }

    const normalizedRoot = path.resolve(root);
    const isWindowsWorkspace = /^[a-zA-Z]:[\\/]/.test(normalizedRoot);
    let normalizedInput = filePath;

    if (isWindowsWorkspace && /^\/[^/]/.test(normalizedInput)) {
      normalizedInput = normalizedInput.replace(/^\/+/, '');
    }

    const resolvedPath = path.isAbsolute(normalizedInput)
      ? path.resolve(normalizedInput)
      : path.resolve(normalizedRoot, normalizedInput);
    const relative = path.relative(normalizedRoot, resolvedPath);
    const isInsideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!isInsideWorkspace) {
      throw new Error(`Edit path must be inside workspace root: ${normalizedRoot}`);
    }
    return resolvedPath;
  }

  private async readWorkspaceFileSnapshot(filePath: string): Promise<{ exists: boolean; content: string; resolvedPath: string }> {
    const resolvedPath = this.resolveWorkspacePath(filePath);
    const uri = vscode.Uri.file(resolvedPath);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return {
        exists: true,
        content: new TextDecoder().decode(bytes),
        resolvedPath,
      };
    } catch {
      return {
        exists: false,
        content: '',
        resolvedPath,
      };
    }
  }

  private postEditBatch(message: ChatMessage): void {
    if (!message.editBatchId || !message.editOps) {
      return;
    }
    this.postMessage({
      type: 'editBatch',
      batchId: message.editBatchId,
      content: message.content,
      ops: message.editOps,
    });
  }

  private upsertPlanMessage(plan: PlanSnapshot): ChatMessage {
    const updated = this.updateActiveSessionMessage(
      m => m.role === 'plan' && m.planId === plan.planId,
      m => ({
        ...m,
        content: plan.summary,
        planTitle: plan.title,
        planMode: plan.mode,
        planItems: plan.items,
      })
    );

    if (updated) {
      return updated;
    }

    const nextMessage: ChatMessage = {
      role: 'plan',
      content: plan.summary,
      planId: plan.planId,
      planTitle: plan.title,
      planMode: plan.mode,
      planItems: plan.items,
    };
    this.appendMessage(nextMessage);
    return nextMessage;
  }

  private postPlanUpdate(message: ChatMessage): void {
    if (!message.planId || !message.planItems) {
      return;
    }
    this.postMessage({
      type: 'planUpdate',
      planId: message.planId,
      title: message.planTitle,
      summary: message.content,
      mode: message.planMode,
      items: message.planItems,
    });
  }

  private postAssistantNote(content: string): void {
    this.appendMessage({ role: 'assistant', content });
    this.postMessage({ type: 'assistantMessage', content });
  }

  private async captureBatchOriginalSnapshots(batchId?: string): Promise<void> {
    if (!batchId) {
      return;
    }
    const message = this.getEditBatchMessage(batchId);
    if (!message?.editOps?.length) {
      return;
    }

    const snapshotByPath = new Map<string, { exists: boolean; content: string }>();
    for (const op of message.editOps) {
      if (!snapshotByPath.has(op.path)) {
        const snapshot = await this.readWorkspaceFileSnapshot(op.path);
        snapshotByPath.set(op.path, {
          exists: snapshot.exists,
          content: snapshot.content,
        });
      }
    }

    const updatedMessage = this.updateActiveSessionMessage(
      m => m.editBatchId === batchId,
      m => ({
        ...m,
        editOps: (m.editOps || []).map(item => {
          const snapshot = snapshotByPath.get(item.path);
          if (!snapshot) {
            return item;
          }
          return {
            ...item,
            originalExists: snapshot.exists,
            originalContent: snapshot.content,
          };
        }),
      })
    );
    if (updatedMessage) {
      this.postEditBatch(updatedMessage);
    }
  }

  private async handleApplySingleEdit(batchId?: string, idempotentKey?: string): Promise<void> {
    if (!batchId || !idempotentKey) {
      return;
    }
    const message = this.getActiveSession().messages.find(m => m.editBatchId === batchId && m.editOps);
    const op = message?.editOps?.find(item => item.idempotentKey === idempotentKey);
    if (!message || !op || op.status === 'applied' || op.status === 'reverted') {
      return;
    }

    let updatedMessage: ChatMessage | null = null;
    try {
      const before = await this.readWorkspaceFileSnapshot(op.path);
      await this.agent.applyEditOperation(op);
      const after = await this.readWorkspaceFileSnapshot(op.path);
      updatedMessage = this.updateActiveSessionMessage(
        m => m.editBatchId === batchId,
        m => ({
          ...m,
          editOps: (m.editOps || []).map(item =>
            item.idempotentKey === idempotentKey
              ? {
                  ...item,
                  status: 'applied',
                  error: undefined,
                  originalExists: item.originalExists ?? before.exists,
                  originalContent: item.originalContent ?? before.content,
                  modifiedContent: after.content,
                }
              : item
          ),
        })
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      updatedMessage = this.updateActiveSessionMessage(
        m => m.editBatchId === batchId,
        m => ({
          ...m,
          editOps: (m.editOps || []).map(item =>
            item.idempotentKey === idempotentKey
              ? { ...item, status: 'failed', error: errorMsg }
              : item
          ),
        })
      );
    }

    if (updatedMessage) {
      this.postEditBatch(updatedMessage);
    }
  }

  private async handleApplyEditBatch(batchId?: string): Promise<void> {
    if (!batchId) {
      return;
    }
    const message = this.getActiveSession().messages.find(m => m.editBatchId === batchId && m.editOps);
    if (!message?.editOps) {
      return;
    }
    await this.captureBatchOriginalSnapshots(batchId);
    for (const op of message.editOps) {
      if (op.status === 'pending' || op.status === 'failed') {
        await this.handleApplySingleEdit(batchId, op.idempotentKey);
      }
    }
  }

  private async handleRevertEditBatch(batchId?: string): Promise<void> {
    if (!batchId) {
      return;
    }
    const message = this.getActiveSession().messages.find(m => m.editBatchId === batchId && m.editOps);
    if (!message?.editOps?.length) {
      return;
    }

    const snapshotsByPath = new Map<string, ReviewableEditOperation>();
    for (const op of message.editOps) {
      if (!snapshotsByPath.has(op.path) && op.status === 'applied') {
        snapshotsByPath.set(op.path, op);
      }
    }

    const failed: string[] = [];
    const revertedFilePaths: string[] = [];
    for (const [filePath, op] of snapshotsByPath.entries()) {
      try {
        await this.restoreFileSnapshot(filePath, op);
        revertedFilePaths.push(filePath);
      } catch (err) {
        failed.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const updatedMessage = this.updateActiveSessionMessage(
      m => m.editBatchId === batchId,
      m => ({
        ...m,
        editOps: (m.editOps || []).map(item =>
          item.status === 'applied'
            ? {
                ...item,
                status: failed.length === 0 ? 'reverted' : 'failed',
                error: failed.length === 0 ? undefined : failed.join('\n'),
              }
            : item
        ),
      })
    );
    if (updatedMessage) {
      this.postEditBatch(updatedMessage);
    }
    if (failed.length === 0) {
      const revertedFiles = snapshotsByPath.size;
      const revertNote = revertedFiles > 0
        ? `已回退本次自动应用的修改，共恢复 ${revertedFiles} 个文件。\n\n${this.formatFileListMarkdown(revertedFilePaths)}`
        : '当前没有可回退的已应用修改。';
      this.postAssistantNote(revertNote);
    } else {
      const revertError = `回退过程中有 ${failed.length} 个文件失败，请查看修改卡片中的错误信息。\n\n${this.formatFileListMarkdown(failed)}`;
      this.postAssistantNote(revertError);
    }
  }

  private getEditBatchMessage(batchId?: string): ChatMessage | undefined {
    if (!batchId) {
      return undefined;
    }
    return this.getActiveSession().messages.find(m => m.editBatchId === batchId && m.editOps);
  }

  private async restoreFileSnapshot(filePath: string, op: ReviewableEditOperation): Promise<void> {
    const resolvedPath = this.resolveWorkspacePath(filePath);
    const uri = vscode.Uri.file(resolvedPath);
    if (!op.originalExists) {
      try {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      } catch {
        // ignore if already gone
      }
      return;
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolvedPath)));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(op.originalContent || ''));
    const restored = await this.readWorkspaceFileSnapshot(filePath);
    if (restored.content !== (op.originalContent || '')) {
      throw new Error(`Restored content verification failed for ${filePath}`);
    }
  }

  private async handleRevertEditFile(batchId?: string, filePath?: string): Promise<void> {
    if (!batchId || !filePath) {
      return;
    }
    const message = this.getEditBatchMessage(batchId);
    const fileOps = (message?.editOps || []).filter(op => op.path === filePath);
    const baseOp = fileOps.find(op => op.status === 'applied');
    if (!baseOp) {
      const note = `文件 ${filePath} 当前没有可回退的已应用修改。`;
      this.postAssistantNote(note);
      return;
    }

    try {
      await this.restoreFileSnapshot(filePath, baseOp);
      const updatedMessage = this.updateActiveSessionMessage(
        m => m.editBatchId === batchId,
        m => ({
          ...m,
          editOps: (m.editOps || []).map(item =>
            item.path === filePath && item.status === 'applied'
              ? { ...item, status: 'reverted', error: undefined }
              : item
          ),
        })
      );
      if (updatedMessage) {
        this.postEditBatch(updatedMessage);
      }
      const note = `已回退文件 ${filePath} 的自动修改。\n\n- \`${filePath}\``;
      this.postAssistantNote(note);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const updatedMessage = this.updateActiveSessionMessage(
        m => m.editBatchId === batchId,
        m => ({
          ...m,
          editOps: (m.editOps || []).map(item =>
            item.path === filePath && item.status === 'applied'
              ? { ...item, status: 'failed', error: errorMsg }
              : item
          ),
        })
      );
      if (updatedMessage) {
        this.postEditBatch(updatedMessage);
      }
      const note = `回退文件 ${filePath} 失败：${errorMsg}`;
      this.postAssistantNote(note);
    }
  }

  private async handleViewFileEdits(batchId?: string, filePath?: string): Promise<void> {
    if (!batchId || !filePath) {
      return;
    }
    const message = this.getEditBatchMessage(batchId);
    const fileOps = (message?.editOps || []).filter(op => op.path === filePath);
    if (fileOps.length === 0) {
      return;
    }

    const baseOp = fileOps[0];
    const finalOp = fileOps[fileOps.length - 1];
    const originalContent = baseOp.originalContent ?? baseOp.search ?? '';
    const modifiedContent = finalOp.modifiedContent ?? finalOp.replace ?? '';
    const originalUri = this.createReadonlyDiffUri(filePath, 'before', originalContent);
    const modifiedUri = this.createReadonlyDiffUri(filePath, 'after', modifiedContent);

    const label = baseOp.originalExists === false
      ? `${filePath} (整文件新建变更)`
      : `${filePath} (整文件已应用变更)`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      label
    );
  }

  private async handleViewSingleEdit(batchId?: string, idempotentKey?: string): Promise<void> {
    if (!batchId || !idempotentKey) {
      return;
    }
    const message = this.getActiveSession().messages.find(m => m.editBatchId === batchId && m.editOps);
    const op = message?.editOps?.find(item => item.idempotentKey === idempotentKey);
    if (!op) {
      return;
    }

    const originalContent = op.originalContent ?? op.search ?? '';
    const modifiedContent = op.modifiedContent ?? op.replace ?? '';
    const originalUri = this.createReadonlyDiffUri(op.path, 'before', originalContent);
    const modifiedUri = this.createReadonlyDiffUri(op.path, 'after', modifiedContent);

    const label = op.originalExists === false
      ? `${op.path} (新文件变更)`
      : `${op.path} (已应用变更)`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      label
    );
  }

  private createReadonlyDiffUri(filePath: string, side: 'before' | 'after', content: string): vscode.Uri {
    const safePath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const uri = vscode.Uri.from({
      scheme: ChatViewProvider.DIFF_SCHEME,
      path: `/${side}/${safePath}`,
      query: `id=${id}`,
    });
    this.diffContents.set(id, content);
    return uri;
  }

  private guessLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts':
        return 'typescript';
      case 'tsx':
        return 'typescriptreact';
      case 'js':
        return 'javascript';
      case 'jsx':
        return 'javascriptreact';
      case 'json':
        return 'json';
      case 'py':
        return 'python';
      case 'md':
        return 'markdown';
      case 'css':
        return 'css';
      case 'html':
        return 'html';
      case 'java':
        return 'java';
      case 'go':
        return 'go';
      case 'rs':
        return 'rust';
      case 'yml':
      case 'yaml':
        return 'yaml';
      default:
        return 'plaintext';
    }
  }

  private formatFileListMarkdown(items: string[]): string {
    if (!items.length) {
      return '';
    }
    return items.map(item => `- \`${item}\``).join('\n');
  }

  private maybeRenameActiveSession(firstUserMessage: string): void {
    const session = this.getActiveSession();
    if (!/^新会话 \d+$/.test(session.title)) {
      return;
    }
    const normalized = firstUserMessage.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    session.title = normalized.slice(0, 24);
    session.updatedAt = Date.now();
    this.persistState();
    this.postSessions();
  }

  private handleCreateSession(): void {
    if (this.isRunning) {
      this.postMessage({ type: 'error', content: '正在运行中，暂时不能新建会话' });
      return;
    }

    const session = this.createSession();
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.persistState();
    this.postSessions();
    this.restoreMessages();
  }

  private handleSwitchSession(sessionId?: string): void {
    if (!sessionId || this.isRunning) {
      if (this.isRunning) {
        this.postMessage({ type: 'error', content: '正在运行中，暂时不能切换会话' });
      }
      return;
    }
    const target = this.sessions.find(s => s.id === sessionId);
    if (!target) return;
    this.activeSessionId = target.id;
    this.persistState();
    this.postSessions();
    this.restoreMessages();
  }

  private handleDeleteSession(sessionId?: string): void {
    if (!sessionId || this.isRunning) {
      if (this.isRunning) {
        this.postMessage({ type: 'error', content: '正在运行中，暂时不能删除会话' });
      }
      return;
    }

    const existing = this.sessions.find(s => s.id === sessionId);
    if (!existing) return;

    this.sessions = this.sessions.filter(s => s.id !== sessionId);
    this.agent.clearSessionMemory(sessionId);

    if (this.sessions.length === 0) {
      const replacement = this.createSession();
      this.sessions = [replacement];
      this.activeSessionId = replacement.id;
    } else if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0].id;
    }

    this.persistState();
    this.postSessions();
    this.restoreMessages();
  }

  private async handleSwitchProfile(): Promise<void> {
    const profile = await ConfigManager.showProfilePicker();
    if (profile) {
      this.postProfiles();
    }
  }

  private postProfiles(): void {
    const profile = ConfigManager.getActiveProfile();
    const allProfiles = ConfigManager.getAllProfiles();

    this.postMessage({
      type: 'updateProfiles',
      profiles: allProfiles.map(p => ({
        id: p.id,
        name: p.name,
        provider: p.provider,
        model: p.model,
        isActive: p.id === profile?.id,
      })),
      activeProfile: profile ? { name: profile.name, model: profile.model, provider: profile.provider } : null,
    });
  }

  private handleStopAgent(): void {
    this.agent.stop();
  }

  private async handleSendMessage(text: string): Promise<void> {
    if (this.isRunning) {
      this.postMessage({ type: 'error', content: '正在运行中，请等待完成' });
      return;
    }

    const profile = ConfigManager.getActiveProfile();
    if (!profile) {
      this.postMessage({ type: 'error', content: '请先配置 LLM 模型' });
      return;
    }

    this.isRunning = true;

    this.appendMessage({ role: 'user', content: text });
    this.maybeRenameActiveSession(text);
    this.postMessage({ type: 'userMessage', content: text });
    this.postMessage({ type: 'setLoading', loading: true });

    let responseContent = '';
    const sessionId = this.getActiveSession().id;
    let pendingAutoApply: Promise<void> | null = null;
    let generatedEditBatch = false;

    try {
      await this.agent.processRequest(
        text,
        (chunk) => {
          responseContent += chunk;
          this.postMessage({ type: 'streamContent', content: chunk });
        },
        (state) => {
          this.postMessage({
            type: 'stateChange',
            state,
            label: this.getStateDisplayText(state),
          });
        },
        (ops) => {
          const editMessage = this.createReviewableEditMessage(ops);
          this.appendMessage(editMessage);
          this.postEditBatch(editMessage);
          generatedEditBatch = true;
          pendingAutoApply = this.handleApplyEditBatch(editMessage.editBatchId);
        },
        sessionId,
        {
          deferEditApplication: true,
          onPlanUpdate: (plan) => {
            const planMessage = this.upsertPlanMessage(plan);
            this.postPlanUpdate(planMessage);
          },
        }
      );

      if (pendingAutoApply) {
        await pendingAutoApply;
      }
      if (generatedEditBatch) {
        const autoApplyNote = '已自动应用本次修改。你可以查看 Diff，并在确认不满意时一键回退。';
        this.postAssistantNote(autoApplyNote);
      }

      this.postMessage({ type: 'done' });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.appendMessage({ role: 'error', content: errorMsg });
      this.postMessage({ type: 'error', content: errorMsg });
    } finally {
      if (responseContent) {
        this.appendMessage({ role: 'assistant', content: responseContent });
      }
      this.isRunning = false;
      this.postMessage({ type: 'setLoading', loading: false });
    }
  }

  public async handleExportSession(format?: string): Promise<void> {
    const session = this.getActiveSession();
    const chosenFormat = format || await vscode.window.showQuickPick(
      ['Markdown', 'JSON'],
      { placeHolder: '选择导出格式' }
    );
    if (!chosenFormat) return;

    let content: string;
    let ext: string;

    if (chosenFormat === 'JSON') {
      ext = 'json';
      content = JSON.stringify({
        id: session.id,
        title: session.title,
        createdAt: new Date(session.createdAt).toISOString(),
        updatedAt: new Date(session.updatedAt).toISOString(),
        messages: session.messages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.editOps ? { editOps: m.editOps.map(op => ({
            path: op.path,
            status: op.status,
          })) } : {}),
          ...(m.planId ? { planId: m.planId, planTitle: m.planTitle } : {}),
        })),
      }, null, 2);
    } else {
      ext = 'md';
      const lines: string[] = [];
      lines.push(`# ${session.title}`);
      lines.push(`> Exported: ${new Date().toISOString()}`);
      lines.push('');

      for (const msg of session.messages) {
        if (msg.role === 'state') continue;

        if (msg.role === 'user') {
          lines.push(`## User`);
          lines.push('');
          lines.push(msg.content);
          lines.push('');
        } else if (msg.role === 'assistant') {
          lines.push(`## Assistant`);
          lines.push('');
          lines.push(msg.content);
          lines.push('');
        } else if (msg.role === 'error') {
          lines.push(`## Error`);
          lines.push('');
          lines.push(msg.content);
          lines.push('');
        } else if (msg.role === 'plan') {
          lines.push(`## Plan: ${msg.planTitle || 'Execution Plan'}`);
          lines.push('');
          if (msg.planItems) {
            for (const item of msg.planItems) {
              const check = item.status === 'completed' ? '[x]' : '[ ]';
              lines.push(`- ${check} ${item.description}${item.goal ? ` — ${item.goal}` : ''}`);
            }
            lines.push('');
          }
        } else if (msg.role === 'editOps') {
          lines.push(`## Edits (${msg.editOps?.length || 0} operations)`);
          lines.push('');
          if (msg.editOps) {
            for (const op of msg.editOps) {
              lines.push(`- \`${op.path}\` — ${op.status}`);
            }
          }
          lines.push('');
        }
      }

      content = lines.join('\n');
    }

    const safeName = session.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 40);
    const defaultPath = `${safeName}.${ext}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: {
        [chosenFormat === 'JSON' ? 'JSON' : 'Markdown']: [ext],
      },
    });

    if (!uri) return;

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    vscode.window.showInformationMessage(`会话已导出: ${uri.fsPath}`);
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  private getStateDisplayText(state: AgentState): string {
    switch (state) {
      case 'PLANNING':
        return '正在规划任务...';
      case 'THINK':
        return '正在分析问题...';
      case 'ACT':
        return '正在执行操作...';
      case 'OBSERVE':
        return '正在检查结果...';
      case 'VERIFIER':
        return '正在验证修改...';
      case 'REFLECT':
        return '正在复查结果...';
      case 'WAIT_USER':
        return '需要你的确认';
      case 'DONE':
        return '正在整理回复...';
      default:
        return '处理中...';
    }
  }

  private getHtml(): string {
    return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  gap: 6px;
  flex-shrink: 0;
}
.header-title {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.session-bar {
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
.session-select {
  flex: 1;
  min-width: 0;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  font-size: 12px;
  padding: 4px 6px;
}
.icon-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
}
.icon-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.icon-btn:disabled { opacity: .5; cursor: default; }
.model-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid transparent;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
  flex-shrink: 1;
  min-width: 0;
}
.model-badge:hover { border-color: var(--vscode-focusBorder); }
.model-badge.no-config {
  background: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-inputValidation-warningForeground);
}
.model-badge .arrow { font-size: 7px; margin-left: 2px; }
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.msg {
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.5;
  word-wrap: break-word;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.msg.user {
  align-self: flex-end;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  max-width: 85%;
}
.msg.assistant {
  align-self: flex-start;
  background: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  max-width: 100%;
}
.msg.error {
  align-self: center;
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  font-size: 11px;
  width: 100%;
}
.msg.plan {
  align-self: stretch;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border);
  max-width: 100%;
}
.plan-card-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.plan-card-sub {
  font-size: 11px;
  opacity: .85;
  margin-bottom: 8px;
}
.plan-checklist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 1.4;
}
.plan-item .box {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 1px solid var(--vscode-checkbox-border, var(--vscode-panel-border));
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  flex-shrink: 0;
}
.plan-item.completed .box {
  background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  color: #fff;
}
.plan-item.in_progress .box {
  border-color: var(--vscode-progressBar-background);
}
.plan-item-text {
  flex: 1;
}
.plan-item-goal {
  font-size: 11px;
  opacity: .75;
}
.msg.state {
  align-self: center;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  padding: 2px 6px;
  background: var(--vscode-badge-background);
  border-radius: 3px;
}
.msg.edit-hint {
  align-self: flex-start;
  font-size: 10px;
  color: var(--vscode-charts-green);
  padding: 2px 6px;
}
.msg.edit-review {
  align-self: stretch;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  box-shadow: none;
}
.edit-review-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.edit-review-title {
  font-size: 12px;
  font-weight: 600;
}
.edit-review-actions,
.edit-item-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.edit-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.edit-summary-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}
.edit-summary-badge.applied {
  color: var(--vscode-testing-iconPassed);
}
.edit-summary-badge.reverted {
  color: var(--vscode-descriptionForeground);
}
.edit-summary-badge.failed {
  color: var(--vscode-errorForeground);
}
.review-btn {
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.review-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.review-btn.danger {
  background: color-mix(in srgb, var(--vscode-errorForeground) 18%, var(--vscode-editor-background));
  color: var(--vscode-errorForeground);
  border-color: color-mix(in srgb, var(--vscode-errorForeground) 30%, transparent);
}
.review-btn.subtle {
  background: transparent;
  color: var(--vscode-descriptionForeground);
}
.review-btn:disabled {
  opacity: .5;
  cursor: default;
}
.edit-review-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.edit-file-group {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vscode-sideBar-background);
  border-left-width: 3px;
}
.edit-file-group.status-applied {
  border-left-color: var(--vscode-testing-iconPassed);
}
.edit-file-group.status-failed {
  border-left-color: var(--vscode-errorForeground);
}
.edit-file-group.status-reverted {
  border-left-color: var(--vscode-descriptionForeground);
}
.edit-file-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.edit-file-header.is-collapsed {
  border-bottom: none;
}
.edit-file-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.edit-file-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.edit-toggle {
  width: 22px;
  height: 22px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}
.edit-toggle:hover {
  background: var(--vscode-list-hoverBackground);
}
.edit-file-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.edit-op-count {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}
.edit-review-item {
  padding: 8px;
  border-top: 1px solid var(--vscode-panel-border);
}
.edit-file-group .edit-review-item:first-child {
  border-top: none;
}
.edit-file-items {
  display: block;
}
.edit-file-group.collapsed .edit-file-items {
  display: none;
}
.edit-item-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.edit-path {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  word-break: break-all;
}
.edit-status {
  flex-shrink: 0;
  border-radius: 999px;
  padding: 2px 6px;
  font-size: 10px;
}
.edit-status.pending {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.edit-status.applied {
  background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
  color: var(--vscode-testing-iconPassed);
}
.edit-status.failed {
  background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent);
  color: var(--vscode-errorForeground);
}
.edit-status.reverted {
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 16%, transparent);
  color: var(--vscode-descriptionForeground);
}
.edit-preview-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  margin-top: 8px;
}
.edit-preview-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}
.edit-preview-box {
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 8px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.edit-error {
  margin-top: 6px;
  font-size: 10px;
  color: var(--vscode-errorForeground);
}
.msg code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px;
  border-radius: 3px;
}
.msg p,
.msg ul,
.msg ol,
.msg pre,
.msg blockquote,
.msg h1,
.msg h2,
.msg h3 {
  margin: 0 0 8px 0;
}
.msg p:last-child,
.msg ul:last-child,
.msg ol:last-child,
.msg pre:last-child,
.msg blockquote:last-child,
.msg h1:last-child,
.msg h2:last-child,
.msg h3:last-child {
  margin-bottom: 0;
}
.msg h1,
.msg h2,
.msg h3 {
  font-weight: 700;
  line-height: 1.35;
}
.msg h1 { font-size: 16px; }
.msg h2 { font-size: 14px; }
.msg h3 { font-size: 13px; }
.msg ul,
.msg ol {
  padding-left: 18px;
}
.msg li + li {
  margin-top: 4px;
}
.msg blockquote {
  border-left: 3px solid var(--vscode-textLink-foreground);
  padding-left: 10px;
  color: var(--vscode-descriptionForeground);
}
.msg pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 10px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 11px;
  border: 1px solid var(--vscode-panel-border);
}
.msg .code-lang {
  display: inline-block;
  margin-bottom: 8px;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background);
}
.msg pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  display: block;
  line-height: 1.5;
}
.msg a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}
.msg a:hover {
  text-decoration: underline;
}
.loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}
.spinner {
  width: 12px; height: 12px;
  border: 2px solid var(--vscode-button-background);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.input-area {
  display: flex;
  gap: 6px;
  padding: 6px 10px 10px;
  border-top: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
textarea {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 12px;
  resize: none;
  min-height: 32px;
  max-height: 80px;
  line-height: 1.4;
}
textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.send-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  align-self: flex-end;
  height: 32px;
}
.send-btn:hover { background: var(--vscode-button-hoverBackground); }
.send-btn:disabled { opacity: .5; cursor: default; }
.empty-state {
  align-self: center;
  text-align: center;
  padding: 20px 12px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.8;
}
.empty-state .title { font-size: 14px; font-weight: 600; color: var(--vscode-foreground); }
.think-block {
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  padding: 10px;
  margin: 8px 0;
}
.think-block-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  user-select: none;
}
.think-block-header::before {
  content: '▼';
  font-size: 10px;
}
.think-block.collapsed .think-block-header::before {
  content: '▶';
}
.think-block-content {
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-foreground);
}
.think-block.collapsed .think-block-content {
  display: none;
}
.stop-btn {
  background: color-mix(in srgb, var(--vscode-errorForeground) 18%, var(--vscode-editor-background));
  color: var(--vscode-errorForeground);
  border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 30%, transparent);
}
.stop-btn:hover {
  background: color-mix(in srgb, var(--vscode-errorForeground) 28%, var(--vscode-editor-background));
}
</style>
</head>
<body>
<div class="header">
  <span class="header-title">Coding Agent</span>
  <div class="model-badge" id="modelBadge">
    <span id="modelName">未配置</span>
    <span class="arrow">▼</span>
  </div>
</div>

<div class="session-bar">
  <select class="session-select" id="sessionSelect"></select>
  <button class="icon-btn" id="newSessionBtn" title="新建会话">+</button>
  <button class="icon-btn" id="exportSessionBtn" title="导出会话">↓</button>
  <button class="icon-btn" id="deleteSessionBtn" title="删除当前会话">×</button>
</div>

<div class="messages" id="messages">
  <div class="empty-state" id="emptyState">
    <div class="title">Coding Agent</div>
    <div>点击上方模型选择器配置 LLM<br>然后开始编写代码</div>
  </div>
</div>

<div class="loading" id="loading" style="display:none">
  <div class="spinner"></div>
  <span id="loadingText">思考中...</span>
</div>

<div class="input-area">
  <textarea id="input" placeholder="输入消息..." rows="1"></textarea>
  <button class="send-btn" id="sendBtn">发送</button>
  <button class="send-btn stop-btn" id="stopBtn" style="display:none">停止</button>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');
  const modelBadge = document.getElementById('modelBadge');
  const modelName = document.getElementById('modelName');
  const sessionSelect = document.getElementById('sessionSelect');
  const newSessionBtn = document.getElementById('newSessionBtn');
  const deleteSessionBtn = document.getElementById('deleteSessionBtn');
  const exportSessionBtn = document.getElementById('exportSessionBtn');
  const loading = document.getElementById('loading');
  const loadingText = document.getElementById('loadingText');
  const emptyState = document.getElementById('emptyState');

  let currentMsgEl = null;
  let isRunning = false;
  let hasMessages = false;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeUrl(url) {
    const value = String(url || '').trim();
    if (/^(https?:|file:|mailto:)/i.test(value)) {
      return value.replace(/"/g, '&quot;');
    }
    return '#';
  }

  function renderInline(text) {
    const source = String(text || '');
    const segments = source.split(/(\x60[^\x60]+\x60)/g);
    let html = '';

    for (var i = 0; i < segments.length; i++) {
      var part = segments[i];
      if (!part) continue;

      if (part.startsWith('\x60') && part.endsWith('\x60') && part.length >= 2) {
        html += '<code>' + escapeHtml(part.slice(1, -1)) + '</code>';
        continue;
      }

      var escaped = escapeHtml(part);
      escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, label, url) {
        return '<a href="' + sanitizeUrl(url) + '">' + label + '</a>';
      });
      escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      html += escaped;
    }

    return html;
  }

  function renderBlocks(markdown, thinkPlaceholders, observePlaceholders) {
    thinkPlaceholders = thinkPlaceholders || [];
    observePlaceholders = observePlaceholders || [];
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let i = 0;

    function collectParagraph(start) {
      const parts = [];
      let index = start;
      while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) break;
        if (/^#{1,3}\s+/.test(line) || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || /^>\s?/.test(line)) {
          break;
        }
        parts.push(renderInline(line));
        index++;
      }
      return { html: '<p>' + parts.join('<br>') + '</p>', next: index };
    }

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i++;
        continue;
      }

      var thinkMatch = line.trim().match(/^THINK_PLACEHOLDER_(\d+)$/);
      if (thinkMatch) {
        var thinkContent = thinkPlaceholders[parseInt(thinkMatch[1], 10)] || '';
        html.push('<div class="think-block"><div class="think-block-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">思考过程</div><div class="think-block-content">' + renderBlocks(thinkContent) + '</div></div>');
        i++;
        continue;
      }

      var observeMatch = line.trim().match(/^OBSERVE_PLACEHOLDER_(\d+)$/);
      if (observeMatch) {
        var observeContent = observePlaceholders[parseInt(observeMatch[1], 10)] || '';
        html.push('<div class="think-block"><div class="think-block-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">观察结果</div><div class="think-block-content">' + renderBlocks(observeContent) + '</div></div>');
        i++;
        continue;
      }

      if (/^###\s+/.test(line)) {
        html.push('<h3>' + renderInline(line.replace(/^###\s+/, '')) + '</h3>');
        i++;
        continue;
      }

      if (/^##\s+/.test(line)) {
        html.push('<h2>' + renderInline(line.replace(/^##\s+/, '')) + '</h2>');
        i++;
        continue;
      }

      if (/^#\s+/.test(line)) {
        html.push('<h1>' + renderInline(line.replace(/^#\s+/, '')) + '</h1>');
        i++;
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push('<li>' + renderInline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
          i++;
        }
        html.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + renderInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
          i++;
        }
        html.push('<ol>' + items.join('') + '</ol>');
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quotes = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quotes.push(renderInline(lines[i].replace(/^>\s?/, '')));
          i++;
        }
        html.push('<blockquote>' + quotes.join('<br>') + '</blockquote>');
        continue;
      }

      var paragraph = collectParagraph(i);
      html.push(paragraph.html);
      i = paragraph.next;
    }

    return html.join('');
  }

  function renderMarkdown(markdown) {
    var text = String(markdown || '');
    var thinkPlaceholders = [];
    var observePlaceholders = [];

    text = text.replace(/\n?\n?\*\*\[思考\]\*\*\s*\n([\s\S]*?)\n\s*\*\*\/\[思考\]\*\*\n?\n?/g, function(match, content) {
      var idx = thinkPlaceholders.length;
      thinkPlaceholders.push(content);
      return '\n\nTHINK_PLACEHOLDER_' + idx + '\n\n';
    });

    text = text.replace(/\n?\n?\*\*\[观察\]\*\*\s*\n([\s\S]*?)\n\s*\*\*\/\[观察\]\*\*\n?\n?/g, function(match, content) {
      var idx = observePlaceholders.length;
      observePlaceholders.push(content);
      return '\n\nOBSERVE_PLACEHOLDER_' + idx + '\n\n';
    });

    const blocks = [];
    const fence = /\x60\x60\x60([a-zA-Z0-9_-]+)?\n([\s\S]*?)\x60\x60\x60/g;
    var lastIndex = 0;
    var match;

    while ((match = fence.exec(text)) !== null) {
      if (match.index > lastIndex) {
        blocks.push(renderBlocks(text.slice(lastIndex, match.index), thinkPlaceholders, observePlaceholders));
      }
      var language = match[1] ? '<div class="code-lang">' + escapeHtml(match[1]) + '</div>' : '';
      blocks.push('<pre>' + language + '<code>' + escapeHtml(match[2]) + '</code></pre>');
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      blocks.push(renderBlocks(text.slice(lastIndex), thinkPlaceholders, observePlaceholders));
    }

    return blocks.join('') || '<p></p>';
  }

  function renderPlanHtml(planId, title, summary, mode, items) {
    var safeTitle = escapeHtml(title || '执行待办清单');
    var safeSummary = renderInline(summary || '');
    var safeMode = mode === 'compact' ? '轻量流程' : '完整流程';
    var rows = (items || []).map(function(item) {
      var status = item && item.status ? item.status : 'pending';
      var mark = status === 'completed' ? '✓' : '';
      var desc = escapeHtml(item && item.description ? item.description : '');
      var goal = escapeHtml(item && item.goal ? item.goal : '');
      return ''
        + '<div class="plan-item ' + status + '">'
        + '  <span class="box">' + mark + '</span>'
        + '  <div class="plan-item-text">'
        + '    <div>' + desc + '</div>'
        + (goal ? '<div class="plan-item-goal">' + goal + '</div>' : '')
        + '  </div>'
        + '</div>';
    }).join('');

    return ''
      + '<div class="plan-card" data-plan-id="' + escapeHtml(planId || '') + '">'
      + '  <div class="plan-card-title">' + safeTitle + '</div>'
      + '  <div class="plan-card-sub">模式：' + safeMode + (safeSummary ? ' · ' + safeSummary : '') + '</div>'
      + '  <div class="plan-checklist">' + rows + '</div>'
      + '</div>';
  }

  function setMessageContent(el, role, content) {
    if (role === 'assistant') {
      el.innerHTML = renderMarkdown(content);
    } else if (role === 'plan') {
      el.innerHTML = content || '';
    } else {
      el.textContent = content || '';
    }
  }

  function truncatePreview(text) {
    var value = String(text || '');
    return value.length > 220 ? value.slice(0, 220) + '\n...' : value;
  }

  function getEditStatusLabel(status) {
    switch (status) {
      case 'applied':
        return '已应用';
      case 'failed':
        return '应用失败';
      case 'reverted':
        return '已回退';
      default:
        return '应用中';
    }
  }

  function canRevertEdit(op) {
    return op && op.status === 'applied';
  }

  var editBatchStore = {};
  var confirmState = {
    batch: {},
    file: {}
  };

  function getFileConfirmKey(batchId, filePath) {
    return String(batchId || '') + '::' + String(filePath || '');
  }

  function setEditBatchData(batchId, content, ops) {
    editBatchStore[String(batchId || '')] = {
      content: content || '',
      ops: Array.isArray(ops) ? ops : []
    };
  }

  function clearBatchConfirmState(batchId) {
    var key = String(batchId || '');
    delete confirmState.batch[key];
    Object.keys(confirmState.file).forEach(function(fileKey) {
      if (fileKey.indexOf(key + '::') === 0) {
        delete confirmState.file[fileKey];
      }
    });
  }

  function rerenderEditBatch(batchId) {
    var key = String(batchId || '');
    var el = messages.querySelector('.msg.edit-review[data-batch-id="' + key + '"]');
    var stored = editBatchStore[key];
    if (!el || !stored) {
      return;
    }
    el.innerHTML = renderEditBatchHtml(key, stored.ops);
  }

  function isBatchConfirming(batchId) {
    return Boolean(confirmState.batch[String(batchId || '')]);
  }

  function isFileConfirming(batchId, filePath) {
    return Boolean(confirmState.file[getFileConfirmKey(batchId, filePath)]);
  }

  function renderEditBatchHtml(batchId, ops) {
    var safeOps = Array.isArray(ops) ? ops : [];
    var appliedCount = safeOps.filter(function(op) { return op.status === 'applied'; }).length;
    var failedCount = safeOps.filter(function(op) { return op.status === 'failed'; }).length;
    var revertedCount = safeOps.filter(function(op) { return op.status === 'reverted'; }).length;
    var grouped = {};
    safeOps.forEach(function(op) {
      var key = op.path || '(unknown)';
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(op);
    });

    var itemsHtml = Object.keys(grouped).sort().map(function(filePath) {
      var fileOps = grouped[filePath];
      var fileAppliedCount = fileOps.filter(function(op) { return op.status === 'applied'; }).length;
      var fileFailedCount = fileOps.filter(function(op) { return op.status === 'failed'; }).length;
      var fileRevertedCount = fileOps.filter(function(op) { return op.status === 'reverted'; }).length;
      var fileCanRevert = fileOps.some(canRevertEdit);
      var defaultCollapsed = fileAppliedCount === 0 && fileFailedCount === 0 && fileRevertedCount > 0;
      var fileStatusClass = fileFailedCount > 0 ? 'status-failed' : (fileAppliedCount > 0 ? 'status-applied' : (fileRevertedCount > 0 ? 'status-reverted' : ''));
      var summaryLabel = fileFailedCount > 0
        ? '部分失败'
        : (fileAppliedCount > 0 ? '已应用' : (fileRevertedCount > 0 ? '已回退' : '处理中'));
      var fileConfirming = isFileConfirming(batchId, filePath);
      var fileActionHtml = fileConfirming
        ? '<button class="review-btn danger" data-action="confirm-revert-file" data-batch-id="' + escapeHtml(batchId) + '" data-file-path="' + escapeHtml(filePath) + '">确认回退</button>'
          + '<button class="review-btn subtle" data-action="cancel-revert-file" data-batch-id="' + escapeHtml(batchId) + '" data-file-path="' + escapeHtml(filePath) + '">取消</button>'
        : '<button class="review-btn" data-action="revert-file" data-batch-id="' + escapeHtml(batchId) + '" data-file-path="' + escapeHtml(filePath) + '"' + (fileCanRevert ? '' : ' disabled') + '>回退该文件</button>';

      var fileItemsHtml = fileOps.map(function(op, index) {
        var searchText = op.originalContent !== undefined
          ? truncatePreview(op.originalContent)
          : (op.search ? truncatePreview(op.search) : '[新文件创建]');
        var replaceText = op.modifiedContent !== undefined
          ? truncatePreview(op.modifiedContent)
          : truncatePreview(op.replace || '');
        var errorHtml = op.error ? '<div class="edit-error">' + escapeHtml(op.error) + '</div>' : '';
        return ''
          + '<div class="edit-review-item" data-edit-key="' + escapeHtml(op.idempotentKey || '') + '">'
          + '  <div class="edit-item-top">'
          + '    <div class="edit-op-count">变更 #' + (index + 1) + '</div>'
          + '    <span class="edit-status ' + escapeHtml(op.status || 'pending') + '">' + getEditStatusLabel(op.status) + '</span>'
          + '  </div>'
          + '  <div class="edit-item-actions">'
          + '    <button class="review-btn" data-action="view-single" data-batch-id="' + escapeHtml(batchId) + '" data-edit-key="' + escapeHtml(op.idempotentKey || '') + '">查看 Diff</button>'
          + '  </div>'
          + '  <div class="edit-preview-grid">'
          + '    <div><div class="edit-preview-label">变更前</div><div class="edit-preview-box">' + escapeHtml(searchText) + '</div></div>'
          + '    <div><div class="edit-preview-label">变更后</div><div class="edit-preview-box">' + escapeHtml(replaceText) + '</div></div>'
          + '  </div>'
          + errorHtml
          + '</div>';
      }).join('');

      return ''
        + '<div class="edit-file-group ' + fileStatusClass + (defaultCollapsed ? ' collapsed' : '') + '">'
        + '  <div class="edit-file-header' + (defaultCollapsed ? ' is-collapsed' : '') + '">'
        + '    <div class="edit-file-main">'
        + '      <button class="edit-toggle" data-action="toggle-file" aria-label="切换折叠" data-file-path="' + escapeHtml(filePath) + '">' + (defaultCollapsed ? '+' : '-') + '</button>'
        + '      <div class="edit-file-meta">'
        + '        <div class="edit-path">' + escapeHtml(filePath) + '</div>'
        + '        <div class="edit-op-count">' + fileOps.length + ' 处变更</div>'
        + '      </div>'
        + '    </div>'
        + '    <div class="edit-file-actions">'
        + '      <button class="review-btn" data-action="view-file" data-batch-id="' + escapeHtml(batchId) + '" data-file-path="' + escapeHtml(filePath) + '">查看文件 Diff</button>'
        +        fileActionHtml
        + '      <span class="edit-status ' + (fileFailedCount > 0 ? 'failed' : (fileAppliedCount > 0 ? 'applied' : (fileRevertedCount > 0 ? 'reverted' : 'pending'))) + '">' + summaryLabel + '</span>'
        + '    </div>'
        + '  </div>'
        + '  <div class="edit-file-items">' + fileItemsHtml + '</div>'
        + '</div>';
    }).join('');

    return ''
      + '<div class="edit-review-header">'
      + '  <div class="edit-review-title">已自动应用修改 · ' + safeOps.length + ' 项</div>'
      + '  <div class="edit-review-actions">'
      + '    <div class="edit-summary">'
      + '      <span class="edit-summary-badge applied">已应用 ' + appliedCount + '</span>'
      + '      <span class="edit-summary-badge reverted">已回退 ' + revertedCount + '</span>'
      + '      <span class="edit-summary-badge failed">失败 ' + failedCount + '</span>'
      + '    </div>'
      +      (isBatchConfirming(batchId)
                ? '<button class="review-btn danger" data-action="confirm-revert-batch" data-batch-id="' + escapeHtml(batchId) + '">确认回退全部</button>'
                  + '<button class="review-btn subtle" data-action="cancel-revert-batch" data-batch-id="' + escapeHtml(batchId) + '">取消</button>'
                : '<button class="review-btn" data-action="revert-batch" data-batch-id="' + escapeHtml(batchId) + '"' + (safeOps.some(canRevertEdit) ? '' : ' disabled') + '>回退全部</button>')
      + '  </div>'
      + '</div>'
      + '<div class="edit-review-list">' + itemsHtml + '</div>';
  }

  function postMessage(msg) {
    try { vscode.postMessage(msg); } catch(e) {}
  }

  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', function() { postMessage({ type: 'stopAgent' }); });
  modelBadge.addEventListener('click', function() { postMessage({ type: 'toggleProfile' }); });
  newSessionBtn.addEventListener('click', function() { postMessage({ type: 'createSession' }); });
  deleteSessionBtn.addEventListener('click', function() {
    postMessage({ type: 'deleteSession', sessionId: sessionSelect.value });
  });
  exportSessionBtn.addEventListener('click', function() { postMessage({ type: 'exportSession' }); });
  sessionSelect.addEventListener('change', function() {
    postMessage({ type: 'switchSession', sessionId: sessionSelect.value });
  });
  messages.addEventListener('click', function(event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    var action = target.getAttribute('data-action');
    if (!action) {
      return;
    }
    var batchId = target.getAttribute('data-batch-id');
    var editKey = target.getAttribute('data-edit-key');
    var filePath = target.getAttribute('data-file-path');
    if (action === 'toggle-file') {
      var group = target.closest('.edit-file-group');
      if (group) {
        group.classList.toggle('collapsed');
        var header = group.querySelector('.edit-file-header');
        if (header) {
          header.classList.toggle('is-collapsed', group.classList.contains('collapsed'));
        }
        target.textContent = group.classList.contains('collapsed') ? '+' : '-';
      }
    } else if (action === 'revert-batch') {
      confirmState.batch[String(batchId || '')] = true;
      rerenderEditBatch(batchId);
    } else if (action === 'confirm-revert-batch') {
      delete confirmState.batch[String(batchId || '')];
      postMessage({ type: 'revertEditBatch', batchId: batchId });
    } else if (action === 'cancel-revert-batch') {
      delete confirmState.batch[String(batchId || '')];
      rerenderEditBatch(batchId);
    } else if (action === 'revert-file') {
      confirmState.file[getFileConfirmKey(batchId, filePath)] = true;
      rerenderEditBatch(batchId);
    } else if (action === 'confirm-revert-file') {
      delete confirmState.file[getFileConfirmKey(batchId, filePath)];
      postMessage({ type: 'revertEditFile', batchId: batchId, filePath: filePath });
    } else if (action === 'cancel-revert-file') {
      delete confirmState.file[getFileConfirmKey(batchId, filePath)];
      rerenderEditBatch(batchId);
    } else if (action === 'view-file') {
      postMessage({ type: 'viewFileEdits', batchId: batchId, filePath: filePath });
    } else if (action === 'view-single') {
      postMessage({ type: 'viewSingleEdit', batchId: batchId, idempotentKey: editKey });
    }
  });

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });

  function sendMessage() {
    const text = input.value.trim();
    if (!text || isRunning) return;
    input.value = '';
    input.style.height = 'auto';
    postMessage({ type: 'sendMessage', text: text });
  }

  function addMessage(role, content, ops) {
    hideEmptyState();
    hasMessages = true;
    currentMsgEl = null;
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.dataset.rawContent = content || '';
    setMessageContent(el, role, content || '');
    messages.appendChild(el);
    if (ops && ops.length) {
      var hint = document.createElement('div');
      hint.className = 'msg edit-hint';
      hint.textContent = '编辑 ' + ops.length + ' 个文件';
      messages.appendChild(hint);
    }
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function addEditBatchMessage(batchId, content, ops) {
    hideEmptyState();
    hasMessages = true;
    currentMsgEl = null;
    var el = document.createElement('div');
    el.className = 'msg edit-review';
    el.dataset.batchId = batchId || '';
    el.innerHTML = renderEditBatchHtml(batchId || '', ops || []);
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function addPlanMessage(planId, title, summary, mode, items) {
    hideEmptyState();
    hasMessages = true;
    currentMsgEl = null;
    var el = document.createElement('div');
    el.className = 'msg plan';
    el.dataset.planId = planId || '';
    el.innerHTML = renderPlanHtml(planId, title, summary, mode, items);
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function upsertPlanMessage(planId, title, summary, mode, items) {
    var el = messages.querySelector('.msg.plan[data-plan-id="' + planId + '"]');
    if (!el) {
      return addPlanMessage(planId, title, summary, mode, items);
    }
    el.innerHTML = renderPlanHtml(planId, title, summary, mode, items);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function upsertEditBatchMessage(batchId, content, ops) {
    setEditBatchData(batchId, content, ops);
    clearBatchConfirmState(batchId);
    var el = messages.querySelector('.msg.edit-review[data-batch-id="' + batchId + '"]');
    if (!el) {
      return addEditBatchMessage(batchId, content, ops);
    }
    el.innerHTML = renderEditBatchHtml(batchId || '', ops || []);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function hideEmptyState() {
    if (emptyState) emptyState.style.display = 'none';
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'userMessage':
        addMessage('user', msg.content);
        break;

      case 'streamContent':
        if (!currentMsgEl) {
          currentMsgEl = addMessage('assistant', '');
        }
        currentMsgEl.dataset.rawContent = (currentMsgEl.dataset.rawContent || '') + msg.content;
        setMessageContent(currentMsgEl, 'assistant', currentMsgEl.dataset.rawContent);
        messages.scrollTop = messages.scrollHeight;
        break;

      case 'assistantMessage':
        addMessage('assistant', msg.content);
        break;

      case 'stateChange':
        loadingText.textContent = msg.label || msg.state || '处理中...';
        break;

      case 'planUpdate':
        upsertPlanMessage(msg.planId, msg.title, msg.summary, msg.mode, msg.items);
        break;

      case 'setLoading':
        loading.style.display = msg.loading ? 'flex' : 'none';
        isRunning = msg.loading;
        sendBtn.disabled = msg.loading;
        sendBtn.style.display = msg.loading ? 'none' : '';
        stopBtn.style.display = msg.loading ? '' : 'none';
        sessionSelect.disabled = msg.loading;
        newSessionBtn.disabled = msg.loading;
        deleteSessionBtn.disabled = msg.loading;
        if (!msg.loading) currentMsgEl = null;
        break;

      case 'editOps':
        addMessage('edit-hint', '编辑 ' + msg.ops.length + ' 个文件');
        break;

      case 'editBatch':
        upsertEditBatchMessage(msg.batchId, msg.content, msg.ops);
        break;

      case 'done':
        break;

      case 'error':
        addMessage('error', msg.content);
        break;

      case 'updateProfiles':
        if (msg.activeProfile) {
          modelBadge.classList.remove('no-config');
          modelName.textContent = msg.activeProfile.name;
        } else {
          modelBadge.classList.add('no-config');
          modelName.textContent = '未配置';
        }
        if (!msg.activeProfile && !hasMessages) {
          emptyState.style.display = '';
        }
        break;

      case 'updateSessions':
        sessionSelect.innerHTML = '';
        for (var j = 0; j < msg.sessions.length; j++) {
          var session = msg.sessions[j];
          var option = document.createElement('option');
          option.value = session.id;
          option.textContent = session.title;
          sessionSelect.appendChild(option);
        }
        if (msg.activeSessionId) {
          sessionSelect.value = msg.activeSessionId;
        }
        deleteSessionBtn.disabled = isRunning || msg.sessions.length <= 1;
        break;

      case 'restoreHistory':
        hasMessages = msg.messages.length > 0;
        if (hasMessages) {
          hideEmptyState();
        } else {
          emptyState.style.display = '';
        }
        var frag = document.createDocumentFragment();
        for (var i = 0; i < msg.messages.length; i++) {
          var m = msg.messages[i];
          if (m.role === 'state') continue;
          if (m.role === 'plan') {
            var planEl = document.createElement('div');
            planEl.className = 'msg plan';
            planEl.dataset.planId = m.planId || '';
            planEl.innerHTML = renderPlanHtml(
              m.planId || '',
              m.planTitle || '执行待办清单',
              m.content || '',
              m.planMode || 'full',
              m.planItems || []
            );
            frag.appendChild(planEl);
            continue;
          }
          if (m.role === 'editOps') {
            setEditBatchData(m.editBatchId || '', m.content || '', m.editOps || []);
            var reviewEl = document.createElement('div');
            reviewEl.className = 'msg edit-review';
            reviewEl.dataset.batchId = m.editBatchId || '';
            reviewEl.innerHTML = renderEditBatchHtml(m.editBatchId || '', m.editOps || []);
            frag.appendChild(reviewEl);
            continue;
          }
          var el = document.createElement('div');
          el.className = 'msg ' + m.role;
          el.dataset.rawContent = m.content || '';
          setMessageContent(el, m.role, m.content || '');
          frag.appendChild(el);
          if (m.ops && m.ops.length) {
            var hint = document.createElement('div');
            hint.className = 'msg edit-hint';
            hint.textContent = '编辑 ' + m.ops.length + ' 个文件';
            frag.appendChild(hint);
          }
        }
        messages.innerHTML = '';
        messages.appendChild(frag);
        if (!hasMessages) {
          messages.appendChild(emptyState);
        }
        messages.scrollTop = messages.scrollHeight;
        break;
    }
  });

  postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}
