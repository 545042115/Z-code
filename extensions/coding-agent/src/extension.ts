import * as vscode from 'vscode';
import { AgentCore } from './agent/agent-core';
import { ChatPanel } from './panels/chat-panel';
import { ComposerPanel } from './panels/composer-panel';
import { InlineCompletionProvider, InlineEditProvider } from './inline/inline-completion';
import { ConfigManager } from './config/config-manager';
import { ChatViewProvider } from './panels/chat-view-provider';
import { ContextManager } from './context/context-manager';
import { WorkspaceScanner } from './context/workspace-scanner';
import { SymbolIndex } from './context/symbol-index';
import { Retrieval } from './context/retrieval';
import { RetrievalDebugger } from './debug/retrieval-debugger';
import { GitContextDebugger } from './debug/git-context-debugger';
import { VerificationDebugger } from './debug/verification-debugger';
import { AgentLoopDebugger } from './debug/agent-loop-debugger';
import { ToolUsageAnalyzer } from './debug/tool-usage-analyzer';
import { SkillValidator } from './skills/skill-validator';
import { TraceManager } from './trace';
import { createFileStore } from './infra/storage';
import { TracePanel } from './trace-ui/trace-panel';
import { Orchestrator, registerExampleAgents, PromptedAgent, AgentRegistry } from './multi-agent';
import { AgentLoopAdapter } from './multi-agent/agent-loop-adapter';
import { BudgetGuard } from './infra/cost';
import { loadConfig } from './infra/config';
import { EvolutionPanel } from './evolution/evolution-panel';
import { EvaluationsPanel } from './evaluation/evaluations-panel';

/**
 * Coding Agent 扩展入口
 */

let agent: AgentCore;
let inlineEditProvider: InlineEditProvider;
let chatPanel: ChatPanel;
let contextManager: ContextManager;
let retrievalDebugger: RetrievalDebugger;
let gitContextDebugger: GitContextDebugger;
let verificationDebugger: VerificationDebugger;
let agentLoopDebugger: AgentLoopDebugger;
let toolUsageAnalyzer: ToolUsageAnalyzer;
let chatViewProviderDisposable: vscode.Disposable | undefined;
let chatViewProvider: ChatViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  try {
    console.log('Coding Agent extension activating...');
    _extensionContext = context;

    // 初始化配置管理器
    ConfigManager.init(context);

    // 初始化共享 ContextManager（含 WorkspaceScanner + SymbolIndex + Retrieval）
    contextManager = new ContextManager();
    contextManager.memoryManager.init(context);
    initializeCodeIndex(context);

    // 初始化 Agent Core（传入共享 ContextManager）
    agent = new AgentCore(context, contextManager);
    inlineEditProvider = new InlineEditProvider();
    retrievalDebugger = new RetrievalDebugger(contextManager);
    gitContextDebugger = new GitContextDebugger(contextManager);
    verificationDebugger = new VerificationDebugger(contextManager);
    const loop = agent.getAgentLoop();
    if (loop) {
      agentLoopDebugger = new AgentLoopDebugger(loop);
    }
    const analyzer = agent.getToolUsageAnalyzer();
    if (analyzer) {
      toolUsageAnalyzer = analyzer;
    }

    // 初始化原生 ChatPanel（OutputChannel + StatusBar）
    chatPanel = ChatPanel.init(agent);

    // 注册侧边栏 WebviewView
    try {
      if (chatViewProviderDisposable) {
        chatViewProviderDisposable.dispose();
      }
      chatViewProvider = new ChatViewProvider(context.extensionUri, agent, context);
      chatViewProviderDisposable = vscode.window.registerWebviewViewProvider(
        ChatViewProvider.VIEW_TYPE,
        chatViewProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      );
      context.subscriptions.push(chatViewProviderDisposable);
    } catch (err) {
      if (chatViewProviderDisposable) {
        chatViewProviderDisposable.dispose();
        chatViewProviderDisposable = undefined;
      }
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
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('already registered')) {
      console.warn('View provider already registered (non-fatal):', errMsg);
    } else {
      console.error('Coding Agent activation error:', err);
      vscode.window.showErrorMessage(`Coding Agent 激活失败: ${err}`);
    }
  }
}

/**
 * 异步初始化代码索引（后台执行，不阻塞扩展激活）
 */
async function initializeCodeIndex(context: vscode.ExtensionContext) {
  try {
    await contextManager.initialize(context);
  } catch (err) {
    console.error('Code index initialization error (non-fatal):', err);
  }
}

/** V2 — shared TraceManager + Store (lazy-init on first use). */
let traceManager: TraceManager | undefined;
let traceStore: Awaited<ReturnType<typeof createFileStore>> | undefined;

async function getTraceManager(): Promise<TraceManager> {
  if (traceManager && traceStore) return traceManager;
  const ctx = await getExtensionContext();
  const storageDir = ctx.globalStorageUri.fsPath;
  const dataDir = require('path').join(storageDir, 'v2');
  const tracesDir = require('path').join(dataDir, 'traces');
  await require('fs/promises').mkdir(tracesDir, { recursive: true });
  traceStore = await createFileStore({ rootDir: dataDir });
  traceManager = new TraceManager({ store: traceStore, tracesDir });
  return traceManager;
}

// Cache the extension context; populated on activate.
let _extensionContext: vscode.ExtensionContext | undefined;
function getExtensionContext(): vscode.ExtensionContext {
  if (!_extensionContext) {
    throw new Error('extension not yet activated');
  }
  return _extensionContext!;
}

/**
 * V2 Multi-Agent quick start.
 * Prompts the user for a task, sets up the Orchestrator with the
 * example agents + an AgentLoopAdapter wrapping the current AgentCore,
 * then opens the Trace UI to show the result.
 */
async function runMultiAgentFlow(): Promise<void> {
  const task = await vscode.window.showInputBox({
    prompt: 'Describe the multi-agent task',
    placeHolder: 'e.g. 研究并实现一个最小 CLI 工具',
  });
  if (!task) return;

  const modePick = await vscode.window.showQuickPick(
    [
      { label: 'DAG', description: 'Topo-sorted waves based on dependencies' },
    ],
    { placeHolder: 'Select execution mode' },
  );
  if (!modePick) return;
  const mode = 'dag' as const;

  const tm = await getTraceManager();
  const { DEFAULT_CONFIG } = await import('./contracts');
  let cfg: typeof DEFAULT_CONFIG = DEFAULT_CONFIG;
  try {
    cfg = await loadConfig();
  } catch (e) {
    // V2 not fully configured yet; use safe defaults so the smoke
    // flow still works in dev.
  }
  // Use first available model from config; fall back to a free default
  const firstModel = Object.values((cfg as { models?: Record<string, { provider: string; name: string }> }).models ?? {})[0];
  const modelSpec: { provider: string; name: string } = firstModel ?? { provider: 'sglang', name: 'default' };
  const sessionId = `ma-${Date.now()}`;
  const tracker = await tm.startRun({ task, model: modelSpec, sessionId, userId: 'local' });

  // Registry: example agents (researcher / coder / reviewer) wrapped
  // in `PromptedAgent` so the *active* PromptVariant from Phase 5 A/B
  // testing is injected at execution time. If no candidate is yet
  // registered, the wrapper is a transparent pass-through.
  const registry = new AgentRegistry();
  registerExampleAgents(registry);
  // TODO Phase 2.6: wrap the live AgentCore as an IAgent via
  // AgentLoopAdapter. Deferred because AgentCore doesn't yet expose
  // a stable `executeTask(task)` entry point. The example trio is
  // sufficient for an end-to-end smoke test.

  // Budget from config (sane defaults if config not loaded)
  const budget = cfg.budget as { perRunTokens?: number; perRunUsd?: number; perDayUsd?: number } | undefined;
  const policy = {
    perRunTokens: budget?.perRunTokens ?? 1_000_000,
    perRunUsd: budget?.perRunUsd ?? 5,
    perDayUsd: budget?.perDayUsd ?? 50,
  };
  const guard = new BudgetGuard(policy);

  const orch = new Orchestrator({
    tracker, registry, task, model: modelSpec, sessionId,
    mode, budgetGuard: guard, maxAgentCalls: 8,
  });

  vscode.window.showInformationMessage(`[Z] Running ${mode} multi-agent…`);
  const result = await orch.run();
  await tracker.flush();
  await tracker.finish();

  vscode.window.showInformationMessage(
    `[Z] ${result.status} (${result.outputs.length} agents)`,
  );
  // Open the Trace UI on the just-finished run
  TracePanel.createOrShow(getExtensionContext().extensionUri, tm, tracker.id);
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

    // V2 — Trace UI
    vscode.commands.registerCommand('codingAgent.openTrace', async () => {
      try {
        const m = await getTraceManager();
        TracePanel.createOrShow(context.extensionUri, m);
      } catch (e) {
        vscode.window.showErrorMessage(`[Z Trace] ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // V2 — Multi-Agent Orchestrator
    vscode.commands.registerCommand('codingAgent.runMultiAgent', async () => {
      try {
        await runMultiAgentFlow();
      } catch (e) {
        vscode.window.showErrorMessage(`[Z Multi-Agent] ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // V2 — Evaluation Dashboard
    vscode.commands.registerCommand('codingAgent.openEvaluations', async () => {
      try {
        const m = await getTraceManager();
        EvaluationsPanel.createOrShow(context.extensionUri, m);
      } catch (e) {
        vscode.window.showErrorMessage(`[Z Evals] ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // V2 — Evolution
    vscode.commands.registerCommand('codingAgent.openEvolution', async () => {
      try {
        const m = await getTraceManager();
        EvolutionPanel.createOrShow(context.extensionUri, m);
      } catch (e) {
        vscode.window.showErrorMessage(`[Z Evolution] ${e instanceof Error ? e.message : String(e)}`);
      }
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
    }),

    // 导出会话
    vscode.commands.registerCommand('codingAgent.exportSession', async () => {
      if (chatViewProvider) {
        await chatViewProvider.handleExportSession();
      } else {
        vscode.window.showWarningMessage('Chat view not available.');
      }
    }),

    // Debug Retrieval: single query
    vscode.commands.registerCommand('codingAgent.debugRetrieval', async () => {
      if (!retrievalDebugger) {
        vscode.window.showWarningMessage('Retrieval debugger not initialized yet.');
        return;
      }
      await retrievalDebugger.runDebugQuery();
    }),

    // Evaluate Retrieval Quality: batch evaluation
    vscode.commands.registerCommand('codingAgent.evaluateRetrieval', async () => {
      if (!retrievalDebugger) {
        vscode.window.showWarningMessage('Retrieval debugger not initialized yet.');
        return;
      }
      await retrievalDebugger.runBatchEvaluation();
    }),

    // Debug Git Context: single query
    vscode.commands.registerCommand('codingAgent.debugGitContext', async () => {
      if (!gitContextDebugger) {
        vscode.window.showWarningMessage('Git context debugger not initialized yet.');
        return;
      }
      await gitContextDebugger.runDebug();
    }),

    // Debug Verification: run build/test/lint and show results
    vscode.commands.registerCommand('codingAgent.debugVerification', async () => {
      if (!verificationDebugger) {
        vscode.window.showWarningMessage('Verification debugger not initialized yet.');
        return;
      }
      await verificationDebugger.runDebug();
    }),

    // Debug Agent Loop: run plan → execute → verify → repair cycle
    vscode.commands.registerCommand('codingAgent.debugAgentLoop', async () => {
      if (!agentLoopDebugger) {
        vscode.window.showWarningMessage('Agent loop debugger not initialized yet.');
        return;
      }
      await agentLoopDebugger.runDebug();
    }),

    // Analyze Tool Usage: show tool usage report
    vscode.commands.registerCommand('codingAgent.analyzeToolUsage', async () => {
      if (!toolUsageAnalyzer) {
        vscode.window.showWarningMessage('Tool usage analyzer not initialized yet.');
        return;
      }

      const options = ['Last Execution Report', 'Aggregate Report (last 100)', 'Clear Records'];
      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select tool usage analysis type',
      });

      if (!selected) return;

      if (selected === 'Clear Records') {
        toolUsageAnalyzer.clearRecords();
        vscode.window.showInformationMessage('Tool usage records cleared.');
        return;
      }

      const report = selected === 'Last Execution Report'
        ? toolUsageAnalyzer.generateLastReport()
        : toolUsageAnalyzer.generateAggregateReport();

      // Show report in a new untitled document
      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: report,
      });
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Two,
      });
    }),

    // ========== Skill Management Commands ==========

    // Validate Skills: check all SKILL.md files for issues
    vscode.commands.registerCommand('codingAgent.validateSkills', async () => {
      if (!contextManager.skillManager) {
        vscode.window.showWarningMessage('Skill manager not initialized.');
        return;
      }

      const skills = contextManager.skillManager.getAllSkills();
      if (skills.length === 0) {
        vscode.window.showInformationMessage('No skills found in .skills/ directory.');
        return;
      }

      const validator = new SkillValidator();
      const result = validator.validateAll(skills);
      const report = validator.formatResult(result);

      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: `# Skill Validation Report\n\n${report}`,
      });
      await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.Two,
      });
    }),

    // Reload Skills: force refresh the skill index
    vscode.commands.registerCommand('codingAgent.reloadSkills', async () => {
      if (!contextManager.skillManager) {
        vscode.window.showWarningMessage('Skill manager not initialized.');
        return;
      }

      contextManager.skillManager.invalidateCache();
      const skills = contextManager.skillManager.getAllSkills();
      vscode.window.showInformationMessage(`Skills reloaded: ${skills.length} skill(s) found.`);
    }),

    // Show Active Skills: display all discovered skills
    vscode.commands.registerCommand('codingAgent.showActiveSkills', async () => {
      if (!contextManager.skillManager) {
        vscode.window.showWarningMessage('Skill manager not initialized.');
        return;
      }

      const skills = contextManager.skillManager.getAllSkills();
      if (skills.length === 0) {
        vscode.window.showInformationMessage('No skills found in .skills/ directory.');
        return;
      }

      const items = skills.map(s => ({
        label: s.name,
        description: `priority: ${s.priority}, mode: ${s.mode}`,
        detail: s.description || s.tags.join(', '),
      }));

      await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${skills.length} skill(s)`,
      });
    }),

    // Explain Skill Selection: explain why a skill was/wasn't selected
    vscode.commands.registerCommand('codingAgent.explainSkillSelection', async () => {
      if (!contextManager.skillManager) {
        vscode.window.showWarningMessage('Skill manager not initialized.');
        return;
      }

      const skills = contextManager.skillManager.getAllSkills();
      if (skills.length === 0) {
        vscode.window.showInformationMessage('No skills found in .skills/ directory.');
        return;
      }

      const skillItems = skills.map(s => ({
        label: s.name,
        description: s.id,
      }));

      const selectedSkill = await vscode.window.showQuickPick(skillItems, {
        placeHolder: 'Select a skill to explain',
      });

      if (!selectedSkill) return;

      const userInput = await vscode.window.showInputBox({
        prompt: 'Enter a user request to simulate skill selection',
        placeHolder: 'e.g., "帮我重构这个 React 组件"',
      });

      if (!userInput) return;

      const explanation = contextManager.skillManager.explainSelection(selectedSkill.description, {
        userRequest: userInput,
      });

      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: `# Skill Selection Explanation\n\nSkill: **${selectedSkill.label}**\nRequest: "${userInput}"\n\n${explanation}`,
      });
      await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.Two,
      });
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
  if (chatViewProviderDisposable) {
    chatViewProviderDisposable.dispose();
    chatViewProviderDisposable = undefined;
  }
  if (chatPanel) {
    chatPanel.dispose();
  }
  if (agent) {
    agent.stop();
  }
}
