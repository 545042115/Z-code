import * as vscode from 'vscode';
import { AgentCore } from './agent/agent-core';
import { ChatPanel } from './panels/chat-panel';
import { ComposerPanel } from './panels/composer-panel';
import { InlineCompletionProvider, InlineEditProvider } from './inline/inline-completion';
import { ConfigManager } from './config/config-manager';
import { ChatViewProvider } from './panels/chat-view-provider';

/**
 * Coding Agent 扩展入口
 */

let agent: AgentCore;
let inlineEditProvider: InlineEditProvider;
let chatPanel: ChatPanel;

export async function activate(context: vscode.ExtensionContext) {
  try {
    console.log('Coding Agent extension activating...');

    // 初始化配置管理器
    ConfigManager.init(context);

    // 初始化 Agent Core
    agent = new AgentCore(context);
    inlineEditProvider = new InlineEditProvider();

    // 初始化原生 ChatPanel（OutputChannel + StatusBar）
    chatPanel = ChatPanel.init(agent);

    // 注册侧边栏 WebviewView
    try {
      const chatViewProvider = new ChatViewProvider(context.extensionUri, agent);
      context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
          ChatViewProvider.VIEW_TYPE,
          chatViewProvider,
          { webviewOptions: { retainContextWhenHidden: true } }
        )
      );
    } catch (err) {
      console.warn('WebviewView registration skipped (may already exist):', err);
    }

    // 先注册所有命令，确保即使初始化失败也能使用
    registerCommands(context);

    // 注册行内补全提供者
    const inlineCompletionProvider = new InlineCompletionProvider();
    const completionProvider = vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      inlineCompletionProvider
    );
    context.subscriptions.push(completionProvider);

    // 异步初始化配置（不阻塞激活）
    initializeConfig(context);

    // 设置上下文变量
    vscode.commands.executeCommand('setContext', 'codingAgent.enabled', true);

    console.log('Coding Agent extension activated successfully');
  } catch (err) {
    console.error('Coding Agent activation error:', err);
    vscode.window.showErrorMessage(`Coding Agent 激活失败: ${err}`);
  }
}

/**
 * 注册所有命令（在 try-catch 外部，确保尽可能注册）
 */
function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    // 打开 Chat（显示 OutputChannel）
    vscode.commands.registerCommand('codingAgent.openChat', () => {
      chatPanel.show();
    }),

    // 发送消息（启动新对话）
    vscode.commands.registerCommand('codingAgent.sendMessage', async () => {
      await chatPanel.startNewChat();
    }),

    // 显示对话历史
    vscode.commands.registerCommand('codingAgent.showChatHistory', () => {
      chatPanel.show();
    }),

    // 打开 Composer 面板
    vscode.commands.registerCommand('codingAgent.openComposer', () => {
      ComposerPanel.createOrShow(context.extensionUri, agent);
    }),

    // 行内编辑（带输入框）
    vscode.commands.registerCommand('codingAgent.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('Please select code to edit');
        return;
      }

      const instruction = await vscode.window.showInputBox({
        prompt: 'What would you like to do with the selected code?',
        placeHolder: 'e.g., "Refactor this to use async/await", "Add error handling", "Optimize performance"',
      });

      if (!instruction) return;

      await inlineEditProvider.performInlineEdit(editor, instruction);
    }),

    // 接受编辑
    vscode.commands.registerCommand('codingAgent.acceptEdit', () => {
      vscode.window.showInformationMessage('Edit accepted');
    }),

    // 拒绝编辑
    vscode.commands.registerCommand('codingAgent.rejectEdit', () => {
      vscode.window.showInformationMessage('Edit rejected');
    }),

    // 补全被接受时的回调
    vscode.commands.registerCommand('codingAgent.onCompletionAccepted', (uri: vscode.Uri, position: vscode.Position, completion: string) => {
      console.log('Completion accepted:', completion);
    }),

    // ========== 配置管理命令 ==========
    
    // 选择配置
    vscode.commands.registerCommand('codingAgent.selectProfile', async () => {
      const profile = await ConfigManager.showProfilePicker();
      if (profile && chatPanel) {
        chatPanel.refreshStatusBar();
      }
    }),

    // 添加新配置
    vscode.commands.registerCommand('codingAgent.addProfile', async () => {
      await ConfigManager.showProfileEditor();
      if (chatPanel) {
        chatPanel.refreshStatusBar();
      }
    }),

    // 编辑配置
    vscode.commands.registerCommand('codingAgent.editProfile', async () => {
      const profiles = ConfigManager.getAllProfiles();
      const items = profiles.map(p => ({
        label: p.name,
        description: `${p.provider} - ${p.model}`,
        profile: p,
      }));
      
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要编辑的配置',
      });
      
      if (selected) {
        await ConfigManager.showProfileEditor(selected.profile);
        if (chatPanel) {
          chatPanel.refreshStatusBar();
        }
      }
    }),

    // 删除配置
    vscode.commands.registerCommand('codingAgent.deleteProfile', async () => {
      const profiles = ConfigManager.getAllProfiles();
      const items = profiles.map(p => ({
        label: p.name,
        description: `${p.provider} - ${p.model}`,
        profile: p,
      }));
      
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要删除的配置',
      });
      
      if (selected) {
        const confirm = await vscode.window.showWarningMessage(
          `确定要删除配置 "${selected.profile.name}" 吗？`,
          '确定', '取消'
        );
        if (confirm === '确定') {
          await ConfigManager.deleteProfile(selected.profile.id);
          vscode.window.showInformationMessage(`已删除配置: ${selected.profile.name}`);
          if (chatPanel) {
            chatPanel.refreshStatusBar();
          }
        }
      }
    })
  );
}

/**
 * 异步初始化配置（激活完成后执行，不阻塞命令注册）
 */
async function initializeConfig(context: vscode.ExtensionContext) {
  try {
    await ConfigManager.initDefaultProfiles();
    if (chatPanel) {
      chatPanel.refreshStatusBar();
    }
  } catch (err) {
    console.error('Config initialization error (non-fatal):', err);
  }
}

export function deactivate() {
  console.log('Coding Agent extension deactivated');
  if (chatPanel) {
    chatPanel.dispose();
  }
  if (agent) {
    agent.stop();
  }
}