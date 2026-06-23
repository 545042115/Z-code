---
name: llm-provider
description: 'Add or fix LLM provider integrations (OpenAI, Azure, Deepseek, MiMo, SGLang). Activates on provider, endpoint, API key, chat/completions, or files under the llm/ directory.'
argument-hint: 'Describe the LLM provider change or issue to address'
user-invocable: true
tags: [llm, provider, openai, azure, api]
priority: 70
mode: advisory
triggers:
  intents: [create, modify, bug_fix]
  file_globs:
    - '**/llm/**'
    - '**/provider*'
  keywords:
    - provider
    - llm
    - openai
    - azure
    - deepseek
    - endpoint
    - api-key
    - chat/completions
    - mimo
    - sglang
stop_if:
  - frontend-only
  - react-only
imports:
  - typescript-quality
tools_allow:
  - read_file
  - search_code
  - replace_text
  - insert_before
  - insert_after
  - run_terminal
verification:
  commands:
    - npm run compile
---

# LLM Provider

Guide the implementation and debugging of LLM provider integrations, ensuring correct API endpoint construction, authentication headers, and response handling.

## Use When

- Adding a new LLM provider
- Fixing endpoint URL construction issues
- Debugging authentication or API key problems
- Modifying request/response handling for chat completions

## Workflow

1. Identify the provider type (OpenAI-compatible, Azure, or custom)
2. Check the existing provider pattern in `llm/llm-provider.ts`
3. Implement following the established provider interface
4. Verify endpoint construction and header format
5. Test with a minimal request

## Do

- Distinguish between endpoint URL and API key configuration
- OpenAI-compatible APIs use `/chat/completions` endpoint
- Azure uses `api-key` header and `api-version` query parameter
- Follow the existing provider factory pattern
- Add the new provider to `LLMProviderFactory`
- Handle streaming and non-streaming responses consistently

## Do Not

- Hardcode API keys or endpoints
- Mix Azure and OpenAI header formats
- Ignore error response formats from different providers
- Assume all providers use the same authentication mechanism
- Skip the `api-version` parameter for Azure

## Verification

Run `npm run compile` after changes. Verify the new provider is correctly registered in the factory.

## References

- Read `references/provider-contract.md` when adding a new provider implementation.
