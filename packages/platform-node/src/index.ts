// @ziner/platform-node — Node.js platform implementation.
//
// Provides concrete implementations of runtime-core interfaces
// using Node.js built-in modules (fs, path, child_process) and
// native addons (better-sqlite3).
//
// This package is used by the Desktop (Electron) app.

export * from './NodeStorage';
export * from './NodePlatformCapabilities';
export * from './NodeMemoryStore';
export * from './FileTraceStore';
export * from './FileSessionStore';
export * from './DesktopSessionManager';
