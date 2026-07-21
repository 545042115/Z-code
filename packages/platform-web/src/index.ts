// @ziner/platform-web — Web/Mobile platform implementation.
//
// Provides concrete implementations of runtime-core interfaces
// using browser APIs (IndexedDB, fetch) and Capacitor plugins
// (for native mobile capabilities like notifications and haptics).
//
// This package is used by the Mobile (Capacitor) app.

export * from './IndexedDBStorage';
export * from './WebLLMProvider';
export * from './IndexedDBMemoryStore';
export * from './IndexedDBTraceStore';
export * from './WebMcpClient';
export * from './WebPlatformCapabilities';
export * from './MobileTools';
export * from './MobileSessionManager';
export * from './MobileCheckpointStore';

// Re-export concrete classes explicitly so bundlers can resolve named imports
// from the CommonJS build output.
export { MemoryManager } from './IndexedDBMemoryStore';
export { LLMProvider } from './WebLLMProvider';
