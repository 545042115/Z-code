import * as vscode from 'vscode';
import { AgentCore, EditOperation } from '../agent/agent-core';

/**
 * Composer 面板 - 多文件编辑
 * 类似 Cursor Composer 的功能
 */

interface ComposerEdit {
  id: string;
  path: string;
  original: string;
  modified: string;
  description: string;
  applied: boolean;
}

interface ComposerPlan {
  description: string;
  edits: ComposerEdit[];
}

export class ComposerPanel {
  public static currentPanel: ComposerPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private edits: ComposerEdit[] = [];
  private currentPlan: ComposerPlan | null = null;

  static createOrShow(extensionUri: vscode.Uri, agent: AgentCore): ComposerPanel {
    const column = vscode.ViewColumn.Beside;

    if (ComposerPanel.currentPanel) {
      ComposerPanel.currentPanel.panel.reveal(column);
      return ComposerPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'codingAgentComposer',
      'Composer',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    ComposerPanel.currentPanel = new ComposerPanel(panel, extensionUri, agent);
    return ComposerPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentCore
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'generatePlan':
            await this.generatePlan(message.request);
            break;
          case 'applyEdit':
            await this.applyEdit(message.editId);
            break;
          case 'applyAll':
            await this.applyAllEdits();
            break;
          case 'rejectEdit':
            await this.rejectEdit(message.editId);
            break;
          case 'rejectAll':
            await this.rejectAllEdits();
            break;
          case 'viewDiff':
            await this.viewDiff(message.editId);
            break;
          case 'addContextFile':
            await this.addContextFile();
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        ComposerPanel.currentPanel = undefined;
        this.disposables.forEach(d => d.dispose());
      },
      null,
      this.disposables
    );
  }

  private async generatePlan(request: string): Promise<void> {
    this.postMessage({ type: 'setLoading', loading: true });

    try {
      // 收集上下文
      const contextFiles = await this.collectContextFiles();
      
      // 构建 Prompt
      const prompt = this.buildComposerPrompt(request, contextFiles);

      // 调用 Agent 生成计划
      await this.agent.processRequest(
        prompt,
        (chunk) => {
          this.postMessage({ type: 'streamPlan', content: chunk });
        },
        (state) => {
          this.postMessage({ type: 'stateChange', state });
        },
        (ops) => {
          // 转换 EditOperation 到 ComposerEdit
          this.edits = ops.map((op, idx) => ({
            id: `edit-${idx}`,
            path: op.path,
            original: op.search,
            modified: op.replace,
            description: `Edit ${idx + 1}`,
            applied: false,
          }));
          
          this.currentPlan = {
            description: request,
            edits: this.edits,
          };
          
          this.postMessage({
            type: 'showPlan',
            plan: this.currentPlan,
          });
        }
      );
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: `Failed to generate plan: ${err}`,
      });
    } finally {
      this.postMessage({ type: 'setLoading', loading: false });
    }
  }

  private async collectContextFiles(): Promise<Array<{ path: string; content: string }>> {
    const files: Array<{ path: string; content: string }> = [];
    
    // 获取打开的文件
    const openDocs = vscode.workspace.textDocuments
      .filter(d => !d.isUntitled && d.languageId !== 'Log')
      .slice(0, 5);

    for (const doc of openDocs) {
      files.push({
        path: doc.uri.fsPath,
        content: doc.getText(),
      });
    }

    return files;
  }

  private async addContextFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
    });

    if (!uris) return;

    const files = await Promise.all(
      uris.map(async (uri) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        return {
          path: uri.fsPath,
          content: doc.getText(),
        };
      })
    );

    this.postMessage({
      type: 'addContextFiles',
      files,
    });
  }

  private async applyEdit(editId: string): Promise<void> {
    const edit = this.edits.find(e => e.id === editId);
    if (!edit || edit.applied) return;

    try {
      const uri = vscode.Uri.file(edit.path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      const fullText = doc.getText();
      const index = fullText.indexOf(edit.original);

      if (index === -1) {
        throw new Error('Original text not found');
      }

      const startPos = doc.positionAt(index);
      const endPos = doc.positionAt(index + edit.original.length);

      await editor.edit(editBuilder => {
        editBuilder.replace(new vscode.Range(startPos, endPos), edit.modified);
      });

      edit.applied = true;
      this.postMessage({
        type: 'editApplied',
        editId,
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to apply edit: ${err}`);
    }
  }

  private async applyAllEdits(): Promise<void> {
    for (const edit of this.edits) {
      if (!edit.applied) {
        await this.applyEdit(edit.id);
      }
    }
  }

  private async rejectEdit(editId: string): Promise<void> {
    const index = this.edits.findIndex(e => e.id === editId);
    if (index !== -1) {
      this.edits.splice(index, 1);
      this.postMessage({
        type: 'editRejected',
        editId,
      });
    }
  }

  private async rejectAllEdits(): Promise<void> {
    this.edits = [];
    this.currentPlan = null;
    this.postMessage({ type: 'clearPlan' });
  }

  private async viewDiff(editId: string): Promise<void> {
    const edit = this.edits.find(e => e.id === editId);
    if (!edit) return;

    const originalUri = vscode.Uri.parse(`composer:${edit.path}.original`);
    const modifiedUri = vscode.Uri.parse(`composer:${edit.path}.modified`);

    // 注册虚拟文档提供器
    const provider = new (class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(uri: vscode.Uri): string {
        if (uri.path.endsWith('.original')) {
          return edit.original;
        }
        return edit.modified;
      }
    })();

    vscode.workspace.registerTextDocumentContentProvider('composer', provider);

    // 显示 diff
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      `${edit.path} (Composer)`
    );
  }

  private buildComposerPrompt(request: string, files: Array<{ path: string; content: string }>): string {
    const fileContexts = files.map(f => `
File: ${f.path}
\`\`\`
${f.content.slice(0, 2000)}
\`\`\`
`).join('\n');

    return `You are a coding assistant. Please help with the following request that may involve multiple files.

## Context Files
${fileContexts}

## Request
${request}

## Instructions
1. Analyze the request and context files
2. Create a plan for modifications
3. Use the edit_file tool to make precise changes
4. Each edit should include:
   - path: file path
   - search: exact text to find
   - replace: replacement text
   - idempotentKey: unique identifier

Think step by step and make minimal, precise changes.`;
  }

  private postMessage(message: any): void {
    this.panel.webview.postMessage(message);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Composer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .header h2 {
      font-size: 14px;
      font-weight: 600;
    }

    .context-section {
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .context-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .context-files {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .context-file {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
    }

    .input-section {
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    textarea {
      width: 100%;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 10px 12px;
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      min-height: 80px;
    }

    textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .button-row {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .plan-section {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .plan-description {
      background: var(--vscode-editor-inactiveSelectionBackground);
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 16px;
    }

    .edits-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .edit-item {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
    }

    .edit-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .edit-path {
      font-family: monospace;
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
    }

    .edit-status {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .edit-status.pending {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .edit-status.applied {
      background: var(--vscode-testing-iconPassed);
      color: white;
    }

    .edit-actions {
      display: flex;
      gap: 4px;
    }

    .edit-actions button {
      padding: 4px 8px;
      font-size: 11px;
    }

    .diff-preview {
      margin-top: 8px;
      background: var(--vscode-diffEditor-insertedTextBackground);
      border: 1px solid var(--vscode-diffEditor-insertedLineBackground);
      border-radius: 4px;
      padding: 8px;
      font-family: monospace;
      font-size: 11px;
      max-height: 100px;
      overflow: auto;
    }

    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--vscode-button-background);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }

    .bulk-actions {
      position: sticky;
      bottom: 0;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px 16px;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>Composer</h2>
  </div>

  <div class="context-section">
    <div class="context-header">
      <span>Context Files</span>
      <button id="addFileBtn" class="secondary">+ Add File</button>
    </div>
    <div class="context-files" id="contextFiles">
      <span class="empty">No files added</span>
    </div>
  </div>

  <div class="input-section">
    <textarea id="requestInput" placeholder="Describe what you want to do across multiple files..."></textarea>
    <div class="button-row">
      <button id="generateBtn">Generate Plan</button>
      <button id="clearBtn" class="secondary">Clear</button>
    </div>
  </div>

  <div class="plan-section" id="planSection">
    <div class="empty-state">
      <p>Enter your request above to generate a plan</p>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentPlan = null;
    let contextFiles = [];

    // Elements
    const requestInput = document.getElementById('requestInput');
    const generateBtn = document.getElementById('generateBtn');
    const clearBtn = document.getElementById('clearBtn');
    const addFileBtn = document.getElementById('addFileBtn');
    const contextFilesEl = document.getElementById('contextFiles');
    const planSection = document.getElementById('planSection');

    // Event listeners
    generateBtn.addEventListener('click', () => {
      const request = requestInput.value.trim();
      if (request) {
        vscode.postMessage({ type: 'generatePlan', request });
      }
    });

    clearBtn.addEventListener('click', () => {
      requestInput.value = '';
      vscode.postMessage({ type: 'rejectAll' });
    });

    addFileBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'addContextFile' });
    });

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;

      switch (message.type) {
        case 'setLoading':
          planSection.innerHTML = message.loading 
            ? '<div class="loading"><div class="spinner"></div>Generating plan...</div>'
            : '';
          break;

        case 'streamPlan':
          // Stream plan description
          break;

        case 'showPlan':
          currentPlan = message.plan;
          renderPlan(currentPlan);
          break;

        case 'addContextFiles':
          contextFiles.push(...message.files);
          renderContextFiles();
          break;

        case 'editApplied':
          updateEditStatus(message.editId, 'applied');
          break;

        case 'editRejected':
          removeEdit(message.editId);
          break;

        case 'clearPlan':
          currentPlan = null;
          planSection.innerHTML = '<div class="empty-state"><p>Enter your request above to generate a plan</p></div>';
          break;

        case 'error':
          planSection.innerHTML = '<div class="empty-state"><p style="color: var(--vscode-errorForeground);">' + message.message + '</p></div>';
          break;
      }
    });

    function renderContextFiles() {
      if (contextFiles.length === 0) {
        contextFilesEl.innerHTML = '<span class="empty">No files added</span>';
        return;
      }

      contextFilesEl.innerHTML = contextFiles.map(f => 
        '<span class="context-file">' + f.path.split('/').pop() + '</span>'
      ).join('');
    }

    function renderPlan(plan) {
      const editsHtml = plan.edits.map(edit => '
        <div class="edit-item" data-edit-id="' + edit.id + '">
          <div class="edit-header">
            <span class="edit-path">' + edit.path + '</span>
            <span class="edit-status pending">Pending</span>
          </div>
          <div class="edit-actions">
            <button onclick="applyEdit(\'' + edit.id + '\')">Apply</button>
            <button onclick="viewDiff(\'' + edit.id + '\')" class="secondary">View Diff</button>
            <button onclick="rejectEdit(\'' + edit.id + '\')" class="secondary">Reject</button>
          </div>
        </div>
      ').join('');

      planSection.innerHTML = '
        <div class="plan-description">
          <strong>Plan:</strong> ' + escapeHtml(plan.description) + '
        </div>
        <div class="edits-list">
          ' + editsHtml + '
        </div>
        <div class="bulk-actions">
          <button onclick="applyAll()">Apply All</button>
          <button onclick="rejectAll()" class="secondary">Reject All</button>
        </div>
      ';
    }

    function applyEdit(editId) {
      vscode.postMessage({ type: 'applyEdit', editId });
    }

    function viewDiff(editId) {
      vscode.postMessage({ type: 'viewDiff', editId });
    }

    function rejectEdit(editId) {
      vscode.postMessage({ type: 'rejectEdit', editId });
    }

    function applyAll() {
      vscode.postMessage({ type: 'applyAll' });
    }

    function rejectAll() {
      vscode.postMessage({ type: 'rejectAll' });
    }

    function updateEditStatus(editId, status) {
      const editEl = document.querySelector('[data-edit-id="' + editId + '"]');
      if (editEl) {
        const statusEl = editEl.querySelector('.edit-status');
        statusEl.className = 'edit-status ' + status;
        statusEl.textContent = status === 'applied' ? 'Applied' : 'Pending';
      }
    }

    function removeEdit(editId) {
      const editEl = document.querySelector('[data-edit-id="' + editId + '"]');
      if (editEl) {
        editEl.remove();
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}
