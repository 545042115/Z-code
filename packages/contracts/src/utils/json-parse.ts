// Robust JSON parser for LLM responses.
//
// LLMs often wrap JSON in markdown fences, add prose before/after,
// or produce slightly malformed output. This utility tries multiple
// extraction strategies in order of reliability.

export type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Try to parse a JSON object from LLM output.
 * Tries: direct parse → strip markdown fences → first balanced {} block.
 */
export function parseJsonObject<T = unknown>(text: string): JsonParseResult<T> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty input' };
  }

  try {
    return { ok: true, value: JSON.parse(trimmed) as T };
  } catch { /* fall through */ }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenced) {
    try {
      return { ok: true, value: JSON.parse(fenced[1]) as T };
    } catch { /* fall through */ }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return { ok: true, value: JSON.parse(trimmed.slice(first, last + 1)) as T };
    } catch { /* fall through */ }
  }

  return { ok: false, error: 'no valid JSON found' };
}

/**
 * Try to parse a JSON array from LLM output.
 * Tries: direct parse → strip markdown fences → first balanced [] block.
 */
export function parseJsonArray<T = unknown>(text: string): JsonParseResult<T[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty input' };
  }

  try {
    const result = JSON.parse(trimmed);
    if (Array.isArray(result)) return { ok: true, value: result as T[] };
  } catch { /* fall through */ }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenced) {
    try {
      const result = JSON.parse(fenced[1]);
      if (Array.isArray(result)) return { ok: true, value: result as T[] };
    } catch { /* fall through */ }
  }

  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  if (first >= 0 && last > first) {
    try {
      const result = JSON.parse(trimmed.slice(first, last + 1));
      if (Array.isArray(result)) return { ok: true, value: result as T[] };
    } catch { /* fall through */ }
  }

  return { ok: false, error: 'no valid JSON array found' };
}

/**
 * Safely get a nested property from an unknown object.
 * Returns defaultValue if any step along the path is missing.
 */
export function getPath<T>(obj: unknown, path: string[], defaultValue: T): T {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== 'object') {
      return defaultValue;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return (current as T) ?? defaultValue;
}
