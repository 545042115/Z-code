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
      const uri = vscode.Uri.file(op.path);
      
      // 确保文件已打开
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        // 文件不存在，尝试创建
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        doc = await vscode.workspace.openTextDocument(uri);
      }

      const editor = await vscode.window.showTextDocument(doc);
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
      const success = await editor.edit(editBuilder => {
        editBuilder.replace(new vscode.Range(startPos, endPos), op.replace);
      });

      if (success) {
        // 5. 记录已应用
        this.appliedEdits.add(op.idempotentKey);
        
        // 6. 保存文件
        await doc.save();
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
      const uri = vscode.Uri.file(op.path);
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
    // 标准化：移除多余空白
    const normalize = (s: string) => 
      s.replace(/\s+/g, ' ').trim();
    
    const normalizedText = normalize(text);
    const normalizedPattern = normalize(pattern);
    
    const index = normalizedText.indexOf(normalizedPattern);
    if (index === -1) return -1;

    // 映射回原始文本位置
    let originalIndex = 0;
    let normalizedIndex = 0;
    
    for (let i = 0; i < text.length; i++) {
      if (normalizedIndex === index) {
        return originalIndex;
      }
      
      if (/\S/.test(text[i])) {
        normalizedIndex++;
      }
      originalIndex++;
    }

    return -1;
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
