export interface BrowserViewport {
    width: number;
    height: number;
    deviceScaleFactor?: number;
}
export interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface ElementInfo {
    /** Accessible element id (assigned by the backend). */
    id: number;
    /** The HTML tag name. */
    tag: string;
    /** The inner text (truncated to 200 chars). */
    text?: string;
    /** Attribute values useful for identification. */
    attrs: Record<string, string>;
    /** Bounding box relative to viewport. */
    box: BoundingBox;
    /** Whether this element is visible. */
    visible: boolean;
    /** Whether this element is interactive (button, a, input, etc.). */
    interactive: boolean;
    /** Child element ids for tree construction. */
    children: number[];
}
export interface PageSnapshot {
    url: string;
    title: string;
    /** Base64-encoded PNG screenshot. */
    screenshotBase64: string;
    /** Flat array of all elements on the page. */
    elements: ElementInfo[];
    /** Viewport size at snapshot time. */
    viewport: BrowserViewport;
    /** Timestamp of the snapshot. */
    timestamp: number;
}
export type BrowserActionType = 'click' | 'dblclick' | 'type' | 'scroll' | 'hover' | 'select' | 'navigate' | 'back' | 'forward' | 'reload' | 'wait' | 'screenshot' | 'press_key' | 'new_tab' | 'close_tab' | 'switch_tab';
export interface BrowserAction {
    type: BrowserActionType;
    /** Element id to act upon (for click/type/hover/select). */
    elementId?: number;
    /** Text to type (for type action). */
    text?: string;
    /** URL to navigate to (for navigate / new_tab). */
    url?: string;
    /** Key to press (for press_key). */
    key?: string;
    /** Tab index or id (for switch_tab). */
    tabIndex?: number;
    /** Scroll offset in pixels. */
    scrollX?: number;
    scrollY?: number;
    /** Wait duration in ms. */
    waitMs?: number;
}
export interface ActionResult {
    success: boolean;
    error?: string;
    /** Updated snapshot after the action (if the action caused navigation). */
    snapshot?: PageSnapshot;
}
export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
}
export interface IBrowserBackend {
    readonly name: string;
    /** Start the browser (headless by default). */
    start(headless?: boolean): Promise<void>;
    /** Open a new tab/page and navigate to the given URL. */
    navigate(url: string): Promise<PageSnapshot>;
    /** Get the current page's full snapshot. */
    snapshot(): Promise<PageSnapshot>;
    /** Execute a single action on the current page. */
    act(action: BrowserAction): Promise<ActionResult>;
    /** Get the current page URL. */
    url(): Promise<string>;
    /** Get the current page title. */
    title(): Promise<string>;
    /** Get/set cookies for the current page. */
    cookies(): Promise<Cookie[]>;
    setCookies(cookies: Cookie[]): Promise<void>;
    /** Clear browser data (cookies, local storage). */
    clearData(): Promise<void>;
    /** Open a new tab and optionally navigate to a URL. */
    newTab(url?: string): Promise<PageSnapshot>;
    /** Close the current tab. Returns snapshot of remaining page or undefined if last tab. */
    closeTab(): Promise<PageSnapshot | undefined>;
    /** Switch to a tab by index (0-based). */
    switchTab(index: number): Promise<PageSnapshot>;
    /** List all open tab URLs and titles. */
    listTabs(): Promise<Array<{
        index: number;
        url: string;
        title: string;
        active: boolean;
    }>>;
    /** Close the browser and release resources. */
    close(): Promise<void>;
}
export declare function createPlaywrightBackend(): IBrowserBackend;
//# sourceMappingURL=backend.d.ts.map