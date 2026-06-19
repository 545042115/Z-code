// Chat Profile — collects the user's own chat messages across QQ / WeChat,
// builds a lightweight style profile, and saves everything to disk so the
// Chat Agent can mimic the user's tone, cadence, and emoji habits.

import * as fs from 'fs';
import * as path from 'path';

const MAX_STORED = 500;

export interface StyledMessage {
  text: string;
  source: 'qq' | 'wechat';
  timestamp: number;
}

export interface StyleProfile {
  /** Average message length in characters */
  avgLength: number;
  /** Median message length */
  medianLength: number;
  /** Top 10 most used emojis */
  topEmojis: string[];
  /** Typical opening words (first 2 chars of messages) */
  commonStarters: string[];
  /** Typical closing patterns (last 3 chars) */
  commonEnders: string[];
  /** Short text description generated from stats */
  description: string;
  /** When this profile was last updated */
  updatedAt: number;
}

// ── Emoji extraction helper ─────────────────────────────────────
const EMOJI_RE = /[\u{1F000}-\u{1FFFF}]|[\u2600-\u27BF]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]|[\uD800-\uDBFF][\uDC00-\uDFFF]/gu;

function extractEmojis(text: string): string[] {
  return text.match(EMOJI_RE) ?? [];
}

function topK<T>(items: T[], k: number): T[] {
  const freq = new Map<T, number>();
  for (const item of items) {
    freq.set(item, (freq.get(item) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([item]) => item);
}

export class ChatProfile {
  private _messages: StyledMessage[] = [];
  private _profile: StyleProfile | null = null;
  private _storePath: string;

  constructor(storageDir: string) {
    this._storePath = path.join(storageDir, 'chat-profile.json');
    this._load();
  }

  // ── Public API ────────────────────────────────────────────────

  /** All stored messages (read-only). */
  get messages(): readonly StyledMessage[] {
    return this._messages;
  }

  /** Current style profile. */
  get profile(): StyleProfile | null {
    return this._profile;
  }

  /** Number of stored messages. */
  get count(): number {
    return this._messages.length;
  }

  /** Add one message from the user. */
  add(text: string, source: 'qq' | 'wechat', timestamp?: number): void {
    const msg: StyledMessage = { text, source, timestamp: timestamp ?? Date.now() };
    this._messages.push(msg);

    // Keep rolling window
    if (this._messages.length > MAX_STORED) {
      this._messages = this._messages.slice(-MAX_STORED);
    }

    this._save();
    // Regenerate profile every 10 new messages
    if (this._messages.length % 10 === 0) {
      this._buildProfile();
      this._save();
    }
  }

  /** Add multiple historical messages at once (e.g. imported from file). */
  addBatch(messages: StyledMessage[]): void {
    this._messages.push(...messages);
    if (this._messages.length > MAX_STORED) {
      this._messages = this._messages.slice(-MAX_STORED);
    }
    this._buildProfile();
    this._save();
  }

  /** Force rebuild profile immediately. */
  rebuild(): StyleProfile {
    this._buildProfile();
    this._save();
    return this._profile!;
  }

  /** Clear all stored data. */
  clear(): void {
    this._messages = [];
    this._profile = null;
    this._save();
  }

  // ── Private ───────────────────────────────────────────────────

  private _buildProfile(): void {
    if (this._messages.length === 0) {
      this._profile = null;
      return;
    }

    const texts = this._messages.map((m) => m.text).filter(Boolean);
    if (texts.length === 0) {
      this._profile = null;
      return;
    }

    const lengths = texts.map((t) => t.length);
    const sorted = [...lengths].sort((a, b) => a - b);
    const avg = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Emojis
    const allEmojis = texts.flatMap(extractEmojis);
    const topEmojis = topK(allEmojis, 10);

    // Starters: first 2 characters (trimmed)
    const starters = texts
      .map((t) => t.trim().slice(0, 2))
      .filter(Boolean);
    const commonStarters = topK(starters, 8);

    // Enders: last 3 characters
    const enders = texts
      .map((t) => {
        const trimmed = t.trim();
        return trimmed.length > 2 ? trimmed.slice(-3) : trimmed;
      })
      .filter(Boolean);
    const commonEnders = topK(enders, 8);

    // Build description
    const parts: string[] = [];
    if (avg < 15) parts.push('常用短句');
    else if (avg < 40) parts.push('句子长度适中');
    else parts.push('常用长句');

    if (allEmojis.length > 0) {
      const emojiRatio = Math.round((allEmojis.length / texts.length) * 100);
      if (emojiRatio > 50) parts.push('频繁使用表情');
      else if (emojiRatio > 20) parts.push('偶尔使用表情');
      if (topEmojis.length > 0) parts.push(`常用表情: ${topEmojis.slice(0, 4).join('')}等`);
    }

    let description = parts.join('，') + '。';

    if (commonStarters.length > 0) {
      description += ` 常用开头: ${commonStarters.slice(0, 4).map((s) => `"${s}"`).join('、')}。`;
    }
    if (commonEnders.length > 0) {
      description += ` 常用收尾: ${commonEnders.slice(0, 4).map((s) => `"${s}"`).join('、')}。`;
    }
    description += ` （基于${texts.length}条历史消息分析）`;

    this._profile = {
      avgLength: avg,
      medianLength: median,
      topEmojis,
      commonStarters,
      commonEnders,
      description,
      updatedAt: Date.now(),
    };
  }

  private _load(): void {
    try {
      if (!fs.existsSync(this._storePath)) return;
      const raw = fs.readFileSync(this._storePath, 'utf-8');
      const data = JSON.parse(raw);
      this._messages = data.messages ?? [];
      this._profile = data.profile ?? null;
    } catch {
      // Corrupted file — silently reset
      this._messages = [];
      this._profile = null;
    }
  }

  private _save(): void {
    try {
      const dir = path.dirname(this._storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._storePath, JSON.stringify({ messages: this._messages, profile: this._profile }), 'utf-8');
    } catch (e: any) {
      console.error('[ChatProfile] Save failed:', e.message);
    }
  }
}
