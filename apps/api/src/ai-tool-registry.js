import { AI_TOOL_CONFIRMATION, AI_TOOL_RISKS } from './ai-tool-catalog.js';

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const POLICIES = new Set(['allow', 'confirm', 'deny']);
const RISKS = new Set(Object.values(AI_TOOL_RISKS));
const CONFIRMATION = new Set(Object.values(AI_TOOL_CONFIRMATION));
const MAX_INPUT_BYTES = 64 * 1024;

export class AiToolRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiToolRegistryError';
    this.code = code;
    this.status = status;
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AiToolRegistryError('invalid_ai_tool_definition', 'AI tool definition must be an object');
  }
  const allowed = new Set(['name', 'description', 'risk', 'confirmation', 'defaultPolicy', 'inputSchema']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AiToolRegistryError('invalid_ai_tool_definition', 'AI tool definition contains unsupported fields');
  }
  if (typeof input.name !== 'string' || !NAME_PATTERN.test(input.name) || input.name.length > 96) {
    throw new AiToolRegistryError('invalid_ai_tool_name', 'AI tool name is invalid');
  }
  if (typeof input.description !== 'string' || input.description.length < 1 || input.description.length > 300) {
    throw new AiToolRegistryError('invalid_ai_tool_description', 'AI tool description is invalid');
  }
  if (!RISKS.has(input.risk) || !CONFIRMATION.has(input.confirmation) || !POLICIES.has(input.defaultPolicy)) {
    throw new AiToolRegistryError('invalid_ai_tool_policy', 'AI tool risk or policy metadata is invalid');
  }
  if (input.confirmation === AI_TOOL_CONFIRMATION.NEVER && input.defaultPolicy !== 'allow') {
    throw new AiToolRegistryError('invalid_ai_tool_policy', 'Non-confirming AI tools must default to allow');
  }
  if (input.confirmation === AI_TOOL_CONFIRMATION.ALWAYS && input.defaultPolicy !== 'confirm') {
    throw new AiToolRegistryError('invalid_ai_tool_policy', 'Always-confirm AI tools must default to confirm');
  }
  if (!input.inputSchema || typeof input.inputSchema !== 'object' || Array.isArray(input.inputSchema)
    || input.inputSchema.type !== 'object') {
    throw new AiToolRegistryError('invalid_ai_tool_schema', 'AI tool input schema must describe an object');
  }
  return Object.freeze({
    name: input.name,
    description: input.description,
    risk: input.risk,
    confirmation: input.confirmation,
    defaultPolicy: input.defaultPolicy,
    inputSchema: clone(input.inputSchema),
  });
}

function validateInputSchema(value, schema, path = 'input') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new AiToolRegistryError('invalid_ai_tool_schema', 'AI tool input schema is invalid');
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AiToolRegistryError('invalid_ai_tool_input', `${path} must be an object`);
    }
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    for (const field of required) {
      if (!Object.hasOwn(value, field)) throw new AiToolRegistryError('invalid_ai_tool_input', `${path}.${field} is required`);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((field) => !Object.hasOwn(properties, field));
      if (unknown) throw new AiToolRegistryError('invalid_ai_tool_input', `${path}.${unknown} is not supported`);
    }
    for (const [field, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, field)) validateInputSchema(value[field], child, `${path}.${field}`);
    }
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string'
      || (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength)
      || (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength)) {
      throw new AiToolRegistryError('invalid_ai_tool_input', `${path} must be a valid string`);
    }
    return;
  }
  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)
      || (Number.isSafeInteger(schema.minimum) && value < schema.minimum)
      || (Number.isSafeInteger(schema.maximum) && value > schema.maximum)) {
      throw new AiToolRegistryError('invalid_ai_tool_input', `${path} must be a valid integer`);
    }
    return;
  }
  throw new AiToolRegistryError('invalid_ai_tool_schema', `Unsupported AI tool input schema type at ${path}`);
}

function normalizeInput(input, schema) {
  const value = input ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiToolRegistryError('invalid_ai_tool_input', 'AI tool input must be an object');
  }
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw new AiToolRegistryError('invalid_ai_tool_input', 'AI tool input must be JSON serializable'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_INQUP_BYTES) {
    throw new AiToolRegistryError('ai_tool_input_too_large', 'AI tool input exceeds the supported size');
  }
  const cloned = clone(value);
  validateInputSchema(cloned, schema);
  return cloned;
}

function publicView(tool, bound) {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    confirmation: tool.confirmation,
    defaultPolicy: tool.defaultPolicy,
    inputSchema: clone(tool.inputSchema),
    available: bound,
  });
}

export function createAiToolRegistry({ definitions = [] } = {}) {
  if (!Array.isArray(definitions)) throw new AiToolRegistryError('invalid_ai_tool_definitions', 'AI tool definitions must be an array');
  const tools = new Map();
  const handlers = new Map();

  for (const raw of definitions) {
    const tool = normalizeDefinition(raw);
    if (tools.has(tool.name)) throw new AiToolRegistryError('duplicate_ai_tool', `AI tool ${tool.name} is already registered`, 409);
    tools.set(tool.name, tool);
  }

  function requireTool(name) {
    const tool = typeof name === 'string' ? tools.get(name) : null;
    if (!tool) throw new AiToolRegistryError('ai_tool_not_found', 'AI tool was not found', 404);
    return tool;
  }

  function list() {
    return Object.freeze([...tools.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => publicView(tool, handlers.has(tool.name))));
  }

  function get(name) {
    const tool = requireTool(name);
    return publicView(tool, handlers.has(tool.name));
  }

  function bind(name, handler) {
    requireTool(name);
    if (typeof handler !== 'function') throw new AiToolRegistryError('invalid_ai_tool_handler', 'AI tool handler must be a function');
    if (handlers.has(name)) throw new AiToolRegistryError('ai_tool_already_bound', `AI tool ${name} already has a handler`, 409);
    handlers.set(name, handler);
    return get(name);
  }

  function prepare({ name, input = {} } = {}) {
    const tool = requireTool(name);
    return Object.freeze({ tool: publicView(tool, handlers.has(tool.name)), input: normalizeInput(input, tool.inputSchema) });
  }

  async function execute({ name, input = {}, context = null } = {}) {
    const tool = requireTool(name);
    const handler = handlers.get(tool.name);
    if (!handler) throw new AiToolRegistryError('ai_tool_unavailable', `AI tool ${tool.name} is not available`, 409);
    return handler({ input: normalizeInput(input, tool.inputSchema), context, tool: publicView(tool, true) });
  }

  return Object.freeze({ list, get, bind, prepare, execute });
}

export const aiToolRegistryInternals = Object.freeze({
  maxInputBytes: MAX_INPUT_BYTES,
  normalizeDefinition,
  normalizeInput,
  validateInputSchema,
});
