export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 2000;

export function truncateToolResult(text: string, max = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n...[truncated]';
}

export function compressToolResult(name: string, text: string, max = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;

  const isMcpList = /^mcp_/i.test(name)
    || /menu|catalogue|store|product|item|order|cart|route|amap|poi|hotel/i.test(name);
  if (isMcpList) {
    const expanded = max * 6;
    if (text.length <= expanded) return text;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const half = Math.floor(parsed.length / 2);
        const head = parsed.slice(0, half);
        const tail = parsed.slice(-Math.min(20, Math.floor(parsed.length / 4)));
        const summarized = JSON.stringify({
          _note: `Truncated: showing first ${head.length} of ${parsed.length} items and last ${tail.length}. Use pagination/filter parameters to see more.`,
          first: head,
          last: tail,
        });
        if (summarized.length <= expanded) return summarized;
      }
    } catch {
    }
    return truncateToolResult(text, expanded);
  }

  const lines = text.split('\n');
  if (name === 'run_terminal' || name === 'web_search') {
    const head = Math.ceil(max * 0.35 / lines.length) || 30;
    const tail = 20;
    if (lines.length > head + tail) {
      const kept = [...lines.slice(0, head), `...[${lines.length - head - tail} lines omitted]...`, ...lines.slice(-tail)];
      const compressed = kept.join('\n');
      if (compressed.length <= max) return compressed;
    }
  }

  if (name === 'web_fetch' || name === 'read_file' || name === 'search_code') {
    const headingLines = lines.filter((line) => /^#{1,6}\s+/.test(line) || /^```/.test(line));
    const body = lines.slice(0, Math.floor(max / 80));
    const compressed = [...headingLines.slice(0, 10), '---', ...body].join('\n');
    if (compressed.length <= max) return compressed;
  }

  return truncateToolResult(text, max);
}

export function parseXmlToolCalls(text: string): ParsedToolCall[] | null {
  if (text.includes('<｜｜DSML｜｜tool_calls>')) {
    return parseDsmlToolCalls(text);
  }

  const wrapperMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
  const invokeContent = wrapperMatch ? wrapperMatch[1] : text;
  const invokeRegex = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  const calls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = invokeRegex.exec(invokeContent)) !== null) {
    const name = match[1];
    const paramsText = match[2];
    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRegex.exec(paramsText)) !== null) {
      let value: string | number = pm[2].trim();
      const num = Number(value);
      if (!isNaN(num) && value !== '') value = num;
      args[pm[1]] = value;
    }
    calls.push({ name, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}

export function parseDsmlToolCalls(text: string): ParsedToolCall[] | null {
  const wrapperMatch = text.match(/<｜｜DSML｜｜tool_calls>([\s\S]*?)<\/｜｜DSML｜｜tool_calls>/);
  const invokeContent = wrapperMatch ? wrapperMatch[1] : text;
  const invokeRegex = /<｜｜DSML｜｜invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  const calls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = invokeRegex.exec(invokeContent)) !== null) {
    const name = match[1];
    const paramsText = match[2];
    const args: Record<string, unknown> = {};
    const paramRegex = /<｜｜DSML｜｜parameter\s+name="([^"]+)"(?:\s+(string|number)="true")?\s*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRegex.exec(paramsText)) !== null) {
      const paramName = pm[1];
      const paramType = pm[2];
      const rawValue = pm[3].trim();
      if (paramType === 'number') {
        const num = Number(rawValue);
        args[paramName] = !isNaN(num) && rawValue !== '' ? num : rawValue;
      } else {
        args[paramName] = rawValue;
      }
    }
    calls.push({ name, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}
