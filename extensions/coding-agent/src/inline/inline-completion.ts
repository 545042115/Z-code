import * as vscode from 'vscode';
import { LLMProvider, LLMProviderFactory } from '../llm/llm-provider';

/**
 * 行内代码补全提供者
 * 使用 FIM (Fill-In-the-Middle) 模式
 */

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private llm: LLMProvider;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 300;

  constructor() {
    this.llm = LLMProviderFactory.createFromVSCodeConfig();
    
    // 监听配置变更
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codingAgent.llm')) {
        this.llm = LLMProviderFactory.createFromVSCodeConfig();
      }
    });
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
    
    // 只在用户输入时触发，不接受建议时不触发
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      // 检查是否启用 Tab 补全
      const config = vscode.workspace.getConfiguration('codingAgent');
      if (!config.get<boolean>('enableTabCompletion', true)) {
        return undefined;
      }
    }

    // 防抖
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        try {
          const items = await this.generateCompletion(document, position, token);
          resolve(items);
        } catch {
          resolve(undefined);
        }
      }, this.DEBOUNCE_MS);

      // 如果请求被取消，清除定时器
      token.onCancellationRequested(() => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        resolve(undefined);
      });
    });
  }

  private async generateCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
    // 获取光标前后的代码
    const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const textAfter = document.getText(new vscode.Range(position, document.positionAt(document.getText().length)));

    // 限制上下文长度
    const maxContextLength = 2000;
    const prefix = textBefore.slice(-maxContextLength);
    const suffix = textAfter.slice(0, maxContextLength);

    // 检查是否应该提供补全
    if (!this.shouldProvideCompletion(prefix, suffix)) {
      return undefined;
    }

    try {
      // 使用 FIM 模式
      const completion = await this.llm.fimComplete({
        prefix,
        suffix,
        maxTokens: 128,
      });

      if (!completion || completion.trim().length === 0) {
        return undefined;
      }

      // 创建行内补全项
      const item = new vscode.InlineCompletionItem(
        completion,
        new vscode.Range(position, position)
      );

      // 添加命令，接受补全时触发
      item.command = {
        command: 'codingAgent.onCompletionAccepted',
        title: 'Completion Accepted',
        arguments: [document.uri, position, completion],
      };

      return [item];
    } catch (err) {
      console.error('Inline completion error:', err);
      return undefined;
    }
  }

  /**
   * 判断是否应提供补全
   */
  private shouldProvideCompletion(prefix: string, suffix: string): boolean {
    // 在字符串或注释中不提供补全
    const lastLine = prefix.split('\n').pop() || '';
    
    // 简单的启发式规则
    // 1. 不在行尾空格后补全
    if (lastLine.endsWith(' ') && lastLine.trim().length === 0) {
      return false;
    }

    // 2. 当前在字符串中
    const stringMatch = lastLine.match(/["'`]/g);
    if (stringMatch && stringMatch.length % 2 === 1) {
      return false;
    }

    // 3. 当前在注释中（简单判断）
    if (lastLine.trim().startsWith('//') || lastLine.trim().startsWith('#')) {
      return false;
    }

    return true;
  }
}

/**
 * 行内编辑提供者
 * 类似 Cursor 的 Cmd+K 行内编辑
 */
export class InlineEditProvider {
  private llm: LLMProvider;

  constructor() {
    this.llm = LLMProviderFactory.createFromVSCodeConfig();
    
    // 监听配置变更
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codingAgent.llm')) {
        this.llm = LLMProviderFactory.createFromVSCodeConfig();
      }
    });
  }

  /**
   * 执行行内编辑
   */
  async performInlineEdit(
    editor: vscode.TextEditor,
    instruction: string
  ): Promise<void> {
    const document = editor.document;
    const selection = editor.selection;
    
    // 获取选中的代码或当前行
    let selectedCode: string;
    let range: vscode.Range;

    if (!selection.isEmpty) {
      selectedCode = document.getText(selection);
      range = selection;
    } else {
      const line = document.lineAt(selection.active.line);
      selectedCode = line.text;
      range = line.range;
    }

    // 获取上下文
    const contextRange = new vscode.Range(
      Math.max(0, range.start.line - 5),
      0,
      Math.min(document.lineCount - 1, range.end.line + 5),
      document.lineAt(Math.min(document.lineCount - 1, range.end.line + 5)).text.length
    );
    const context = document.getText(contextRange);

    // 构建 Prompt
    const prompt = `You are a code editor. Modify the following code according to the instruction.

## Context
\`\`\`
${context}
\`\`\`

## Selected Code
\`\`\`
${selectedCode}
\`\`\`

## Instruction
${instruction}

## Response Format
Provide ONLY the modified code, without explanations or markdown formatting.`;

    try {
      // 显示进度
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: 'Generating edit...',
      }, async () => {
        const result = await this.llm.generate({
          messages: [
            { role: 'user', content: prompt },
          ],
        });

        // 清理结果
        const modifiedCode = this.cleanResult(result);

        // 应用编辑
        await editor.edit(editBuilder => {
          editBuilder.replace(range, modifiedCode);
        });

        // 显示成功消息
        vscode.window.showInformationMessage('Edit applied successfully');
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to generate edit: ${err}`);
    }
  }

  private cleanResult(result: string): string {
    // 移除 markdown 代码块
    let cleaned = result.trim();
    
    if (cleaned.startsWith('```')) {
      const lines = cleaned.split('\n');
      if (lines.length > 2) {
        cleaned = lines.slice(1, -1).join('\n');
      }
    }
    
    return cleaned.trim();
  }
}
