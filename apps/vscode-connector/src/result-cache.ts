// @z-assistant/app-vscode-connector — Result cache for pure-query agent runs.
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
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.opts.maxSize) {
      const first = this.store.keys().next().value;
      if (first) this.store.delete(first);
    }
    this.store.set(key, { value, expires: Date.now() + this.opts.ttlMs });
  }

  clear(): void {
    this.store.clear();
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
