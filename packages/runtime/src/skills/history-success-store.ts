// @ziner/runtime — History Markdown Success Case Store (F-1).
//
// Parses desktop-style History/*.md conversation files and exposes the
// winding-but-successful ones through the ISuccessCaseStore contract.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ISuccessCaseStore,
  SuccessCase,
  SuccessCaseQuery,
  SuccessGroup,
} from '@ziner/contracts';

export interface HistorySuccessStoreOptions {
  /** Directory containing conversation history markdown files. */
  historyDir: string;
  /** Markers that indicate a user correction turn. */
  correctionMarkers?: string[];
  /** Markers that indicate the final assistant turn looks successful. */
  successMarkers?: string[];
}

interface ParsedConversation {
  filePath: string;
  title: string;
  turns: { role: 'user' | 'assistant'; content: string; timestamp?: string }[];
}

const DEFAULT_CORRECTION_MARKERS = [
  '不对', '错了', '没有', '不是', '你没有', '你没有根据', '你没有按',
  '重新', '再查', '不对，', 'no,', 'not quite', 'that is wrong',
  '你没有理解', '你没理解', '你没按', '你没根据',
];

const DEFAULT_SUCCESS_MARKERS = [
  '结果', '路线', '方案', '建议', '总结', '如下', '完成了', '搞定了',
];

interface ParsedFileCache {
  mtimeMs: number;
  conv: ParsedConversation;
}

export class HistoryMarkdownSuccessCaseStore implements ISuccessCaseStore {
  private readonly historyDir: string;
  private readonly correctionMarkers: string[];
  private readonly successMarkers: string[];
  private readonly fileCache = new Map<string, ParsedFileCache>();

  constructor(opts: HistorySuccessStoreOptions) {
    this.historyDir = opts.historyDir;
    this.correctionMarkers = opts.correctionMarkers ?? DEFAULT_CORRECTION_MARKERS;
    this.successMarkers = opts.successMarkers ?? DEFAULT_SUCCESS_MARKERS;
  }

  async record(_sc: SuccessCase): Promise<void> {
    // This read-only store derives cases from existing markdown files;
    // recording is a no-op. A real implementation could append metadata.
  }

  async list(q?: SuccessCaseQuery): Promise<SuccessCase[]> {
    const convs = this.parseAll();
    return convs
      .map((c) => this.toSuccessCase(c))
      .filter((c): c is SuccessCase => c !== null)
      .filter((c) => this.matchesQuery(c, q));
  }

  async count(q?: SuccessCaseQuery): Promise<number> {
    const list = await this.list(q);
    return list.length;
  }

  async group(q?: SuccessCaseQuery): Promise<SuccessGroup[]> {
    const cases = await this.list(q);
    const map = new Map<string, SuccessCase[]>();
    for (const sc of cases) {
      const key = this.groupKey(sc);
      const bucket = map.get(key) ?? [];
      bucket.push(sc);
      map.set(key, bucket);
    }

    const groups: SuccessGroup[] = [];
    for (const [key, bucket] of map.entries()) {
      const timestamps = bucket.map((c) => c.timestamp).sort((a, b) => a - b);
      groups.push({
        key,
        agent: bucket[0].agent,
        taskPattern: bucket[0].task,
        cases: bucket,
        firstSeen: timestamps[0] ?? Date.now(),
        lastSeen: timestamps[timestamps.length - 1] ?? Date.now(),
      });
    }
    return groups.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private parseAll(): ParsedConversation[] {
    if (!fs.existsSync(this.historyDir)) {
      this.fileCache.clear();
      return [];
    }
    const files = fs.readdirSync(this.historyDir).filter((f) => f.endsWith('.md'));
    const currentPaths = new Set(files.map((f) => path.join(this.historyDir, f)));

    // Remove cached entries for deleted files.
    for (const key of this.fileCache.keys()) {
      if (!currentPaths.has(key)) this.fileCache.delete(key);
    }

    return files
      .map((f) => this.parseFile(path.join(this.historyDir, f)))
      .filter((c): c is ParsedConversation => c !== null);
  }

  private parseFile(filePath: string): ParsedConversation | null {
    try {
      const stat = fs.statSync(filePath);
      const cached = this.fileCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.conv;
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n');
      const title = lines[0]?.replace(/^#\s*/, '').trim() || path.basename(filePath);
      const turns: ParsedConversation['turns'] = [];

      let currentRole: 'user' | 'assistant' | null = null;
      let currentContent: string[] = [];
      let currentTimestamp: string | undefined;

      const flush = () => {
        if (currentRole && currentContent.length > 0) {
          turns.push({
            role: currentRole,
            content: currentContent.join('\n').trim(),
            timestamp: currentTimestamp,
          });
        }
        currentRole = null;
        currentContent = [];
        currentTimestamp = undefined;
      };

      for (const line of lines) {
        const userMatch = line.match(/^\*\*You\*\*\s*\(([^)]*)\):\s*$/);
        const assistantMatch = line.match(/^\*\*Assistant\*\*\s*\(([^)]*)\):\s*$/);
        if (userMatch) {
          flush();
          currentRole = 'user';
          currentTimestamp = userMatch[1];
        } else if (assistantMatch) {
          flush();
          currentRole = 'assistant';
          currentTimestamp = assistantMatch[1];
        } else if (line.startsWith('---')) {
          // skip separators
        } else if (currentRole) {
          currentContent.push(line);
        }
      }
      flush();
      const conv = { filePath, title, turns };
      this.fileCache.set(filePath, { mtimeMs: stat.mtimeMs, conv });
      return conv;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[HistorySuccessStore] Failed to parse ${filePath}:`, err);
      return null;
    }
  }

  private toSuccessCase(conv: ParsedConversation): SuccessCase | null {
    const correctionCount = this.countCorrections(conv.turns);
    if (correctionCount === 0) return null;
    if (!this.looksLikeSuccess(conv.turns)) return null;

    const lastAssistant = [...conv.turns].reverse().find((t) => t.role === 'assistant');
    return {
      id: randomUUID(),
      timestamp: this.inferTimestamp(conv.turns),
      task: conv.title,
      conversationMarkdown: this.formatConversation(conv),
      turnCount: conv.turns.length,
      correctionCount,
      successOutcome: lastAssistant?.content.slice(0, 200),
      tags: ['history', 'winding-success'],
    };
  }

  private countCorrections(turns: ParsedConversation['turns']): number {
    return turns.filter(
      (t) =>
        t.role === 'user' &&
        this.correctionMarkers.some((m) => t.content.toLowerCase().includes(m.toLowerCase())),
    ).length;
  }

  private looksLikeSuccess(turns: ParsedConversation['turns']): boolean {
    const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
    if (!lastAssistant) return false;
    return this.successMarkers.some((m) => lastAssistant.content.includes(m));
  }

  private inferTimestamp(turns: ParsedConversation['turns']): number {
    const last = [...turns].reverse().find((t) => t.timestamp);
    if (last?.timestamp) {
      const parsed = Date.parse(last.timestamp);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return Date.now();
  }

  private formatConversation(conv: ParsedConversation): string {
    return conv.turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  }

  private groupKey(sc: SuccessCase): string {
    // Simple grouping by sanitized task title; can be improved with intent clustering.
    const sanitized = sc.task
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    return `success:${sanitized || 'unknown'}`;
  }

  private matchesQuery(c: SuccessCase, q?: SuccessCaseQuery): boolean {
    if (!q) return true;
    if (q.agent && c.agent !== q.agent) return false;
    if (q.taskPattern && !c.task.toLowerCase().includes(q.taskPattern.toLowerCase())) return false;
    if (q.fromTs !== undefined && c.timestamp < q.fromTs) return false;
    if (q.toTs !== undefined && c.timestamp > q.toTs) return false;
    if (q.minTurns !== undefined && c.turnCount < q.minTurns) return false;
    if (q.minCorrections !== undefined && c.correctionCount < q.minCorrections) return false;
    return true;
  }
}
