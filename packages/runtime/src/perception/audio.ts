// @z-assistant/runtime — Audio Transcription Service
//
// Transcribes audio files to text using the Python sidecar
// (faster-whisper). Falls back gracefully if Python is unavailable.

import { PythonBridge } from './python-bridge';

let bridge: PythonBridge | null = null;

function getBridge(): PythonBridge {
  if (!bridge) {
    bridge = new PythonBridge();
  }
  return bridge;
}

export async function transcribeAudio(audioPath: string): Promise<string> {
  try {
    return await getBridge().transcribe(audioPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Transcription unavailable: ${msg}]`;
  }
}

export async function closeAudio(): Promise<void> {
  if (bridge) {
    await bridge.close();
    bridge = null;
  }
}
