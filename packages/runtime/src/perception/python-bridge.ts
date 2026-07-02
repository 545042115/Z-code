// @ziner/runtime — Python Bridge
//
// Manages a Python sidecar process for perception tasks (OCR, captioning,
// transcription, document parsing). Communicates via stdin/stdout JSON-lines.
//
// Supports two modes:
//   - Development: spawns `python3 perception_server.py`
//   - Packaged:    spawns `perception-server.exe` (PyInstaller bundle)
//
// The Python process is started lazily on the first call and kept alive
// until `close()` is called.

import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function isPackaged(): boolean {
  // Electron packaged app: process.resourcesPath is set
  // pkg/node SEA: __dirname doesn't contain 'node_modules'
  return !!(
    (process as any).resourcesPath ||
    (process as any).pkg ||
    !__dirname.includes('node_modules')
  );
}

function findSidecar(): string {
  // Packaged: sidecar is next to the app executable
  if (isPackaged()) {
    const resourcesPath = (process as any).resourcesPath || join(dirname(process.execPath), 'resources');
    const candidates = [
      join(resourcesPath, 'perception-server.exe'),
      join(resourcesPath, 'perception-server'),
      join(dirname(process.execPath), 'perception-server.exe'),
      join(dirname(process.execPath), 'perception-server'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  // Development: use Python script
  return '';
}

export class PythonBridge {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private closed = false;
  private pythonPath: string;
  private scriptPath: string;

  constructor(opts?: { pythonPath?: string; scriptPath?: string }) {
    const sidecar = findSidecar();
    if (sidecar) {
      // Packaged mode: use standalone exe
      this.pythonPath = '';
      this.scriptPath = sidecar;
    } else {
      // Development mode: use python3 + script
      this.pythonPath = opts?.pythonPath ?? 'python3';
      this.scriptPath = opts?.scriptPath ?? join(__dirname, '..', '..', 'python', 'perception_server.py');
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.proc) return;
    if (this.closed) throw new Error('PythonBridge is closed');

    return new Promise((resolve, reject) => {
      const args = this.pythonPath
        ? [this.scriptPath]  // python3 perception_server.py
        : [];                // perception-server.exe (no args)

      this.proc = spawn(this.pythonPath || this.scriptPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      const rl = createInterface({ input: this.proc.stdout! });
      rl.on('line', (line: string) => {
        line = line.trim();
        if (!line) return;
        try {
          const msg = JSON.parse(line);
          const pending = this.pending.get(msg.id);
          if (pending) {
            if (msg.error) pending.reject(new Error(msg.error));
            else pending.resolve(msg.result);
            this.pending.delete(msg.id);
          }
        } catch {
          // ignore malformed responses
        }
      });

      // Wait for "ready" signal from stderr
      this.proc.stderr!.on('data', (data: Buffer) => {
        const text = data.toString();
        if (text.includes('[perception_server] ready')) {
          resolve();
        }
      });

      this.proc.on('error', (err: Error) => {
        this.proc = null;
        reject(err);
      });

      this.proc.on('exit', (code: number | null) => {
        this.proc = null;
        for (const [, p] of this.pending) {
          p.reject(new Error(`Python process exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Timeout: if not ready in 15s, reject
      setTimeout(() => {
        if (!this.proc) return;
        reject(new Error('PythonBridge startup timeout'));
      }, 15000);
    });
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureStarted();
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, method, params }) + '\n';
      this.proc!.stdin!.write(msg, 'utf8');
    });
  }

  async ocr(imageBase64: string): Promise<string> {
    return (await this.call('ocr', { image: imageBase64 })) as string;
  }

  async caption(imageBase64: string): Promise<string> {
    return (await this.call('caption', { image: imageBase64 })) as string;
  }

  async transcribe(audioPath: string): Promise<string> {
    return (await this.call('transcribe', { audio: audioPath })) as string;
  }

  async parseDocument(filePath: string): Promise<string> {
    return (await this.call('parse_document', { path: filePath })) as string;
  }

  async ocrFile(filePath: string): Promise<string> {
    return (await this.call('ocr_file', { path: filePath })) as string;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error('PythonBridge closed'));
    }
    this.pending.clear();
  }
}
