import * as vscode from 'vscode';
import { AgentCore, AgentState, EditOperation } from '../agent/agent-core';
import { ConfigManager, LLMConfigProfile } from '../config/config-manager';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error' | 'state' | 'editOps';
  content: string;
  ops?: string[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly VIEW_TYPE = 'codingAgent.chat';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private isRunning: boolean = false;
  private messages: ChatMessage[] = [];
  private pendingRestore: boolean = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentCore
  ) {}

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
          case 'toggleProfile':
            await this.handleSwitchProfile();
            break;
          case 'ready':
            this.postProfiles();
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
        this.restoreMessages();
      }
    });
  }

  refresh(): void {
    this.postProfiles();
  }

  private restoreMessages(): void {
    if (this.messages.length === 0) return;
    this.postMessage({ type: 'restoreHistory', messages: this.messages });
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

    this.messages.push({ role: 'user', content: text });
    this.postMessage({ type: 'userMessage', content: text });
    this.postMessage({ type: 'setLoading', loading: true });

    let responseContent = '';

    try {
      await this.agent.processRequest(
        text,
        (chunk) => {
          responseContent += chunk;
          this.postMessage({ type: 'streamContent', content: chunk });
        },
        (state) => {
          this.postMessage({ type: 'stateChange', state });
          this.messages.push({ role: 'state', content: state });
        },
        (ops) => {
          this.postMessage({ type: 'editOps', ops: ops.map(o => o.path) });
          this.messages.push({
            role: 'editOps',
            content: '',
            ops: ops.map(o => o.path),
          });
        }
      );

      this.postMessage({ type: 'done' });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: 'error', content: errorMsg });
      this.postMessage({ type: 'error', content: errorMsg });
    } finally {
      if (responseContent) {
        this.messages.push({ role: 'assistant', content: responseContent });
      }
      this.isRunning = false;
      this.postMessage({ type: 'setLoading', loading: false });
    }
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
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
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
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
  max-width: 100%;
}
.msg.error {
  align-self: center;
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  font-size: 11px;
  width: 100%;
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
.msg code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px;
  border-radius: 3px;
}
.msg pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 6px;
  border-radius: 4px;
  overflow-x: auto;
  margin-top: 4px;
  font-size: 11px;
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
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const modelBadge = document.getElementById('modelBadge');
  const modelName = document.getElementById('modelName');
  const loading = document.getElementById('loading');
  const loadingText = document.getElementById('loadingText');
  const emptyState = document.getElementById('emptyState');

  let currentMsgEl = null;
  let isRunning = false;
  let hasMessages = false;

  function postMessage(msg) {
    try { vscode.postMessage(msg); } catch(e) {}
  }

  sendBtn.addEventListener('click', sendMessage);
  modelBadge.addEventListener('click', function() { postMessage({ type: 'toggleProfile' }); });

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
    el.textContent = content || '';
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
        currentMsgEl.textContent += msg.content;
        messages.scrollTop = messages.scrollHeight;
        break;

      case 'stateChange':
        loadingText.textContent = msg.state + '...';
        break;

      case 'setLoading':
        loading.style.display = msg.loading ? 'flex' : 'none';
        isRunning = msg.loading;
        sendBtn.disabled = msg.loading;
        if (!msg.loading) currentMsgEl = null;
        break;

      case 'editOps':
        addMessage('edit-hint', '编辑 ' + msg.ops.length + ' 个文件');
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

      case 'restoreHistory':
        hasMessages = true;
        hideEmptyState();
        var frag = document.createDocumentFragment();
        for (var i = 0; i < msg.messages.length; i++) {
          var m = msg.messages[i];
          if (m.role === 'state' || m.role === 'editOps') continue;
          var el = document.createElement('div');
          el.className = 'msg ' + m.role;
          el.textContent = m.content || '';
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