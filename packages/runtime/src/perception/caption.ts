// @ziner/runtime — Image Caption Service
//
// Generates text descriptions of images using the Python sidecar
// (Florence-2 / BLIP). Falls back to OCR-only if caption model is
// unavailable.

import { PythonBridge } from './python-bridge';

let bridge: PythonBridge | null = null;

function getBridge(): PythonBridge {
  if (!bridge) {
    bridge = new PythonBridge();
  }
  return bridge;
}

export interface CaptionResult {
  caption: string;
  method: 'model' | 'fallback';
}

export async function describeImage(imageBase64: string): Promise<CaptionResult> {
  try {
    const caption = await getBridge().caption(imageBase64);
    return { caption, method: 'model' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      caption: `[Image description unavailable: ${msg}]`,
      method: 'fallback',
    };
  }
}

export async function closeCaption(): Promise<void> {
  if (bridge) {
    await bridge.close();
    bridge = null;
  }
}
