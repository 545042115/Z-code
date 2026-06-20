// @z-assistant/runtime — perception
//
// Sensory input for the V2 Agent: screen capture, OCR, image captioning,
// audio transcription, document parsing, and Python sidecar bridge.

export { createNoopScreenProvider, createDesktopScreenProvider } from './screen';
export type { IScreenProvider, ScreenCaptureResult } from './screen';

export { PythonBridge } from './python-bridge';

export { ocrImage, ocrFile, closeOcr } from './ocr';

export { describeImage, closeCaption } from './caption';
export type { CaptionResult } from './caption';

export { transcribeAudio, closeAudio } from './audio';

export { parseDocument, closeDocumentParser } from './document';
