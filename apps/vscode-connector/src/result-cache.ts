// @ziner/app-vscode-connector — Result cache for pure-query agent runs.
//
// Caches successful orchestrator results keyed by (model + agents + task)
// so that repeated questions like "What's the weather?" or "Latest news"
// don't trigger fresh LLM/search calls within the TTL window.

export interface ResultCacheOptions {
  ttlMs: number;
  maxSize: number;
}

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export class ResultCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  constructor(private readonly opts: ResultCacheOptions) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: re-insert to move to end (most recently used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // If key already exists, delete first so re-insert moves it to end
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.opts.maxSize) {
      // Evict the oldest (first inserted / least recently used) entry
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + this.opts.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/** Heuristic: only cache tasks that look like pure information queries. */
export function shouldCacheTask(task: string): boolean {
  const t = task.toLowerCase();
  const querySignals = [
    'weather', '天气', 'price', '价格', 'news', '新闻', 'latest', '最新',
    'what is', 'what are', '什么是', '怎么样', 'how to', 'how do', '怎么',
    'compare', '对比', 'summary', '总结', 'research', '调研',
  ];
  const mutationSignals = [
    'write', 'create', 'edit', 'delete', 'run', 'execute', 'modify', 'save',
    '写', '创建', '编辑', '删除', '运行', '执行', '修改', '保存', '打开网页',
  ];
  const queryScore = querySignals.filter((s) => t.includes(s)).length;
  const mutationScore = mutationSignals.filter((s) => t.includes(s)).length;
  return queryScore > 0 && queryScore >= mutationScore;
}
