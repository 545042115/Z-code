# LLM Provider Contract

## Provider Interface

Every LLM provider must implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
  generate(request: GenerateRequest): Promise<string>;
  generateStream(request: GenerateRequest): AsyncIterable<string>;
}
```

## OpenAI-Compatible Providers

Standard request format:
- Endpoint: `{baseURL}/chat/completions`
- Header: `Authorization: Bearer {apiKey}`
- Content-Type: `application/json`

Providers using this pattern: OpenAI, Deepseek, MiMo, SGLang.

## Azure OpenAI

Different authentication:
- Endpoint: `{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}`
- Header: `api-key: {apiKey}`
- Query parameter: `api-version` (required)

## Adding a New Provider

1. Create a new class implementing `LLMProvider`
2. Add the provider type to the config schema
3. Register in `LLMProviderFactory.createFromConfig()`
4. Handle both streaming and non-streaming modes
5. Ensure error responses are properly parsed
