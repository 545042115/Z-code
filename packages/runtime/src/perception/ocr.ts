// @ziner/runtime — OCR Service
//
// Extracts text from images using the Python sidecar (EasyOCR).
// Falls back to a simple message if Python is unavailable.

import { PythonBridge } from './python-bridge';

let bridge: PythonBridge | null = null;

function getBridge(): PythonBridge {
  if (!bridge) {
    bridge = new PythonBridge();
  }
  return bridge;
}

export async function ocrImage(imageBase64: string): Promise<string> {
  try {
    return await getBridge().ocr(imageBase64);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[OCR unavailable: ${msg}]`;
  }
}

export async function ocrFile(filePath: string): Promise<string> {
  try {
    return await getBridge().ocrFile(filePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[OCR unavailable: ${msg}]`;
  }
}

export async function closeOcr(): Promise<void> {
  if (bridge) {
    await bridge.close();
    bridge = null;
  }
}
