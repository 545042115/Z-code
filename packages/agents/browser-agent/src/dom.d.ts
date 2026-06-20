import type { ElementInfo, PageSnapshot } from './backend';
export interface DOMNode {
    element: ElementInfo;
    children: DOMNode[];
    depth: number;
}
/** Build a tree from a flat element list by spatial containment heuristics. */
export declare function buildDOMTree(snapshot: PageSnapshot): DOMNode[];
/** Find interactive element by text content (case-insensitive substring). */
export declare function findElementByText(snapshot: PageSnapshot, text: string): ElementInfo | undefined;
/** Find element by its tag and text (exact match). */
export declare function findElementByTagAndText(snapshot: PageSnapshot, tag: string, text: string): ElementInfo | undefined;
/** Find element by CSS selector attributes (id, class, name, etc.). */
export declare function findElementByAttrs(snapshot: PageSnapshot, attrs: Record<string, string>): ElementInfo | undefined;
/** Generate a compact text representation of the page for LLM consumption. */
export declare function pageToText(snapshot: PageSnapshot, maxElements?: number): string;
//# sourceMappingURL=dom.d.ts.map