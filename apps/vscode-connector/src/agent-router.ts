// @z-assistant/app-vscode-connector — Multi-Agent router helpers (P1-1).
//
// Provides lightweight intent-based routing so the Orchestrator can
// dispatch a task to the most appropriate registered agent instead of
// always using the generic chat agent.

import type { IAgent, IEmbeddingProvider, ModelSpec, TaskContext } from '@z-assistant/contracts';
import { SharedState } from '@z-assistant/runtime';
import type { AgentRegistry } from '@z-assistant/runtime';

export interface SelectAgentsOptions {
  /** Max agents to include in the dispatch list. Default 2. */
  maxAgents?: number;
  /** Fallback agent name when no agent scores above the threshold. */
  fallback?: string;
  /** Minimum score to consider an agent relevant. Default 0.2. */
  threshold?: number;
  /** Cache TTL in ms for routing results. Default 60_000. Set 0 to disable. */
  cacheTtlMs?: number;
  /**
   * Optional embedding provider. When provided, the router also scores each
   * agent's role+capabilities against the task embedding and blends the result
   * with the keyword score. This helps when keyword matching is noisy.
   */
  embeddingProvider?: IEmbeddingProvider;
}

interface CacheEntry {
  selected: string[];
  expires: number;
}

const routeCache = new Map<string, CacheEntry>();
const MAX_ROUTE_CACHE_SIZE = 500;

function normalizeTaskForCache(task: string): string {
  return task.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

function getCachedRoute(task: string, ttlMs: number): string[] | undefined {
  if (ttlMs <= 0) return undefined;
  const key = normalizeTaskForCache(task);
  const entry = routeCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    routeCache.delete(key);
    return undefined;
  }
  return entry.selected;
}

function setCachedRoute(task: string, selected: string[], ttlMs: number): void {
  if (ttlMs <= 0) return;
  if (routeCache.size >= MAX_ROUTE_CACHE_SIZE) {
    const first = routeCache.keys().next().value;
    if (first) routeCache.delete(first);
  }
  routeCache.set(normalizeTaskForCache(task), { selected, expires: Date.now() + ttlMs });
}

/**
 * Rank registered agents against the user task and return the best names.
 * Falls back to the chat agent for generic requests.
 * Results are cached for a short TTL to avoid repeated ranking of identical tasks.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export async function selectAgentsForTask(
  registry: AgentRegistry,
  task: string,
  model: ModelSpec,
  options?: SelectAgentsOptions,
): Promise<string[]> {
  const {
    maxAgents = 2,
    fallback = 'chat',
    threshold = 0.2,
    cacheTtlMs = 60_000,
    embeddingProvider,
  } = options ?? {};

  const cached = getCachedRoute(task, cacheTtlMs);
  if (cached) return cached;

  const ctx: TaskContext = {
    task,
    model,
    sessionId: '',
    userId: 'desktop-user',
    sharedState: new SharedState(),
    parentRunId: '',
    traceId: '',
    budget: { tokensLeft: Infinity, costLeftUsd: Infinity },
  };

  let ranked = await registry.rank(ctx);
  if (ranked.length === 0) {
    setCachedRoute(task, [fallback], cacheTtlMs);
    return [fallback];
  }

  if (embeddingProvider) {
    const taskEmbedding = await embeddingProvider.embed(task);
    const blended = await Promise.all(
      ranked.map(async (item) => {
        const capabilityText = `${item.agent.role} ${item.agent.capabilities.join(' ')}`;
        const agentEmbedding = await embeddingProvider.embed(capabilityText);
        const embeddingScore = cosineSimilarity(taskEmbedding, agentEmbedding);
        // Blend keyword score with embedding similarity so either signal can win.
        const keywordScore = item.score;
        const score = keywordScore * 0.5 + embeddingScore * 0.5;
        return { agent: item.agent, score, _debug: { keywordScore, embeddingScore } };
      }),
    );
    blended.sort((a, b) => b.score - a.score);
    // P1-1 debug log — show per-agent scores so mis-routing can be diagnosed
    // from a single log line. Off by default in production but always emitted
    // here so the trace panel can capture it.
    if (process.env.Z_ROUTER_DEBUG !== '0') {
      const breakdown = blended
        .map((b) =>
          `${b.agent.name}=${b.score.toFixed(2)}` +
          `(kw:${b._debug.keywordScore.toFixed(2)}+emb:${b._debug.embeddingScore.toFixed(2)})`,
        )
        .join(' | ');
      // eslint-disable-next-line no-console
      console.log(`[router] task="${task.slice(0, 60)}${task.length > 60 ? '…' : ''}" → ${breakdown}`);
    }
    ranked = blended;
  }

  const top = ranked[0];
  if (top.score < threshold) {
    setCachedRoute(task, [fallback], cacheTtlMs);
    return [fallback];
  }

  // Include additional agents only if their score is within a reasonable
  // margin of the top agent (multi-modal tasks like "搜索并总结网页").
  const selected = [top.agent.name];
  for (let i = 1; i < ranked.length && selected.length < maxAgents; i++) {
    if (ranked[i].score >= threshold && ranked[i].score >= top.score * 0.7) {
      selected.push(ranked[i].agent.name);
    }
  }
  setCachedRoute(task, selected, cacheTtlMs);
  return selected;
}
