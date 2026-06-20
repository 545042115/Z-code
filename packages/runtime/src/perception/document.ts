// @z-assistant/runtime — Document Parsing Service
//
// Parses PDF, DOCX, PPTX, and TXT files into plain text.
// Uses the Python sidecar for robust parsing (PyMuPDF, python-docx, python-pptx).
// Falls back to basic Node.js parsing if Python is unavailable.

import { PythonBridge } from './python-bridge';
import { readFileSync } from 'fs';
import { extname } from 'path';

let bridge: PythonBridge | null = null;

function getBridge(): PythonBridge {
  if (!bridge) {
    bridge = new PythonBridge();
  }
  return bridge;
}

/** Parse a document file and return its text content. */
export async function parseDocument(filePath: string): Promise<string> {
  // Try Python sidecar first
  try {
    return await getBridge().parseDocument(filePath);
  } catch {
    // Fallback: basic Node.js parsing
    return fallbackParse(filePath);
  }
}

/** Basic fallback parser using Node.js built-ins. */
function fallbackParse(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.txt') {
    return readFileSync(filePath, 'utf-8');
  }

  if (ext === '.pdf') {
    // Minimal PDF text extraction (no deps)
    const raw = readFileSync(filePath, 'utf-8');
    const textMatches = raw.match(/\(([^)]*)\)/g);
    if (textMatches) {
      return textMatches
        .map((m) => m.slice(1, -1))
        .filter((t) => t.length > 2)
        .join('\n');
    }
    return '[PDF text extraction requires Python sidecar]';
  }

  if (ext === '.docx' || ext === '.pptx') {
    return `[${ext.toUpperCase()} parsing requires Python sidecar]`;
  }

  return `[Unsupported document type: ${ext}]`;
}

export async function closeDocumentParser(): Promise<void> {
  if (bridge) {
    await bridge.close();
    bridge = null;
  }
}
