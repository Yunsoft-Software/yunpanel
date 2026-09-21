const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MAX_MESSAGES = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PROVIDER_OUTPUT_BYTES = 128 * 1024;
const MAX_TOOL_CALLS = 8;

export class AiProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.status = status;
  }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function normalizeMessage(message, index) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new AiProviderError('invalid_ai_message', `AI message ${index} is invalid`, 400);
  }
  const allowed = new Set(['role', 'text', 'callId', 'name', 'result']);
  if (Object.keys(message).some((key) => !allowed.has(key)) || !ROLES.has(message.role)) {
    throw new AiProviderError('invalid_ai_message', `AI message ${index} has unsupported fields`, 400);
  }
  if (message.role === 'tool') {
    if (typeof message.callId !== 'string' || !CALL_ID_PATTERN.test(message.callId)
      || typeof message.name !== 'string' || !TOOL_NAME_PATTERN.test(message.name)
      || message.text !== undefined) {
      throw new AiProviderError('invalid_ai_tool_message', `AI tool message ${index} is invalid`, 400);
    }
    const result = message.result ?? null;
    if (byteLength(result) > MAX_MESSAGE_BYTES) {
      throw new AiProviderError('ai_tool_result_too_large', 'AI tool result exceeds the supported size', 400);
    }
    return Object.freeze({ role: 'tool', callId: message.callId, name: message.name, result: structuredClone(result) });
  }
  if (typeof message.text !== 'string' || message.text.length < 1
    || Buffer.byteLength(message.text, 'utf8') > MAX_MESSAGE_BYTES
    || message.callId !== undefined || message.name !== undefined || message.result !== undefined) {
    throw new AiProviderError('invalid_ai_message', `AI message ${index} text is invalid`, 400);
  }
  return Object.freeze({ role: message.role, text: message.text });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    throw new AiProviderError('invalid_ai_messages', 'AI messages must be a non-empty bounded array', 400);
  }
  return Object.freeze(messages.map(normalizeMessage));
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    throw new AiProviderError('invalid_ai_provider_tool', 'AI provider tool definition is invalid', 500);
  }
  const allowed = new Set(['name', 'description', 'inputSchema']);
  if (Object.keys(tool).some((key) => !allowed.has(key))
    || typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)
    || typeof tool.description !== 'string' || tool.description.length < 1 || tool.description.length > 300
    || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
    throw new AiProviderError('invalid_ai_provider_tool', 'AI provider tool definition is invalid', 500);
  }
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
  });
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length > 100) {
    throw new AiProviderError('invalid_ai_provider_tools', 'AI provider tools are invalid', 500);
  }
  const normalized = tools.map(normalizeTool);
  if (new Set(normalized.map((tool) => tool.name)).size !== normalized.length) {
    throw new AiProviderError('duplicate_ai_provider_tool', 'AI provider tools must be unique', 500);
  }
  return Object.freeze(normalized);
}

function normalizeToolCall(call, index) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw new AiProviderError('invalid_ai_provider_tool_call', `AI provider tool call ${index} is invalid`);
  }
  const allowed = new Set(['id', 'name', 'input']);
  if (Object.keys(call).some((key) => !allowed.has(key))
    || typeof call.id !== 'string' || !CALL_ID_PATTERN.test(call.id)
    || typeof call.name !== 'string' || !TOOL_NAME_PATTERN.test(call.name)
    || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
    throw new AiProviderError('invalid_ai_provider_tool_call', `AI provider tool call ${index} is invalid`);
  }
  if (byteLength(call.input) > MAX_MESSAGE_BYTES) {
    throw new AiProviderError('ai_provider_tool_call_too_large', 'AI provider tool call input exceeds the supported size');
  }
  return Object.freeze({ id: call.id, name: call.name, input: structuredClone(call.input) });
}

function normalizeProviderResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || byteLength(result) > MAX_PROVIDER_OUTPUT_BYTES) {
    throw new AiProviderError('invalid_ai_provider_response', 'AI provider response is invalid');
  }
  if (result.type === 'message') {
    if (Object.keys(result).some((key) => !['type', 'text'].includes(key))
      || typeof result.text !== 'string' || result.text.length < 1
      || Buffer.byteLength(result.text, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new AiProviderError('invalid_ai_provider_response', 'AI provider message response is invalid');
    }
    return Object.freeze({ type: 'message', text: result.text });
  }
  if (result.type === 'tool_calls') {
    if (Object.keys(result).some((key) => !['type', 'calls'].includes(key))
      || !Array.isArray(result.calls) || result.calls.length < 1 || result.calls.length > MAX_TOOL_CALLS) {
      throw new AiProviderError('invalid_ai_provider_response', 'AI provider tool-call response is invalid');
    }
    const calls = result.calls.map(normalizeToolCall);
    if (new Set(calls.map((call) => call.id)).size !== calls.length) {
      throw new AiProviderError('duplicate_ai_provider_call_id', 'AI provider tool-call IDs must be unique');
    }
    return Object.freeze({ type: 'tool_calls', calls: Object.freeze(calls) });
  }
  throw new AiProviderError('invalid_ai_provider_response', 'AI provider response type is unsupported');
}

export function createAiProviderAdapter({ id, invoke } = {}) {
  if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
    throw new AiProviderError('invalid_ai_provider_id', 'AI provider id is invalid', 500);
  }
  if (typeof invoke !== 'function') {
    throw new AiProviderError('invalid_ai_provider_adapter', 'AI provider invoke adapter is required', 500);
  }

  async function complete({ model, messages, tools = [], signal = null } = {}) {
    if (typeof model !== 'string' || model.length < 1 || model.length > 128) {
      throw new AiProviderError('invalid_ai_model', 'AI model id is invalid', 400);
    }
    const request = Object.freeze({
      model,
      messages: normalizeMessages(messages),
      tools: normalizeTools(tools),
      signal,
    });
    let result;
    try {
      result = await invoke(request);
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError('ai_provider_request_failed', 'AI provider request failed');
    }
    return normalizeProviderResult(result);
  }

  return Object.freeze({ id, complete, invoke: complete });
}

export const aiProviderInternals = Object.freeze({
  maxMessages: MAX_MESSAGES,
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxProviderOutputBytes: MAX_PROVIDER_OUTPUT_BYTES,
  maxToolCalls: MAX_TOOL_CALLS,
  normalizeMessages,
  normalizeTools,
  normalizeProviderResult,
});
