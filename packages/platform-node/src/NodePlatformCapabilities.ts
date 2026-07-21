// NodePlatformCapabilities — IPlatformCapabilities implementation for Desktop.
//
// Provides full platform capabilities including file system access,
// process execution, and Docker support.

import type { IPlatformCapabilities } from '@ziner/runtime-core';

export class NodePlatformCapabilities implements IPlatformCapabilities {
  async readFile(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async listFiles(dir: string): Promise<string[]> {
    const fs = await import('fs/promises');
    return fs.readdir(dir);
  }

  async exec(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { exec } = await import('child_process');
    return new Promise((resolve) => {
      exec(cmd, opts ?? {}, (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: error ? (error as NodeJS.ErrnoException).errno ?? 1 : 0,
        });
      });
    });
  }

  async dockerAvailable(): Promise<boolean> {
    try {
      const result = await this.exec('docker info');
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
