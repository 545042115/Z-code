// NodeStorage — IStorage implementation using Node.js fs.
// Stores key-value pairs as JSON files in a directory.

import type { IStorage } from '@ziner/runtime-core';

export class NodeStorage implements IStorage {
  private dir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');
      const filePath = path.join(this.dir, `${key}.json`);
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const path = await import('path');
    const fs = await import('fs/promises');
    const filePath = path.join(this.dir, `${key}.json`);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(filePath, value, 'utf-8');
  }

  async delete(key: string): Promise<boolean> {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');
      const filePath = path.join(this.dir, `${key}.json`);
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix?: string): Promise<string[]> {
    try {
      const fs = await import('fs/promises');
      const files = await fs.readdir(this.dir);
      const keys = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    } catch {
      return [];
    }
  }
}
