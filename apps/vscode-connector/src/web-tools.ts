// Web tools — web_search and web_fetch for the Chat Agent.
//
// Uses DuckDuckGo HTML search (no API key needed) and native fetch()
// for page content. Zero npm dependencies.

import * as http from 'node:http';
import * as https from 'node:https';

// ── Tool definitions (OpenAI function calling format) ────────────────

export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the web for real-time information. Use this when the user asks about current events, weather, news, live prices (hotels, flights, trains), or any topic that requires up-to-date information beyond your knowledge cutoff. ' +
    'For price lookups, search with a specific query such as "携程 上海外滩W酒店 今日价格" or "北京到上海 机票 2025-06-25".',
  argsSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query, e.g. "Shanghai weather today"',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results (default: 5, max: 10)',
      },
    },
    required: ['query'],
  },
};

export const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description:
    'Fetch and extract text content from a web page URL. Use this to read the full content of a page found via web_search. ' +
    'When looking for live prices (hotels, flights, trains), first use web_search to find a current results page, then use web_fetch to extract price details. ' +
    'If the fetched page is blocked, requires login, or lacks the price, switch to browser_navigate to interact with the site.',
  argsSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full URL to fetch, e.g. "https://example.com/article"',
      },
      maxLength: {
        type: 'number',
        description: 'Maximum characters to return (default: 5000)',
      },
    },
    required: ['url'],
  },
};

export const GET_LOCATION_TOOL = {
  name: 'get_location',
  description:
    'Get the approximate geographic location of the current machine based on its public IP address. ' +
    'Use this when the user asks for local services, navigation, weather, delivery, or payment options that depend on location. ' +
    'No arguments are required. Returns city, region, country, latitude/longitude and timezone.',
  argsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const CHAT_TOOLS = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL, GET_LOCATION_TOOL];

// ── HTTP helpers ──────────────────────────────────────────────────────

function fetchUrl(url: string, timeout = 30_000, extraHeaders: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          Referer: 'https://www.bing.com/',
          ...extraHeaders,
        },
        timeout,
      },
      (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          fetchUrl(redirectUrl, timeout).then(resolve).catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });
  });
}

async function fetchWithRetry(
  url: string,
  opts: { timeout?: number; retries?: number; delayMs?: number; headers?: Record<string, string> } = {}
): Promise<string> {
  const { timeout = 30_000, retries = 2, delayMs = 1_000, headers = {} } = opts;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchUrl(url, timeout, headers);
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error('fetch failed after retries');
}

// ── HTML stripping ────────────────────────────────────────────────────

function stripHtml(html: string, maxLength = 5000): string {
  // Remove script, style, nav, footer, header blocks
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

  // Block elements → newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|article|section|pre|blockquote)[^>]*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return text.slice(0, maxLength);
}

// ── DuckDuckGo search ─────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseBing(html: string, query: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const queryTerms = query
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  // Strategy 1: Bing desktop — <li class="b_algo">
  const algoRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = algoRegex.exec(html)) !== null) {
    const block = match[1];

    // Title + URL: <h2><a href="...">title</a></h2>
    const headingMatch = /<h2[^>]*>(?:<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>|<a[^>]*>([\s\S]*?)<\/a>)<\/h2>/i.exec(block);
    if (!headingMatch) continue;

    let url = (headingMatch[1] ?? '').replace(/&amp;/g, '&');
    const title = stripHtml(headingMatch[2] ?? headingMatch[3] ?? '', 200);

    // Bing sometimes uses relative redirect URLs starting with /search?q=
    if (url && !url.startsWith('http')) {
      const redirectMatch = /[?&]url=([^&]+)/i.exec(url);
      if (redirectMatch) {
        url = decodeURIComponent(redirectMatch[1]);
      } else if (url.startsWith('/')) {
        url = 'https://www.bing.com' + url;
      }
    }

    // Snippet: usually in <div class="b_caption"><p>...</p></div> or <p> directly
    const snippetMatch = /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
      || /<p>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1], 300) : '';

    if (!url || seen.has(url)) continue;

    // Relevance guard: at least one query term (>=2 chars) should appear in title or snippet
    const combined = `${title} ${snippet}`.toLowerCase();
    if (queryTerms.length > 0 && !queryTerms.some((t) => combined.includes(t))) {
      continue;
    }

    seen.add(url);
    results.push({ url, title, snippet });
  }

  return results;
}

function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Strategy 1: Modern DDG layout — articles with data-nrn attribute
  const articleRegex = /<article[^>]*data-nrn="result"[^>]*>([\s\S]*?)<\/article>/gi;
  let articleMatch;
  while ((articleMatch = articleRegex.exec(html)) !== null) {
    const block = articleMatch[1];
    // Extract heading link (title + URL)
    const headingMatch = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    // Extract snippet
    const snippetMatch = /<span[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
      || /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    if (headingMatch) {
      const url = headingMatch[1].replace(/&amp;/g, '&');
      if (!seen.has(url)) {
        seen.add(url);
        results.push({
          url,
          title: stripHtml(headingMatch[2], 200),
          snippet: snippetMatch ? stripHtml(snippetMatch[1], 300) : '',
        });
      }
    }
  }

  // Strategy 2: Classic DDG layout — result__a / result__snippet classes
  if (results.length === 0) {
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null) {
      const url = match[1].replace(/&amp;/g, '&');
      if (!seen.has(url)) {
        seen.add(url);
        results.push({
          url,
          title: stripHtml(match[2], 200),
          snippet: stripHtml(match[3], 300),
        });
      }
    }
  }

  // Strategy 3: Generic link + text extraction (fallback)
  if (results.length === 0) {
    const linkRegex = /<a[^>]*class="[^"]*result[^"]*"[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1].replace(/&amp;/g, '&');
      if (!seen.has(url) && !url.includes('duckduckgo.com')) {
        seen.add(url);
        results.push({
          url,
          title: stripHtml(match[2], 200),
          snippet: '',
        });
      }
    }
  }

  return results;
}

// ── Tool implementations ──────────────────────────────────────────────

export async function webSearch(query: string, maxResults = 5): Promise<string> {
  const encoded = encodeURIComponent(query);

  // Try Bing first (Chinese market, real browser headers), then fallback to DuckDuckGo.
  const bingUrl = `https://www.bing.com/search?q=${encoded}&setmkt=zh-CN&setlang=zh-Hans&FORM=QBRE`;
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;

  try {
    const html = await fetchWithRetry(bingUrl, {
      timeout: 30_000,
      retries: 2,
      delayMs: 1_500,
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const results = parseBing(html, query).slice(0, Math.min(maxResults, 10));
    if (results.length > 0) {
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
    }
  } catch {
    // Fall through to DuckDuckGo.
  }

  try {
    const html = await fetchWithRetry(ddgUrl, { timeout: 30_000, retries: 2, delayMs: 1_500 });
    const results = parseDuckDuckGo(html).slice(0, Math.min(maxResults, 10));
    if (results.length === 0) return `No results found for "${query}".`;
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `web_search error: ${msg}`;
  }
}

export async function webFetch(url: string, maxLength = 5000): Promise<string> {
  try {
    const html = await fetchWithRetry(url, { timeout: 30_000, retries: 1, delayMs: 1_000 });
    const text = stripHtml(html, maxLength);
    if (!text.trim()) return `No readable content found at ${url}.`;
    return text;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `web_fetch error: ${msg}`;
  }
}

export async function getLocation(): Promise<string> {
  try {
    const data = await fetchWithRetry('https://ipapi.co/json/', {
      timeout: 10_000,
      retries: 1,
      delayMs: 1_000,
    });
    const parsed = JSON.parse(data) as {
      city?: string;
      region?: string;
      country_name?: string;
      country_code?: string;
      latitude?: number;
      longitude?: number;
      timezone?: string;
      ip?: string;
    };
    const parts = [
      parsed.city,
      parsed.region,
      parsed.country_name,
    ].filter(Boolean);
    if (parts.length === 0) {
      return 'Could not determine location from IP address.';
    }
    const coords = parsed.latitude !== undefined && parsed.longitude !== undefined
      ? ` (${parsed.latitude}, ${parsed.longitude})`
      : '';
    return `Approximate location: ${parts.join(', ')}${coords}. Country code: ${parsed.country_code ?? 'unknown'}. Timezone: ${parsed.timezone ?? 'unknown'}.`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `get_location error: ${msg}`;
  }
}
