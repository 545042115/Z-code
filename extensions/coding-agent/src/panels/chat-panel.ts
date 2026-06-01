import * as vscode from 'vscode';
import { AgentCore, AgentState, EditOperation } from '../agent/agent-core';
import { ConfigManager } from '../config/config-manager';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;

  private readonly outputChannel: vscode.OutputChannel;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly agent: AgentCore;
  private isRunning: boolean = false;
  private disposables: vscode.Disposable[] = [];

  private constructor(agent: AgentCore) {
    this.agent = agent;

    this.outputChannel = vscode.window.createOutputChannel('Coding Agent', 'log');
    this.outputChannel.appendLine('Coding Agent Chat 已启动');
    this.outputChannel.appendLine('');

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'codingAgent.selectProfile';
    this.disposables.push(this.statusBarItem);
    this.disposables.push(this.outputChannel);

    this.updateStatusBar();
    this.registerListeners();
    this.statusBarItem.show();
  }

  static init(agent: AgentCore): ChatPanel {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.dispose();
    }
    ChatPanel.currentPanel = new ChatPanel(agent);
    return ChatPanel.currentPanel;
  }

  static getInstance(): ChatPanel | undefined {
    return ChatPanel.currentPanel;
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.updateStatusBar();
      })
    );
  }

  private updateStatusBar(): void {
    const profile = ConfigManager.getActiveProfile();
    if (profile) {
      this.statusBarItem.text = `$(comment-discussion) ${profile.name} ($(circuit-board) ${profile.model})`;
      this.statusBarItem.tooltip = `当前模型: ${profile.name}\n提供商: ${profile.provider}\n端点: ${profile.endpoint}\n点击切换配置`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = '$(comment-discussion) Coding Agent - 未配置';
      this.statusBarItem.tooltip = '点击配置 LLM 模型';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    }
  }

  refreshStatusBar(): void {
    this.updateStatusBar();
  }

  async startNewChat(): Promise<void> {
    const profile = ConfigManager.getActiveProfile();
    if (!profile) {
      const action = await vscode.window.showWarningMessage(
        '请先配置 LLM 模型后才能开始对话',
        '添加配置',
        '取消'
      );
      if (action === '添加配置') {
        await ConfigManager.showProfileEditor();
        this.updateStatusBar();
      }
      return;
    }

    const message = await vscode.window.showInputBox({
      prompt: `Coding Agent (${profile.name} · ${profile.model})`,
      placeHolder: '请输入您的问题，例如：帮我写一个排序函数',
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (!value || value.trim().length === 0) {
          return '请输入消息内容';
        }
        return null;
      },
    });

    if (!message || message.trim().length === 0) return;

    await this.sendMessage(message.trim());
    this.startNewChat();
  }

  async sendMessage(text: string): Promise<void> {
    if (this.isRunning) {
      vscode.window.showWarningMessage('Agent 正在运行中，请等待完成');
      return;
    }

    const profile = ConfigManager.getActiveProfile();
    if (!profile) {
      vscode.window.showErrorMessage('请先配置 LLM 模型');
      return;
    }

    this.isRunning = true;

    const timestamp = new Date().toLocaleTimeString('zh-CN');

    this.outputChannel.appendLine(`── ${timestamp} ───────────────────────────────────────`);
    this.outputChannel.appendLine(`[您] ${text}`);
    this.outputChannel.appendLine('');

    this.outputChannel.show(true);

    let responseContent = '';
    let lastState: string = '';

    try {
      await this.agent.processRequest(
        text,
        (chunk) => {
          responseContent += chunk;
          this.outputChannel.append(chunk);
        },
        (state) => {
          if (state !== lastState) {
            lastState = state;
            this.outputChannel.appendLine(`\n[${state}]`);
          }
        },
        (ops) => {
          this.outputChannel.appendLine('');
          this.outputChannel.appendLine(`[编辑] 建议 ${ops.length} 处修改:`);
          for (const op of ops) {
            this.outputChannel.appendLine(`  📄 ${op.path}`);
          }
          this.outputChannel.appendLine('');
        }
      );

      this.outputChannel.appendLine('');
      this.outputChannel.appendLine(`✅ 完成`);
      this.outputChannel.appendLine('');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine(`❌ 错误: ${errorMsg}`);
      this.outputChannel.appendLine('');
      vscode.window.showErrorMessage(`Coding Agent 错误: ${errorMsg}`);
    } finally {
      this.isRunning = false;
    }
  }

  show(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    if (ChatPanel.currentPanel === this) {
      ChatPanel.currentPanel = undefined;
    }
  }
}