import * as vscode from 'vscode';
import { ConfigManager } from '../config/config-manager';

/**
 * LLM Provider 接口
 * 支持多种后端：SGLang、OpenAI、Azure OpenAI 等
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface GenerateRequest {
  messages: Message[];
  jsonSchema?: object;
  stream?: boolean;
}

export interface FIMRequest {
  prefix: string;
  suffix: string;
  maxTokens?: number;
}

export interface LLMConfig {
  provider: 'sglang' | 'openai' | 'azure' | 'deepseek' | 'mimo';
  endpoint: string;
  apiKey?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  organization?: string;
}

export abstract class LLMProvider {
  protected config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  abstract generate(request: GenerateRequest): Promise<string>;
  abstract generateStream(request: GenerateRequest): AsyncIterable<string>;
  abstract fimComplete(request: FIMRequest): Promise<string>;

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    if (this.config.organization) {
      headers['OpenAI-Organization'] = this.config.organization;
    }
    return headers;
  }
}

/**
 * SGLang Provider
 */
export class SGLangProvider extends LLMProvider {
  async generate(request: GenerateRequest): Promise<string> {
    const url = `${this.config.endpoint}/v1/chat/completions`;
    
    const body: any = {
      model: this.config.model,
      messages: request.messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: false,
    };

    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_object',
        schema: request.jsonSchema,
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`SGLang error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  async *generateStream(request: GenerateRequest): AsyncIterable<string> {
    const url = `${this.config.endpoint}/v1/chat/completions`;
    
    const body: any = {
      model: this.config.model,
      messages: request.messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_object',
        schema: request.jsonSchema,
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`SGLang error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const content = this.parseStreamLine(line);
          if (content) yield content;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async fimComplete(request: FIMRequest): Promise<string> {
    const url = `${this.config.endpoint}/v1/completions`;
    
    const prompt = `<fim_prefix>${request.prefix}<fim_suffix>${request.suffix}<fim_middle>`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.config.model,
        prompt,
        max_tokens: request.maxTokens || 128,
        temperature: this.config.temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`SGLang FIM error: ${response.status}`);
    }

    const data: any = await response.json();
    return data.choices[0]?.text || '';
  }

  private parseStreamLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return null;
    
    if (trimmed.startsWith('data: ')) {
      try {
        const data = JSON.parse(trimmed.slice(6));
        return data.choices[0]?.delta?.content || '';
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * OpenAI Provider
 */
export class OpenAIProvider extends LLMProvider {
  async generate(request: GenerateRequest): Promise<string> {
    const url = `${this.config.endpoint}/v1/chat/completions`;
    
    const body: any = {
      model: this.config.model,
      messages: request.messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: false,
    };

    // OpenAI 支持 response_format
    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_object',
      };
      // 对于 OpenAI，我们需要在 system message 中描述 schema
      const schemaDescription = JSON.stringify(request.jsonSchema, null, 2);
      body.messages = [
        { 
          role: 'system', 
          content: `You must respond with a JSON object matching this schema:\n${schemaDescription}` 
        },
        ...request.messages.filter(m => m.role !== 'system'),
      ];
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI error: ${response.status} - ${error}`);
    }

    const data: any = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  async *generateStream(request: GenerateRequest): AsyncIterable<string> {
    const url = `${this.config.endpoint}/v1/chat/completions`;
    
    const body: any = {
      model: this.config.model,
      messages: request.messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    if (request.jsonSchema) {
      const schemaDescription = JSON.stringify(request.jsonSchema, null, 2);
      body.messages = [
        { 
          role: 'system', 
          content: `You must respond with a JSON object matching this schema:\n${schemaDescription}` 
        },
        ...request.messages.filter(m => m.role !== 'system'),
      ];
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const content = this.parseStreamLine(line);
          if (content) yield content;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async fimComplete(request: FIMRequest): Promise<string> {
    // OpenAI 不支持原生 FIM，使用 chat completion 模拟
    const url = `${this.config.endpoint}/v1/chat/completions`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: 'user',
            content: `Complete the code between the markers:

<before>
${request.prefix}
</before>

<after>
${request.suffix}
</after>

Provide only the code that should go between them, without any explanation.`,
          },
        ],
        max_tokens: request.maxTokens || 128,
        temperature: this.config.temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI FIM error: ${response.status}`);
    }

    const data: any = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  private parseStreamLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return null;
    
    if (trimmed.startsWith('data: ')) {
      try {
        const data = JSON.parse(trimmed.slice(6));
        return data.choices[0]?.delta?.content || '';
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * LLM Provider 工厂
 */
export class LLMProviderFactory {
  static create(config: LLMConfig): LLMProvider {
    switch (config.provider) {
      case 'sglang':
        return new SGLangProvider(config);
      case 'openai':
      case 'azure':
      case 'deepseek':
      case 'mimo':
        return new OpenAIProvider(config);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  static createFromConfigManager(): LLMProvider {
    const profile = ConfigManager.getActiveProfile();
    if (!profile) {
      return this.createFromVSCodeConfig();
    }

    const config: LLMConfig = {
      provider: profile.provider,
      endpoint: profile.endpoint,
      apiKey: profile.apiKey,
      model: profile.model,
      maxTokens: profile.maxTokens,
      temperature: profile.temperature,
    };

    return this.create(config);
  }

  static createFromVSCodeConfig(): LLMProvider {
    const cfg = vscode.workspace.getConfiguration('codingAgent');

    const profile = ConfigManager.getActiveProfile();

    const config: LLMConfig = {
      provider: cfg.get<string>('llm.provider') as 'sglang' | 'openai' | 'azure' | 'deepseek' | 'mimo' || 'sglang',
      endpoint: cfg.get<string>('llm.endpoint') || 'http://localhost:30000',
      apiKey: profile?.apiKey || cfg.get<string>('llm.apiKey') || undefined,
      model: cfg.get<string>('llm.model') || 'default',
      maxTokens: cfg.get<number>('llm.maxTokens') || 4096,
      temperature: cfg.get<number>('llm.temperature') || 0.1,
      organization: profile?.organization || cfg.get<string>('llm.organization') || undefined,
    };

    return this.create(config);
  }
}
