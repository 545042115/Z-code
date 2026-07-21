import type { AppSettings } from '@ziner/contracts';
import { DEFAULT_APP_SETTINGS } from '@ziner/contracts';

export type SettingsBackend = {
  load(): Promise<Partial<AppSettings> | null>;
  save(settings: AppSettings): Promise<void>;
};

export class SettingsManager {
  private cache: AppSettings | null = null;
  private pendingWrite: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEBOUNCE_MS = 200;

  constructor(private readonly backend: SettingsBackend) {}

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    const raw = await this.backend.load();
    this.cache = { ...DEFAULT_APP_SETTINGS, ...(raw ?? {}) } as AppSettings;
    return this.cache;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load();
    this.cache = { ...current, ...patch } as AppSettings;
    this.scheduleSave();
    return this.cache;
  }

  async flush(): Promise<void> {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = null;
    }
    if (this.cache) {
      await this.backend.save(this.cache);
    }
  }

  current(): AppSettings {
    if (!this.cache) {
      throw new Error('SettingsManager.load() must be called before current()');
    }
    return this.cache;
  }

  private scheduleSave(): void {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
    }
    this.pendingWrite = setTimeout(() => {
      void this.flush();
    }, SettingsManager.DEBOUNCE_MS);
  }
}

export class FileSettingsBackend implements SettingsBackend {
  constructor(private readonly getFilePath: () => string) {}

  async load(): Promise<Partial<AppSettings> | null> {
    try {
      const fs = await import('fs/promises');
      const raw = await fs.readFile(this.getFilePath(), 'utf-8');
      return JSON.parse(raw) as Partial<AppSettings>;
    } catch {
      return null;
    }
  }

  async save(settings: AppSettings): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const filePath = this.getFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}

export class LocalStorageSettingsBackend implements SettingsBackend {
  constructor(private readonly key: string) {}

  async load(): Promise<Partial<AppSettings> | null> {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(this.key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Partial<AppSettings>;
    } catch {
      return null;
    }
  }

  async save(settings: AppSettings): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.key, JSON.stringify(settings));
  }
}
