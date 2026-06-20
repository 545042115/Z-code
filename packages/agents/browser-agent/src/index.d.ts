export type { IBrowserBackend, BrowserViewport, BoundingBox, ElementInfo, PageSnapshot, BrowserAction, BrowserActionType, ActionResult, Cookie, } from './backend';
export { createPlaywrightBackend } from './backend';
export { buildDOMTree, findElementByText, findElementByTagAndText, findElementByAttrs, pageToText, } from './dom';
export type { DOMNode } from './dom';
export { BrowserAgent } from './agent';
export type { BrowserAgentConfig, BrowserStepResult } from './agent';
export { generateOverlayScript } from './overlay';
export { saveSession, loadSession, listSessions, deleteSession } from './session';
export type { BrowserSession } from './session';
//# sourceMappingURL=index.d.ts.map