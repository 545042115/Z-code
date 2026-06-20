// Task execution tools for the Desktop Chat Agent.
//
// Implements file operations, shell commands, code search, and
// directory browsing using only Node.js built-in modules.
// No VSCode dependency — works in standalone Desktop mode.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);

// ── Path sandboxing ─────────────────────────────────────────────────────

let _projectDir = process.cwd();

export function setProjectDir(dir: string): void {
  _projectDir = path.resolve(dir);
  if (!fs.existsSync(_projectDir)) {
    fs.mkdirSync(_projectDir, { recursive: true });
  }
}

export function getProjectDir(): string {
  return _projectDir;
}

function resolvePath(userPath: string): string {
  // Allow absolute paths as long as they're inside the project dir
  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(_projectDir, userPath);
  const norm = path.normalize(resolved);
  const projectNorm = path.resolve(_projectDir);

  // Allow paths inside the project directory
  if (norm.startsWith(projectNorm)) {
    return norm;
  }

  // Also allow paths under common user directories (Desktop, Documents, Downloads, etc.)
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  if (homeDir) {
    const homeNorm = path.resolve(homeDir);
    if (norm.startsWith(homeNorm)) {
      return norm;
    }
  }

  throw new Error(`Access denied: path "${userPath}" is outside the project directory`);
}

// ── Tool definitions (OpenAI function calling format) ──────────────────

export const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read the content of a file. Returns the full content with line numbers.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file (relative to project dir, or absolute)',
      },
      startLine: {
        type: 'number',
        description: 'Optional start line number (1-based)',
      },
      lineCount: {
        type: 'number',
        description: 'Optional number of lines to read from startLine',
      },
    },
    required: ['filePath'],
  },
};

export const WRITE_FILE_TOOL = {
  name: 'write_file',
  description:
    'Write content to a file. Creates the file if it does not exist. Use for creating new files or completely overwriting existing ones. For surgical edits, prefer replace_text.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file',
      },
      content: {
        type: 'string',
        description: 'Full file content to write',
      },
    },
    required: ['filePath', 'content'],
  },
};

export const REPLACE_TEXT_TOOL = {
  name: 'replace_text',
  description:
    'Replace text in an existing file. First searches for oldText in the file, then replaces it with newText. Use for surgical edits instead of write_file.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file',
      },
      oldText: {
        type: 'string',
        description: 'The exact text to search for and replace',
      },
      newText: {
        type: 'string',
        description: 'The new text to insert in place of oldText',
      },
    },
    required: ['filePath', 'oldText', 'newText'],
  },
};

export const APPEND_TEXT_TOOL = {
  name: 'append_text',
  description: 'Append text to the end of a file. Creates the file if it does not exist.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file',
      },
      content: {
        type: 'string',
        description: 'Text to append',
      },
    },
    required: ['filePath', 'content'],
  },
};

export const INSERT_TEXT_TOOL = {
  name: 'insert_text',
  description:
    'Insert text before or after an anchor text in a file. Use "before" or "after" mode.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file',
      },
      anchorText: {
        type: 'string',
        description: 'The anchor text to insert before/after',
      },
      newText: {
        type: 'string',
        description: 'The text to insert',
      },
      mode: {
        type: 'string',
        enum: ['before', 'after'],
        description: 'Insert before or after the anchor',
      },
    },
    required: ['filePath', 'anchorText', 'newText', 'mode'],
  },
};

export const RUN_TERMINAL_TOOL = {
  name: 'run_terminal',
  description:
    'Execute a shell command in the project directory. Returns stdout and stderr. Use for running build commands, git operations, or any terminal task.',
  argsSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory (default: project dir)',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['command'],
  },
};

export const SEARCH_CODE_TOOL = {
  name: 'search_code',
  description:
    'Search for text or regex patterns across files in the project. Returns file paths and matching lines.',
  argsSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Text or regex pattern to search for',
      },
      filePattern: {
        type: 'string',
        description: 'Optional file glob pattern, e.g. "*.ts", "*.{ts,js}"',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results to return (default: 20)',
      },
    },
    required: ['pattern'],
  },
};

export const LIST_DIRECTORY_TOOL = {
  name: 'list_directory',
  description:
    'List files and directories in a path. Shows name, size, and last modified date for each entry.',
  argsSchema: {
    type: 'object',
    properties: {
      dirPath: {
        type: 'string',
        description: 'Directory path (default: project root)',
      },
      depth: {
        type: 'number',
        description: 'Recursion depth (default: 1, max: 3)',
      },
    },
    required: [],
  },
};

export const GET_PROJECT_CONTEXT_TOOL = {
  name: 'get_project_context',
  description:
    'Get an overview of the project structure: top-level directories, key files, and their sizes.',
  argsSchema: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'Detail level (default: summary)',
      },
    },
    required: [],
  },
};

// ── All tools array ────────────────────────────────────────────────────

export const TASK_TOOLS = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  REPLACE_TEXT_TOOL,
  APPEND_TEXT_TOOL,
  INSERT_TEXT_TOOL,
  RUN_TERMINAL_TOOL,
  SEARCH_CODE_TOOL,
  LIST_DIRECTORY_TOOL,
  GET_PROJECT_CONTEXT_TOOL,
];

// ── Dangerous command patterns (blocked) ──────────────────────────────

const DANGEROUS_PATTERNS = [
  /^rm\s+-rf\s+[/\\]/i,
  /^rm\s+--recursive/i,
  /^format\s+/i,
  /^mkfs/i,
  /^dd\s+/i,
  /:(){ :\|:& };:/,   // fork bomb
  /^shutdown/i,
  /^reboot/i,
  /^git\s+push\s+--force/i,
];

function isDangerous(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd.trim()));
}

// ── Tool implementations ───────────────────────────────────────────────

export async function readFile(
  filePath: string,
  startLine?: number,
  lineCount?: number
): Promise<string> {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return `Error: Not a file: ${filePath}`;
  }
  // Limit to 10MB
  if (stat.size > 10 * 1024 * 1024) {
    return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 10MB.`;
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  let slice = lines;
  if (startLine !== undefined) {
    const start = Math.max(0, startLine - 1);
    const count = lineCount ?? totalLines;
    slice = lines.slice(start, start + count);
  }

  const numbered = slice.map((line, i) => {
    const lineNum = (startLine ?? 1) + i;
    return `${String(lineNum).padStart(5, ' ')}| ${line}`;
  });

  return numbered.join('\n');
}

export async function writeFile(filePath: string, content: string): Promise<string> {
  const resolved = resolvePath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, content, 'utf-8');
  return `File written: ${filePath} (${content.length} chars)`;
}

export async function replaceText(
  filePath: string,
  oldText: string,
  newText: string
): Promise<string> {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  if (!content.includes(oldText)) {
    return `Error: oldText not found in file. Searched for:\n---\n${oldText}`;
  }
  const replaced = content.replace(oldText, newText);
  const changes = content.split(oldText).length - 1;
  fs.writeFileSync(resolved, replaced, 'utf-8');
  return `Replaced ${changes} occurrence(s) in ${filePath}.`;
}

export async function appendText(filePath: string, content: string): Promise<string> {
  const resolved = resolvePath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(resolved, content, 'utf-8');
  return `Appended ${content.length} chars to ${filePath}.`;
}

export async function insertText(
  filePath: string,
  anchorText: string,
  newText: string,
  mode: 'before' | 'after'
): Promise<string> {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const idx = content.indexOf(anchorText);
  if (idx === -1) {
    return `Error: anchorText not found in file:\n---\n${anchorText}`;
  }

  const insertPos = mode === 'before' ? idx : idx + anchorText.length;
  const newContent = content.slice(0, insertPos) + newText + content.slice(insertPos);
  fs.writeFileSync(resolved, newContent, 'utf-8');
  return `Inserted ${newText.length} chars ${mode} anchor in ${filePath}.`;
}

export async function runTerminal(
  command: string,
  cwd?: string,
  timeoutMs?: number
): Promise<string> {
  // Security check
  if (isDangerous(command)) {
    return `Error: Command blocked for security reasons: ${command}`;
  }

  const workDir = cwd ? resolvePath(cwd) : _projectDir;
  const timeout = timeoutMs ?? 30_000;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workDir,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    let result = '';
    if (stdout) result += `[stdout]\n${stdout}`;
    if (stderr) result += `[stderr]\n${stderr}`;
    if (!result) result = '(no output)';

    // Truncate very long output
    if (result.length > 10000) {
      result = result.slice(0, 10000) + `\n... (output truncated at 10000 chars)`;
    }

    return result;
  } catch (e: any) {
    let msg = `Command failed (exit code: ${e.code ?? 'unknown'})`;
    if (e.stdout) msg += `\n[stdout]\n${e.stdout}`;
    if (e.stderr) msg += `\n[stderr]\n${e.stderr}`;
    if (e.killed) msg += `\n(timed out after ${timeout}ms)`;
    return msg;
  }
}

export async function searchCode(
  pattern: string,
  filePattern?: string,
  maxResults = 20
): Promise<string> {
  const results: Array<{ file: string; line: number; text: string }> = [];
  const regex = new RegExp(pattern, 'i');

  function walkDir(dir: string): void {
    if (results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const fullPath = path.join(dir, entry.name);

        // Skip hidden dirs and node_modules
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          // Apply filePattern filter if given
          if (filePattern) {
            const globMatch = new RegExp(
              filePattern.replace(/\*/g, '.*').replace(/\{/g, '(').replace(/\}/g, ')')
            );
            if (!globMatch.test(entry.name)) continue;
          }

          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 1024 * 1024) continue; // Skip files > 1MB

            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                const relPath = path.relative(_projectDir, fullPath);
                results.push({
                  file: relPath,
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                });
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // Skip binary files, permission errors, etc.
          }
        }
      }
    } catch {
      // Skip permission errors
    }
  }

  walkDir(_projectDir);

  if (results.length === 0) {
    return `No results found for pattern: ${pattern}`;
  }

  return results
    .map((r) => `${r.file}:${r.line}  ${r.text}`)
    .join('\n');
}

export async function listDirectory(dirPath?: string, depth = 1): Promise<string> {
  const resolved = dirPath ? resolvePath(dirPath) : _projectDir;
  const maxDepth = Math.min(depth, 3);

  function formatEntry(filePath: string, name: string, currentDepth: number): string {
    const indent = '  '.repeat(currentDepth);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return `${indent}📁 ${name}/`;
      } else {
        const size = stat.size;
        const sizeStr = size < 1024 ? `${size}B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)}KB` : `${(size / 1024 / 1024).toFixed(1)}MB`;
        const mtime = stat.mtime.toLocaleDateString();
        return `${indent}📄 ${name} (${sizeStr}, ${mtime})`;
      }
    } catch {
      return `${indent}${name}`;
    }
  }

  function buildTree(dir: string, currentDepth: number): string[] {
    if (currentDepth > maxDepth) return [];
    const lines: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      // Sort: dirs first, then files; both alphabetically
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.gitignore') continue;
        if (entry.name === 'node_modules') continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          lines.push(formatEntry(fullPath, entry.name, currentDepth));
          lines.push(...buildTree(fullPath, currentDepth + 1));
        } else {
          lines.push(formatEntry(fullPath, entry.name, currentDepth));
        }
      }
    } catch {
      lines.push(`  ${'  '.repeat(currentDepth)}(cannot read directory)`);
    }
    return lines;
  }

  const tree = buildTree(resolved, 0);
  return tree.join('\n');
}

export async function getProjectContext(detail: 'summary' | 'full' = 'summary'): Promise<string> {
  const projectName = path.basename(_projectDir);

  // Count files by type
  const stats = {
    dirs: 0,
    files: 0,
    totalSize: 0,
    extensions: new Map<string, number>(),
  };

  function walk(dir: string, maxFiles = 1000): void {
    if (stats.files > maxFiles) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stats.dirs++;
          walk(fullPath, maxFiles);
        } else {
          stats.files++;
          const ext = path.extname(entry.name) || '(no ext)';
          stats.extensions.set(ext, (stats.extensions.get(ext) ?? 0) + 1);
          try {
            stats.totalSize += fs.statSync(fullPath).size;
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  walk(_projectDir);

  const extSummary = [...stats.extensions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(', ');

  let context = `## Project: ${projectName}\n\n`;
  context += `- 📁 Directories: ${stats.dirs}\n`;
  context += `- 📄 Files: ${stats.files}\n`;
  context += `- 💾 Total size: ${(stats.totalSize / 1024 / 1024).toFixed(1)} MB\n`;
  context += `- 📊 File types: ${extSummary || '(none)'}\n\n`;

  if (detail === 'full') {
    context += `### Directory Structure\n\`\`\`\n`;
    context += await listDirectory(undefined, 2);
    context += '\n```\n';
  }

  return context;
}
