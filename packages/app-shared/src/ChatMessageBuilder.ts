import type { ChatMessage } from '@ziner/contracts';

let counter = 0;

function nextId(): string {
  counter += 1;
  return `msg-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createUserMessage(content: string, now = Date.now()): ChatMessage {
  return {
    id: nextId(),
    role: 'user',
    content,
    createdAt: now,
  };
}

export function createAssistantMessage(content: string, now = Date.now()): ChatMessage {
  return {
    id: nextId(),
    role: 'assistant',
    content,
    createdAt: now,
  };
}

export function createSystemMessage(content: string, now = Date.now()): ChatMessage {
  return {
    id: nextId(),
    role: 'system',
    content,
    createdAt: now,
  };
}

export function appendMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  return [...list, message];
}

export function previewOf(message: ChatMessage, max = 60): string {
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function lastPreview(messages: ChatMessage[], max = 60): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate.content.trim().length > 0) {
      return previewOf(candidate, max);
    }
  }
  return undefined;
}
