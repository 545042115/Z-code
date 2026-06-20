import type { Cookie, PageSnapshot } from './backend';
import type { IMemoryProvider } from '@z-assistant/contracts';
export interface BrowserSession {
    id: string;
    /** Human-readable label for the session. */
    label: string;
    /** Current URL when the session was saved. */
    url: string;
    /** Cookies to restore. */
    cookies: Cookie[];
    /** LocalStorage key/value pairs. */
    localStorage: Record<string, string>;
    /** Timestamp. */
    savedAt: number;
    /** Tags for search. */
    tags: string[];
}
/**
 * Save the current browser page state (cookies + localStorage + URL)
 * to a memory-backed session record.
 */
export declare function saveSession(memory: IMemoryProvider, snapshot: PageSnapshot, cookies: Cookie[], label: string, tags?: string[]): Promise<BrowserSession>;
/**
 * Load a previously saved browser session from memory.
 */
export declare function loadSession(memory: IMemoryProvider, sessionId: string): Promise<BrowserSession | undefined>;
/**
 * List all saved browser sessions.
 */
export declare function listSessions(memory: IMemoryProvider): Promise<BrowserSession[]>;
/**
 * Delete a saved browser session.
 */
export declare function deleteSession(memory: IMemoryProvider, sessionId: string): Promise<boolean>;
//# sourceMappingURL=session.d.ts.map