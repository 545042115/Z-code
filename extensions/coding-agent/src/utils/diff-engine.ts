import * as path from 'path';
import * as vscode from 'vscode';
import { EditOperation } from '../agent/agent-core';

/**
 * Diff 引擎
 * 严格遵循 AGENT_SPEC.md 规范：
 * - 编辑操作必须幂等
 * - 流式 Diff 渲染支持
 * - 精确匹配 + 模糊匹配兜底
 */

export class DiffEngine {
  // 已应用的编辑记录（用于幂等性检查）
  private appliedEdits: Set<string> = new Set();

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

  /**
   * 应用编辑操作（幂等）
   */
  async applyEdit(op: EditOperation): Promise<boolean> {
    // 1. 幂等性检查
    if (this.appliedEdits.has(op.idempotentKey)) {
      console.log(`Edit ${op.idempotentKey} already applied, skipping`);
      return true;
    }

    try {
      const resolvedPath = this.resolveWorkspacePath(op.path);
      const uri = vscode.Uri.file(resolvedPath);

      // 检查文件是否存在
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(uri);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      // 创建新文件：当 search 为空时，直接写入 replace 内容
      if (!fileExists || !op.search) {
        const encoder = new TextEncoder();
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolvedPath)));
        await vscode.workspace.fs.writeFile(uri, encoder.encode(op.replace));
        this.appliedEdits.add(op.idempotentKey);
        return true;
      }

      // 修改已有文件：search/replace 模式
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullText = doc.getText();

      // 2. 精确匹配
      let matchIndex = fullText.indexOf(op.search);

      // 3. 模糊匹配兜底
      if (matchIndex === -1) {
        matchIndex = this.fuzzySearch(fullText, op.search);
      }

      if (matchIndex === -1) {
        throw new Error(`Search pattern not found in ${op.path}`);
      }

      const startPos = doc.positionAt(matchIndex);
      const endPos = doc.positionAt(matchIndex + op.search.length);

      // 4. 执行编辑
      const success = await vscode.workspace.openTextDocument(uri).then(async (d) => {
        const editor = await vscode.window.showTextDocument(d);
        const result = await editor.edit(editBuilder => {
          editBuilder.replace(new vscode.Range(startPos, endPos), op.replace);
        });
        if (result) {
          await d.save();
        }
        return result;
      });

      if (success) {
        // 5. 记录已应用
        this.appliedEdits.add(op.idempotentKey);
      }

      return success;
    } catch (err) {
      console.error(`Failed to apply edit: ${err}`);
      throw err;
    }
  }

  /**
   * 批量应用编辑
   */
  async applyEdits(ops: EditOperation[]): Promise<{ success: boolean; failed: EditOperation[] }> {
    const failed: EditOperation[] = [];

    for (const op of ops) {
      try {
        await this.applyEdit(op);
      } catch {
        failed.push(op);
      }
    }

    return { success: failed.length === 0, failed };
  }

  /**
   * 预览编辑（不实际应用）
   */
  async previewEdit(op: EditOperation): Promise<DiffPreview | null> {
    try {
      const resolvedPath = this.resolveWorkspacePath(op.path);
      const uri = vscode.Uri.file(resolvedPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const original = doc.getText();

      let matchIndex = original.indexOf(op.search);
      if (matchIndex === -1) {
        matchIndex = this.fuzzySearch(original, op.search);
      }

      if (matchIndex === -1) return null;

      const before = original.substring(0, matchIndex);
      const after = original.substring(matchIndex + op.search.length);
      const modified = before + op.replace + after;

      return {
        path: op.path,
        original: op.search,
        modified: op.replace,
        lineStart: doc.positionAt(matchIndex).line,
        lineEnd: doc.positionAt(matchIndex + op.search.length).line,
      };
    } catch {
      return null;
    }
  }

  /**
   * 模糊搜索（处理缩进、空白字符差异）
   */
  private fuzzySearch(text: string, pattern: string): number {
    // 标准化：将连续空白替换为单个空格，并去除首尾空白
    const normalize = (s: string) =>
      s.replace(/\s+/g, ' ').trim();

    const normalizedText = normalize(text);
    const normalizedPattern = normalize(pattern);

    const index = normalizedText.indexOf(normalizedPattern);
    if (index === -1) return -1;

    // 构建归一化文本中每个字符位置 → 原始文本位置的映射表
    const normToOriginal: number[] = [];

    // 跳过原始文本前导空白（对应 normalize 的 trim）
    let i = 0;
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }

    // 遍历原始文本，按归一化规则（连续空白→单个空格）建立映射
    while (i < text.length) {
      if (/\s/.test(text[i])) {
        // 连续空白归一化为一个空格字符，映射到第一个空白字符的位置
        normToOriginal.push(i);
        while (i + 1 < text.length && /\s/.test(text[i + 1])) {
          i++;
        }
      } else {
        normToOriginal.push(i);
      }
      i++;
    }

    if (index >= normToOriginal.length) return -1;
    return normToOriginal[index];
  }

  /**
   * 计算 Myers Diff
   */
  computeDiff(original: string, modified: string): DiffHunk[] {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    
    // 简化的 LCS 实现
    const hunks: DiffHunk[] = [];
    let i = 0, j = 0;

    while (i < originalLines.length || j < modifiedLines.length) {
      if (i < originalLines.length && j < modifiedLines.length && 
          originalLines[i] === modifiedLines[j]) {
        i++;
        j++;
      } else {
        const hunk: DiffHunk = {
          originalStart: i,
          originalCount: 0,
          modifiedStart: j,
          modifiedCount: 0,
          lines: [],
        };

        // 收集删除的行
        while (i < originalLines.length && 
               (j >= modifiedLines.length || originalLines[i] !== modifiedLines[j])) {
          hunk.lines.push({ type: 'delete', text: originalLines[i] });
          i++;
          hunk.originalCount++;
        }

        // 收集新增的行
        while (j < modifiedLines.length && 
               (i >= originalLines.length || originalLines[i] !== modifiedLines[j])) {
          hunk.lines.push({ type: 'add', text: modifiedLines[j] });
          j++;
          hunk.modifiedCount++;
        }

        hunks.push(hunk);
      }
    }

    return hunks;
  }

  /**
   * 清除已应用记录（用于重置）
   */
  clearAppliedEdits(): void {
    this.appliedEdits.clear();
  }
}

export interface DiffPreview {
  path: string;
  original: string;
  modified: string;
  lineStart: number;
  lineEnd: number;
}

export interface DiffHunk {
  originalStart: number;
  originalCount: number;
  modifiedStart: number;
  modifiedCount: number;
  lines: Array<{ type: 'add' | 'delete' | 'context'; text: string }>;
}
