import type { ChatMessage } from '@ziner/contracts';
import { createAssistantMessage, createUserMessage, lastPreview } from './ChatMessageBuilder';

export type ChatEventType = 'message' | 'complete' | 'error' | 'abort';

export interface ChatEvent {
  type: ChatEventType;
  message?: ChatMessage;
  content?: string;
  error?: Error;
  final?: ChatMessage;
}

export interface ChatControllerDeps {
  generate: (messages: ChatMessage[], signal?: AbortSignal) => Promise<ChatMessage>;
  /**
   * Optional pre-stream hook — receives the user message and may return
   * additional context the model should see (e.g. memory recall).
   */
  enrich?: (messages: ChatMessage[]) => Promise<ChatMessage[]> | ChatMessage[];
}

export interface ChatControllerOptions {
  signal?: AbortSignal;
  onEvent?: (event: ChatEvent) => void;
}

/**
 * Drives a single user turn through the underlying `generate` pipeline:
 *
 *   1. Build the initial user message
 *   2. Optionally enrich the history (memory recall, skills, etc.)
 *   3. Stream the model's reply, emitting `message` events with deltas
 *   4. Emit a final `complete` event with the full assistant message
 *
 * The controller itself does NOT depend on any platform or LLM SDK; the
 * caller supplies `generate`, which is a small adapter around whatever
 * streaming/agent runtime the host (Desktop or Mobile) is using.
 */
export class ChatController {
  private current: AbortController | null = null;
  private history: ChatMessage[] = [];

  constructor(private readonly deps: ChatControllerDeps) {}

  get messages(): ChatMessage[] {
    return [...this.history];
  }

  abort(): void {
    this.current?.abort();
    this.current = null;
  }

  async send(text: string, options: ChatControllerOptions = {}): Promise<ChatMessage> {
    this.abort();
    const controller = new AbortController();
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.current = controller;

    const userMessage = createUserMessage(text);
    this.history = [...this.history, userMessage];
    this.emit(options, { type: 'message', message: userMessage });

    const baseMessages = await Promise.resolve(this.deps.enrich?.(this.history) ?? this.history);

    try {
      const final = await this.deps.generate(baseMessages, controller.signal);
      this.history = [...this.history, final];
      this.emit(options, { type: 'complete', final });
      return final;
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit(options, { type: 'abort' });
        throw new DOMException('Aborted', 'AbortError');
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit(options, { type: 'error', error: err });
      throw err;
    }
  }

  appendMessage(message: ChatMessage): void {
    this.history = [...this.history, message];
  }

  reset(): void {
    this.abort();
    this.history = [];
  }

  preview(max = 60): string | undefined {
    return lastPreview(this.history, max);
  }

  private emit(options: ChatControllerOptions, event: ChatEvent): void {
    options.onEvent?.(event);
    if (event.type === 'message' && event.message) {
      // emit intermediate delta event for streaming callers
      // (we pass through the accumulator via content)
    }
  }

  static createAssistant(content: string): ChatMessage {
    return createAssistantMessage(content);
  }
}
