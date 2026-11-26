import { randomUUID } from 'node:crypto';
import { AiProviderError, createAiProviderAdapter } from './ai-provider.js';

export function sanitizeApiKey(text, apiKey = '') {
  if (typeof text !== 'string') return text;
  let result = text;
  if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
    result = result.replaceAll(apiKey, '[REDACTED]');
  }
  result = result.replace(/([?&]key=)[^& \t\r\n]+/gi, '$1[REDACTED]');
  result = result.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[REDACTED]');
  result = result.replace(/(x-(?:api-key|goog-api-key):\s*)[^\r\n,]+/gi, '$1[REDACTED]');
  return result;
}

function createTimeoutController(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutErr.name = 'TimeoutError';
      controller.abort(timeoutErr);
    }, timeoutMs);
  }

  function cleanup() {
    if (timer) clearTimeout(timer);
  }

  function isTimeoutError(err) {
    return timedOut
      || err?.name === 'TimeoutError'
      || err?.code === 'ETIMEDOUT'
      || err?.code === 'ESOCKETTIMEDOUT'
      || (err?.name === 'AbortError' && timedOut)
      || (typeof err?.message === 'string' && /timeout|timed out/i.test(err.message))
      || (signal?.aborted && (signal.reason?.name === 'TimeoutError' || /timeout|timed out/i.test(String(signal.reason))));
  }

  return { signal: controller.signal, cleanup, isTimeoutError };
}

function checkResponseOk(response, providerName, data, apiKey = '') {
  if (!response.ok) {
    let errorDetail = data?.error?.message || data?.message || response.statusText || 'Unknown provider error';
    errorDetail = sanitizeApiKey(errorDetail, apiKey);

    if (response.status === 401 || response.status === 403) {
      throw new AiProviderError('ai_provider_authentication_failed', `${providerName} authentication failed: ${errorDetail}`, 401);
    }
    if (response.status === 429) {
      throw new AiProviderError('ai_provider_rate_limited', `${providerName} rate limited: ${errorDetail}`, 429);
    }
    if (response.status === 408 || response.status === 504) {
      throw new AiProviderError('ai_provider_timeout', `${providerName} timed out: ${errorDetail}`, response.status);
    }
    throw new AiProviderError('ai_provider_upstream_error', `${providerName} request returned status ${response.status}: ${errorDetail}`, 502);
  }
}

async function* readLines(response) {
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    let buffer = '';
    const decoder = new TextDecoder('utf8');
    for await (const chunk of response.body) {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield line;
      }
    }
    if (buffer) {
      yield buffer;
    }
  } else if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf8');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          yield line;
        }
      }
      if (buffer) yield buffer;
    } finally {
      reader.releaseLock?.();
    }
  } else if (typeof response.text === 'function') {
    const raw = await response.text();
    for (const line of raw.split(/\r?\n/)) {
      yield line;
    }
  }
}

async function* parseSseEvents(response) {
  let eventType = 'message';
  let dataLines = [];

  for await (const rawLine of readLines(response)) {
    const line = rawLine.trim();
    if (!line) {
      if (dataLines.length > 0) {
        yield { event: eventType, data: dataLines.join('\n') };
        dataLines = [];
        eventType = 'message';
      }
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length > 0) {
    yield { event: eventType, data: dataLines.join('\n') };
  }
}

export function createOpenAiCompatibleAdapter({
  id = 'openai',
  apiKey = '',
  baseUrl = 'https://api.openai.com/v1',
  defaultModel = 'gpt-4o',
  defaultTimeoutMs = null,
  fetchClient = globalThis.fetch,
  extraHeaders = {},
} = {}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  function buildRequestBody({ model, messages, tools = [], stream = false }) {
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

    if (stream) {
      body.stream = true;
    }

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

    return body;
  }

  function buildHeaders() {
    const headers = {
      'content-type': 'application/json',
      ...extraHeaders,
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  async function* streamMethod({ model, messages, tools = [], signal = null, timeoutMs = defaultTimeoutMs, onChunk = null }) {
    const body = buildRequestBody({ model, messages, tools, stream: true });
    const headers = buildHeaders();
    const timeout = createTimeoutController(signal, timeoutMs);

    let response;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
    } catch (err) {
      timeout.cleanup();
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
    }

    if (!response.ok) {
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      timeout.cleanup();
      checkResponseOk(response, id, data, apiKey);
    }

    try {
      for await (const sse of parseSseEvents(response)) {
        if (sse.data === '[DONE]') break;
        let parsed;
        try {
          parsed = JSON.parse(sse.data);
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.delta?.content) {
          const chunkObj = { type: 'text', text: choice.delta.content, chunk: choice.delta.content };
          if (onChunk && typeof onChunk === 'function') onChunk(chunkObj);
          yield chunkObj;
        }

        if (Array.isArray(choice.delta?.tool_calls)) {
          for (const tc of choice.delta.tool_calls) {
            const chunkObj = { type: 'tool_call_delta', call: tc };
            if (onChunk && typeof onChunk === 'function') onChunk(chunkObj);
            yield chunkObj;
          }
        }
      }
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_upstream_error', sanitizeApiKey(`Stream error from ${id}: ${err.message}`, apiKey), 502);
    } finally {
      timeout.cleanup();
    }
  }

  async function invoke({ model, messages, tools = [], signal = null, timeoutMs = defaultTimeoutMs, onChunk = null, stream: requestStream = false }) {
    if (requestStream || (onChunk && typeof onChunk === 'function')) {
      const body = buildRequestBody({ model, messages, tools, stream: true });
      const headers = buildHeaders();
      const timeout = createTimeoutController(signal, timeoutMs);

      let response;
      try {
        response = await fetchClient(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timeout.signal,
        });
      } catch (err) {
        timeout.cleanup();
        if (err instanceof AiProviderError) throw err;
        if (timeout.isTimeoutError(err)) {
          throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
        }
        throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
      }

      if (!response.ok) {
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        timeout.cleanup();
        checkResponseOk(response, id, data, apiKey);
      }

      let accumulatedText = '';
      const toolCallsMap = new Map();

      try {
        for await (const sse of parseSseEvents(response)) {
          if (sse.data === '[DONE]') break;
          let parsed;
          try { parsed = JSON.parse(sse.data); } catch { continue; }
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          if (choice.delta?.content) {
            accumulatedText += choice.delta.content;
            if (onChunk && typeof onChunk === 'function') {
              onChunk({ type: 'text', text: choice.delta.content, chunk: choice.delta.content });
            }
          }

          if (Array.isArray(choice.delta?.tool_calls)) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              let existing = toolCallsMap.get(idx);
              if (!existing) {
                existing = { id: tc.id || '', name: tc.function?.name || '', arguments: tc.function?.arguments || '' };
                toolCallsMap.set(idx, existing);
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof AiProviderError) throw err;
        if (timeout.isTimeoutError(err)) {
          throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
        }
        throw new AiProviderError('ai_provider_upstream_error', sanitizeApiKey(`Stream error from ${id}: ${err.message}`, apiKey), 502);
      } finally {
        timeout.cleanup();
      }

      if (toolCallsMap.size > 0) {
        const calls = Array.from(toolCallsMap.values()).map((call, i) => {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(call.arguments);
          } catch {
            parsedArgs = {};
          }
          return {
            id: call.id || `call_${i}`,
            name: call.name,
            input: parsedArgs,
          };
        });
        return { type: 'tool_calls', calls };
      }

      return { type: 'message', text: accumulatedText };
    }

    const body = buildRequestBody({ model, messages, tools, stream: false });
    const headers = buildHeaders();
    const timeout = createTimeoutController(signal, timeoutMs);

    let response;
    let data;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      data = await response.json();
    } catch (err) {
      timeout.cleanup();
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
    } finally {
      timeout.cleanup();
    }

    checkResponseOk(response, id, data, apiKey);

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

  const inner = createAiProviderAdapter({ id, invoke, stream: streamMethod });
  return Object.freeze({
    id,
    defaultModel,
    complete: (args = {}) => inner.complete({ model: args?.model || defaultModel, ...args }),
    invoke: (args = {}) => inner.invoke({ model: args?.model || defaultModel, ...args }),
    stream: (args = {}) => inner.stream({ model: args?.model || defaultModel, ...args }),
  });
}

export function createAnthropicAdapter({
  id = 'anthropic',
  apiKey = '',
  baseUrl = 'https://api.anthropic.com',
  defaultModel = 'claude-3-7-sonnet-20250219',
  defaultTimeoutMs = null,
  fetchClient = globalThis.fetch,
} = {}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;

  function buildRequestBody({ model, messages, tools = [], stream = false }) {
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

    if (stream) {
      body.stream = true;
    }

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

    return body;
  }

  function buildHeaders() {
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    return headers;
  }

  async function* streamMethod({ model, messages, tools = [], signal = null, timeoutMs = defaultTimeoutMs, onChunk = null }) {
    const body = buildRequestBody({ model, messages, tools, stream: true });
    const headers = buildHeaders();
    const timeout = createTimeoutController(signal, timeoutMs);

    let response;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
    } catch (err) {
      timeout.cleanup();
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
    }

    if (!response.ok) {
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      timeout.cleanup();
      checkResponseOk(response, id, data, apiKey);
    }

    try {
      for await (const sse of parseSseEvents(response)) {
        let parsed;
        try { parsed = JSON.parse(sse.data); } catch { continue; }

        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          const chunkObj = { type: 'text', text: parsed.delta.text, chunk: parsed.delta.text };
          if (onChunk && typeof onChunk === 'function') onChunk(chunkObj);
          yield chunkObj;
        }

        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          const chunkObj = { type: 'tool_call', call: parsed.content_block };
          if (onChunk && typeof onChunk === 'function') onChunk(chunkObj);
          yield chunkObj;
        }
      }
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_upstream_error', sanitizeApiKey(`Stream error from ${id}: ${err.message}`, apiKey), 502);
    } finally {
      timeout.cleanup();
    }
  }

  async function invoke({ model, messages, tools = [], signal = null, timeoutMs = defaultTimeoutMs, onChunk = null, stream: requestStream = false }) {
    if (requestStream || (onChunk && typeof onChunk === 'function')) {
      const body = buildRequestBody({ model, messages, tools, stream: true });
      const headers = buildHeaders();
      const timeout = createTimeoutController(signal, timeoutMs);

      let response;
      try {
        response = await fetchClient(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timeout.signal,
        });
      } catch (err) {
        timeout.cleanup();
        if (err instanceof AiProviderError) throw err;
        if (timeout.isTimeoutError(err)) {
          throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
        }
        throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
      }

      if (!response.ok) {
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        timeout.cleanup();
        checkResponseOk(response, id, data, apiKey);
      }

      let accumulatedText = '';
      const toolUses = [];
      let currentToolUse = null;

      try {
        for await (const sse of parseSseEvents(response)) {
          let parsed;
          try { parsed = JSON.parse(sse.data); } catch { continue; }

          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            currentToolUse = {
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              arguments: '',
            };
            toolUses.push(currentToolUse);
          }

          if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.type === 'text_delta') {
              accumulatedText += parsed.delta.text;
              if (onChunk && typeof onChunk === 'function') {
                onChunk({ type: 'text', text: parsed.delta.text, chunk: parsed.delta.text });
              }
            } else if (parsed.delta?.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.arguments += parsed.delta.partial_json || '';
            }
          }
        }
      } catch (err) {
        if (err instanceof AiProviderError) throw err;
        if (timeout.isTimeoutError(err)) {
          throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
        }
        throw new AiProviderError('ai_provider_upstream_error', sanitizeApiKey(`Stream error from ${id}: ${err.message}`, apiKey), 502);
      } finally {
        timeout.cleanup();
      }

      if (toolUses.length > 0) {
        return {
          type: 'tool_calls',
          calls: toolUses.map((tu) => {
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(tu.arguments); } catch { parsedArgs = {}; }
            return {
              id: tu.id,
              name: tu.name,
              input: parsedArgs,
            };
          }),
        };
      }

      return { type: 'message', text: accumulatedText };
    }

    const body = buildRequestBody({ model, messages, tools, stream: false });
    const headers = buildHeaders();
    const timeout = createTimeoutController(signal, timeoutMs);

    let response;
    let data;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      data = await response.json();
    } catch (err) {
      timeout.cleanup();
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
    } finally {
      timeout.cleanup();
    }

    checkResponseOk(response, id, data, apiKey);

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

  const inner = createAiProviderAdapter({ id, invoke, stream: streamMethod });
  return Object.freeze({
    id,
    defaultModel,
    complete: (args = {}) => inner.complete({ model: args?.model || defaultModel, ...args }),
    invoke: (args = {}) => inner.invoke({ model: args?.model || defaultModel, ...args }),
    stream: (args = {}) => inner.stream({ model: args?.model || defaultModel, ...args }),
  });
}

export function createGeminiAdapter({
  id = 'gemini',
  apiKey = '',
  baseUrl = 'https://generativelanguage.googleapis.com',
  defaultModel = 'gemini-2.0-flash',
  defaultTimeoutMs = null,
  fetchClient = globalThis.fetch,
} = {}) {
  const cleanBase = baseUrl.replace(/\/+$/, '');

  function buildRequestBody({ messages, tools = [] }) {
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

    return body;
  }

  function buildHeaders() {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) {
      headers['x-goog-api-key'] = apiKey;
    }
    return headers;
  }

  async function* streamMethod({ model, messages, tools = [], signal = null, timeoutMs = defaultTimeoutMs, onChunk = null }) {
    const selectedModel = model || defaultModel;
    const endpoint = `${cleanBase}/v1beta/models/${encodeURIComponent(selectedModel)}:streamGenerateContent?alt=sse`;
    const body = buildRequestBody({ messages, tools });
    const headers = buildHeaders();
    const timeout = createTimeoutController(signal, timeoutMs);

    let response;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
    } catch (err) {
      timeout.cleanup();
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
    }

    if (!response.ok) {
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      timeout.cleanup();
      checkResponseOk(response, id, data, apiKey);
    }

    try {
      for await (const sse of parseSseEvents(response)) {
        let parsed;
        try { parsed = JSON.parse(sse.data); } catch { continue; }
        const candidate = parsed.candidates?.[0];
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts)) continue;

        for (const p of parts) {
          if (typeof p.text === 'string') {
            const chunkObj = { type: 'text', text: p.text, chunk: p.text };
            if (onChunk && typeof onChunk === 'function') onChunk(chunkObj);
            yield chunkObj;
          }
          if (p.functionCall) {
            const chunkObj = {
              type: 'tool_call',
              call: {
                id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
                name: p.functionCall.name,
                input: p.functionCall.args ?? {},
              },
            };
            if (onChunk && typeof onChunk === 'function') onChunk(chunkObj);
            yield chunkObj;
          }
        }
      }
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_upstream_error', sanitizeApiKey(`Stream error from ${id}: ${err.message}`, apiKey), 502);
    } finally {
      timeout.cleanup();
    }
  }

  async function invoke({ model, messages, tools = [], signal = null, timeoutMs = defaultTimeoutMs, onChunk = null, stream: requestStream = false }) {
    if (requestStream || (onChunk && typeof onChunk === 'function')) {
      const selectedModel = model || defaultModel;
      const endpoint = `${cleanBase}/v1beta/models/${encodeURIComponent(selectedModel)}:streamGenerateContent?alt=sse`;
      const body = buildRequestBody({ messages, tools });
      const headers = buildHeaders();
      const timeout = createTimeoutController(signal, timeoutMs);

      let response;
      try {
        response = await fetchClient(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timeout.signal,
        });
      } catch (err) {
        timeout.cleanup();
        if (err instanceof AiProviderError) throw err;
        if (timeout.isTimeoutError(err)) {
          throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
        }
        throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
      }

      if (!response.ok) {
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        timeout.cleanup();
        checkResponseOk(response, id, data, apiKey);
      }

      let accumulatedText = '';
      const functionCalls = [];

      try {
        for await (const sse of parseSseEvents(response)) {
          let parsed;
          try { parsed = JSON.parse(sse.data); } catch { continue; }
          const candidate = parsed.candidates?.[0];
          const parts = candidate?.content?.parts;
          if (!Array.isArray(parts)) continue;

          for (const p of parts) {
            if (typeof p.text === 'string') {
              accumulatedText += p.text;
              if (onChunk && typeof onChunk === 'function') {
                onChunk({ type: 'text', text: p.text, chunk: p.text });
              }
            }
            if (p.functionCall) {
              functionCalls.push({
                id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
                name: p.functionCall.name,
                input: p.functionCall.args ?? {},
              });
            }
          }
        }
      } catch (err) {
        if (err instanceof AiProviderError) throw err;
        if (timeout.isTimeoutError(err)) {
          throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
        }
        throw new AiProviderError('ai_provider_upstream_error', sanitizeApiKey(`Stream error from ${id}: ${err.message}`, apiKey), 502);
      } finally {
        timeout.cleanup();
      }

      if (functionCalls.length > 0) {
        return { type: 'tool_calls', calls: functionCalls };
      }

      return { type: 'message', text: accumulatedText };
    }

    const selectedModel = model || defaultModel;
    const endpoint = `${cleanBase}/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
    const body = buildRequestBody({ messages, tools });
    const headers = buildHeaders();
    const timeout = createTimeoutController(signal, timeoutMs);

    let response;
    let data;
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      data = await response.json();
    } catch (err) {
      timeout.cleanup();
      if (err instanceof AiProviderError) throw err;
      if (timeout.isTimeoutError(err)) {
        throw new AiProviderError('ai_provider_timeout', sanitizeApiKey(`${id} request timed out: ${err.message}`, apiKey), 504);
      }
      throw new AiProviderError('ai_provider_network_error', sanitizeApiKey(`Network error connecting to ${id}: ${err.message}`, apiKey), 502);
    } finally {
      timeout.cleanup();
    }

    checkResponseOk(response, id, data, apiKey);

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

  const inner = createAiProviderAdapter({ id, invoke, stream: streamMethod });
  return Object.freeze({
    id,
    defaultModel,
    complete: (args = {}) => inner.complete({ model: args?.model || defaultModel, ...args }),
    invoke: (args = {}) => inner.invoke({ model: args?.model || defaultModel, ...args }),
    stream: (args = {}) => inner.stream({ model: args?.model || defaultModel, ...args }),
  });
}

export function createOpenRouterAdapter({
  id = 'openrouter',
  apiKey = '',
  baseUrl = 'https://openrouter.ai/api/v1',
  defaultModel = 'z-ai/glm-5.2',
  defaultTimeoutMs = null,
  fetchClient = globalThis.fetch,
} = {}) {
  return createOpenAiCompatibleAdapter({
    id,
    apiKey,
    baseUrl,
    defaultModel,
    defaultTimeoutMs,
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
