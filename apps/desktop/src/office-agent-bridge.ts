// @z-assistant/app-desktop — Office Agent bridge (P2-2).
//
// Wires the Office Agent to the desktop storage directory so generated
// Word/Excel/PowerPoint files are saved in a predictable place.

import * as path from 'node:path';
import { createOfficeAgent as createOfficeAgentImpl } from '@z-assistant/agent-office';
import type { IAgent, ILLMProvider, ModelSpec } from '@z-assistant/contracts';

export interface DesktopOfficeAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  storageDir: string;
}

export function createOfficeAgent(options: DesktopOfficeAgentOptions): IAgent {
  const outputDir = path.join(options.storageDir, 'office');
  return createOfficeAgentImpl({
    llmProvider: options.llmProvider,
    model: options.model,
    outputDir,
    maxTokens: 2048,
  });
}
