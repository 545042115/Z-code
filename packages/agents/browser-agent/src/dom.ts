// @z-assistant/agent-browser — DOM parsing / element selection
//
// Utilities for converting a PageSnapshot's flat element array into a
// structured tree and for building CSS/XPath selectors from element info.

import type { ElementInfo, PageSnapshot } from './backend';

export interface DOMNode {
  element: ElementInfo;
  children: DOMNode[];
  depth: number;
}

/** Build a tree from a flat element list by spatial containment heuristics. */
export function buildDOMTree(snapshot: PageSnapshot): DOMNode[] {
  const elements = [...snapshot.elements];
  // Sort by area descending so parent elements (larger) are processed
  // before children (smaller). This ensures parent nodes exist in the
  // nodeMap when children need to find them.
  elements.sort((a, b) => {
    const areaA = a.box.width * a.box.height;
    const areaB = b.box.width * b.box.height;
    return areaB - areaA;
  });

  const roots: DOMNode[] = [];
  const nodeMap = new Map<number, DOMNode>();

  for (const el of elements) {
    const node: DOMNode = { element: el, children: [], depth: 0 };
    // Find the best parent (smallest containing element).
    let parent: DOMNode | null = null;
    for (const [, candidate] of nodeMap) {
      if (contains(candidate.element.box, el.box)) {
        if (!parent || area(candidate.element.box) < area(parent.element.box)) {
          parent = candidate;
        }
      }
    }
    if (parent) {
      parent.children.push(node);
      node.depth = parent.depth + 1;
    } else {
      roots.push(node);
    }
    nodeMap.set(el.id, node);
  }
  return roots;
}

/** Check if container box contains inner box. */
function contains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): boolean {
  return outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height;
}

function area(box: { width: number; height: number }): number {
  return box.width * box.height;
}

/** Find interactive element by text content (case-insensitive substring). */
export function findElementByText(snapshot: PageSnapshot, text: string): ElementInfo | undefined {
  const lower = text.toLowerCase();
  return snapshot.elements.find(
    (el) => el.interactive && el.text?.toLowerCase().includes(lower)
  );
}

/** Find element by its tag and text (exact match). */
export function findElementByTagAndText(snapshot: PageSnapshot, tag: string, text: string): ElementInfo | undefined {
  return snapshot.elements.find(
    (el) => el.tag === tag.toLowerCase() && el.text?.trim() === text
  );
}

/** Find element by CSS selector attributes (id, class, name, etc.). */
export function findElementByAttrs(snapshot: PageSnapshot, attrs: Record<string, string>): ElementInfo | undefined {
  return snapshot.elements.find((el) =>
    Object.entries(attrs).every(([k, v]) => el.attrs[k] === v)
  );
}

/** Generate a compact text representation of the page for LLM consumption. */
export function pageToText(snapshot: PageSnapshot, maxElements = 200): string {
  const lines: string[] = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`,
    `Interactive elements (showing up to ${maxElements}):`,
    '',
  ];
  const interactive = snapshot.elements
    .filter((el) => el.interactive && el.visible)
    .slice(0, maxElements);
  for (const el of interactive) {
    const attrs = Object.entries(el.attrs)
      .filter(([k]) => ['id', 'class', 'name', 'type', 'placeholder', 'aria-label', 'role', 'href', 'src', 'alt'].includes(k))
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const text = el.text ? ` "${el.text.slice(0, 60)}"` : '';
    const pos = ` [${el.box.x.toFixed(0)},${el.box.y.toFixed(0)} ${el.box.width.toFixed(0)}x${el.box.height.toFixed(0)}]`;
    lines.push(`  [${el.id}] <${el.tag}${attrs ? ` ${attrs}` : ''}>${text}${pos}`);
  }
  return lines.join('\n');
}
