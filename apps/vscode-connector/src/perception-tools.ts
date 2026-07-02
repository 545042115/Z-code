// Perception tools for the Chat Agent (OCR, caption, transcribe, document parsing).
//
// These tools are invoked by the LLM via function calling when the
// user asks the assistant to read text from an image, describe an
// image, transcribe audio, or parse a document.

// ── Tool definitions ─────────────────────────────────────────────────

export const OCR_IMAGE_TOOL = {
  name: 'ocr_image',
  description: 'Extract text from an image file. Supports Chinese and English. Provide the file path to the image.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path to the image file' },
    },
    required: ['filePath'],
  },
};

export const DESCRIBE_IMAGE_TOOL = {
  name: 'describe_image',
  description: 'Generate a text description of an image. Provide the file path to the image.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path to the image file' },
    },
    required: ['filePath'],
  },
};

export const TRANSCRIBE_AUDIO_TOOL = {
  name: 'transcribe_audio',
  description: 'Transcribe an audio file to text. Supports various formats (wav, mp3, m4a, etc.).',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path to the audio file' },
    },
    required: ['filePath'],
  },
};

export const PARSE_DOCUMENT_TOOL = {
  name: 'parse_document',
  description: 'Parse and extract text content from a document file. Supports PDF, DOCX, PPTX, and TXT files.',
  argsSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path to the document file' },
    },
    required: ['filePath'],
  },
};

export const PERCEPTION_TOOLS = [
  OCR_IMAGE_TOOL,
  DESCRIBE_IMAGE_TOOL,
  TRANSCRIBE_AUDIO_TOOL,
  PARSE_DOCUMENT_TOOL,
];

// ── Tool implementations ─────────────────────────────────────────────

async function readFileAsBase64(filePath: string): Promise<string> {
  const fs = await import('node:fs');
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
}

export async function ocrImage(filePath: string): Promise<string> {
  try {
    const { ocrImage: ocrFn } = await import('@ziner/runtime');
    const base64 = await readFileAsBase64(filePath);
    const result = await ocrFn(base64);
    return result || '(no text found)';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `OCR failed: ${msg}`;
  }
}

export async function describeImage(filePath: string): Promise<string> {
  try {
    const { describeImage: descFn } = await import('@ziner/runtime');
    const base64 = await readFileAsBase64(filePath);
    const result = await descFn(base64);
    return result.caption || '(no description generated)';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Image description failed: ${msg}`;
  }
}

export async function transcribeAudio(filePath: string): Promise<string> {
  try {
    const { transcribeAudio: transFn } = await import('@ziner/runtime');
    const result = await transFn(filePath);
    return result || '(no transcription)';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Transcription failed: ${msg}`;
  }
}

export async function parseDocument(filePath: string): Promise<string> {
  try {
    const { parseDocument: parseFn } = await import('@ziner/runtime');
    const result = await parseFn(filePath);
    return result || '(no content extracted)';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Document parsing failed: ${msg}`;
  }
}
