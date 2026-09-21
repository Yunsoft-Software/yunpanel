import { randomUUID } from 'node:crypto';
import { AiProviderError, createAiProviderAdapter } from './ai-provider.js';

function checkResponseOk(response, providerName, data) {
  if (!response.ok) {
    const errorDetail = data?.error?.message || data?.message || response.statusText || 'Unknown provider error';
    if (response.status === 401 || response.status === 403) {
      throw new AiProviderError('ai_provider_authentication_failed', `${providerName} authentication failed: ${errorDetail}`, 401);
    }
    if (response.status === 429) {
      throw new AiProviderError('ai_provider_rate_limited', `${providerName} rate limited: ${errorDetail}`, 429);
    }
    throw new AiProviderError('ai_provider_upstream_error', `${providerName} request returned status ${response.status}: ${errorDetail}`, 502);
  }
}

export function createOpenAiCompatibleAdapter({
  id = 'openai',
  apiKey = '',
  baseUrl = 'https://api.openai.com/v1',
  defaultModel = 'gpt-4o',
  fetchClient = globalThis.fetch,
  extraHeaders = {},
} = {}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function invoke({ model, messages, tools = [], signal = null }) {
    const selectedModel = model || defaultModel;
    const formattedMessages = messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.callId,
          content: typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result),
        };
      }
      return {
        role: msg.role,
        content: msg.text,
      };
    });

    const body = {
      model: selectedModel,
      messages: formattedMessages,
    };

    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = 'auto';
    }

    const headers = {
      'content-type': 'application/json',
      ...extraHeaders,
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    let response;
    let data;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      data = await response.json();
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      throw new AiProviderError('ai_provider_network_error', `Network error connecting to ${id}: ${err.message}`, 502);
    }

    checkResponseOk(response, id, data);

    const choice = data.choices?.[0];
    if (!choice || !choice.message) {
      throw new AiProviderError('invalid_ai_provider_response', `${id} returned no completion choice`);
    }

    const toolCalls = choice.message.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolCalls.map((call) => {
          let parsedArgs = {};
          try {
            parsedArgs = typeof call.function.arguments === 'string'
              ? JSON.parse(call.function.arguments)
              : (call.function.arguments || {});
          } catch {
            parsedArgs = {};
          }
          return {
            id: call.id,
            name: call.function.name,
            input: parsedArgs,
          };
        }),
      };
    }

    return {
      type: 'message',
      text: choice.message.content ?? '',
    };
  }

  const inner = createAiProviderAdapter({ id, invoke });
  return Object.freeze({
    id,
    defaultModel,
    complete: (args = {}) => inner.complete({ model: args?.model || defaultModel, ...args }),
    invoke: (args = {}) => inner.invoke({ model: args?.model || defaultModel, ...args }),
  });
}

export function createAnthropicAdapter({
  id = 'anthropic',
  apiKey = '',
  baseUrl = 'https://api.anthropic.com',
  defaultModel = 'claude-3-7-sonnet-20250219',
  fetchClient = globalThis.fetch,
} = {}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;

  async function invoke({ model, messages, tools = [], signal = null }) {
    const selectedModel = model || defaultModel;
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    const formattedMessages = [];
    for (const msg of nonSystemMsgs) {
      if (msg.role === 'tool') {
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.callId,
              content: typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result),
            },
          ],
        });
      } else {
        formattedMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.text,
        });
      }
    }

    const body = {
      model: selectedModel,
      max_tokens: 4096,
      messages: formattedMessages,
    };

    if (systemMsgs.length > 0) {
      body.system = systemMsgs.map((m) => m.text).join('\n\n');
    }

    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    };

    let response;
    let data;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      data = await response.json();
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      throw new AiProviderError('ai_provider_network_error', `Network error connecting to ${id}: ${err.message}`, 502);
    }

    checkResponseOk(response, id, data);

    if (!Array.isArray(data.content)) {
      throw new AiProviderError('invalid_ai_provider_response', `${id} response format missing content array`);
    }

    const toolUses = data.content.filter((block) => block.type === 'tool_use');
    if (toolUses.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolUses.map((tu) => ({
          id: tu.id,
          name: tu.name,
          input: tu.input ?? {},
        })),
      };
    }

    const textBlock = data.content.find((block) => block.type === 'text');
    return {
      type: 'message',
      text: textBlock?.text ?? '',
    };
  }

  const inner = createAiProviderAdapter({ id, invoke });
  return Object.freeze({
    id,
    defaultModel,
    complete: (args = {}) => inner.complete({ model: args?.model || defaultModel, ...args }),
    invoke: (args = {}) => inner.invoke({ model: args?.model || defaultModel, ...args }),
  });
}

export function createGeminiAdapter({
  id = 'gemini',
  apiKey = '',
  baseUrl = 'https://generativelanguage.googleapis.com',
  defaultModel = 'gemini-2.0-flash',
  fetchClient = globalThis.fetch,
} = {}) {
  async function invoke({ model, messages, tools = [], signal = null }) {
    const selectedModel = model || defaultModel;
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanBase}/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const contents = [];
    for (const msg of messages) {
      if (msg.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.name,
              response: typeof msg.result === 'object' && msg.result !== null ? msg.result : { content: msg.result },
            },
          }],
        });
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.text }],
        });
      }
    }

    const body = { contents };

    if (tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      }];
    }

    let response;
    let data;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      data = await response.json();
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      throw new AiProviderError('ai_provider_network_error', `Network error connecting to ${id}: ${err.message}`, 502);
    }

    checkResponseOk(response, id, data);

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new AiProviderError('invalid_ai_provider_response', `${id} response contains no parts`);
    }

    const functionCalls = parts.filter((p) => p.functionCall);
    if (functionCalls.length > 0) {
      return {
        type: 'tool_calls',
        calls: functionCalls.map((fc) => ({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          name: fc.functionCall.name,
          input: fc.functionCall.args ?? {},
        })),
      };
    }

    const textPart = parts.find((p) => typeof p.text === 'string');
    return {
      type: 'message',
      text: textPart?.text ?? '',
    };
  }

  const inner = createAiProviderAdapter({ id, invoke });
  return Object.freeze({
    id,
    defaultModel,
    complete: (args = {}) => inner.complete({ model: args?.model || defaultModel, ...args }),
    invoke: (args = {}) => inner.invoke({ model: args?.model || defaultModel, ...args }),
  });
}

export function createOpenRouterAdapter({
  id = 'openrouter',
  apiKey = '',
  baseUrl = 'https://openrouter.ai/api/v1',
  defaultModel = 'z-ai/glm-5.2',
  fetchClient = globalThis.fetch,
} = {}) {
  return createOpenAiCompatibleAdapter({
    id,
    apiKey,
    baseUrl,
    defaultModel,
    fetchClient,
    extraHeaders: {
      'HTTP-Referer': 'https://yunpanel.com',
      'X-Title': 'YunPanel',
    },
  });
}

export function createProviderFromConfig(config, options = {}) {
  if (!config || typeof config !== 'object') {
    throw new AiProviderError('invalid_provider_config', 'Provider configuration is missing', 500);
  }
  const type = config.type;
  switch (type) {
    case 'anthropic':
      return createAnthropicAdapter({ ...config, ...options });
    case 'gemini':
      return createGeminiAdapter({ ...config, ...options });
    case 'openai':
    case 'ollama':
      return createOpenAiCompatibleAdapter({ ...config, ...options });
    case 'openrouter':
      return createOpenRouterAdapter({ ...config, ...options });
    default:
      throw new AiProviderError('unsupported_ai_provider_type', `AI provider type ${type} is not supported`, 500);
  }
}

