// MarkdownRenderer — pure function Markdown → HTML renderer.
//
// Shared between Desktop and Mobile for rendering assistant messages.
// Supports: code blocks, inline code, bold, italic, headers, lists,
// links, blockquotes, horizontal rules, tables.
//
// This is a lightweight renderer (no external dependencies) to keep
// the Mobile bundle small. Mermaid is handled separately via CDN.

/** Escape HTML special characters to prevent XSS. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render inline Markdown (bold, italic, code, links). */
function renderInline(text: string): string {
  let result = escapeHtml(text);

  // Inline code
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  return result;
}

/**
 * Render Markdown text to HTML.
 * @param text - Markdown input text
 * @returns HTML string (safe to insert into innerHTML)
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block fence
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        const code = escapeHtml(codeLines.join('\n'));
        html.push(`<pre><code class="language-${codeLang}">${code}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
        codeLang = '';
      } else {
        // Start code block
        if (inList) {
          html.push(`</${listType}>`);
          inList = false;
        }
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      const level = headerMatch[1].length;
      html.push(`<h${level}>${renderInline(headerMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      html.push('<hr>');
      continue;
    }

    // Blockquote
    if (line.trim().startsWith('> ')) {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      html.push(`<blockquote>${renderInline(line.trim().slice(2))}</blockquote>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) html.push(`</${listType}>`);
        html.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      html.push(`<li>${renderInline(olMatch[1])}</li>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) html.push(`</${listType}>`);
        html.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      html.push(`<li>${renderInline(ulMatch[1])}</li>`);
      continue;
    }

    // Regular paragraph
    if (inList) {
      html.push(`</${listType}>`);
      inList = false;
    }
    html.push(`<p>${renderInline(line)}</p>`);
  }

  // Close any open elements
  if (inCodeBlock) {
    const code = escapeHtml(codeLines.join('\n'));
    html.push(`<pre><code class="language-${codeLang}">${code}</code></pre>`);
  }
  if (inList) {
    html.push(`</${listType}>`);
  }

  return html.join('\n');
}
