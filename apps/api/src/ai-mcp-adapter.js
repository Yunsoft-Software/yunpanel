import readline from 'node:readline';
import { createAiActionPlan, verifyAiActionExecution } from './ai-action-plan.js';
import { evaluateAiToolPolicy } from './ai-policy.js';
import { AI_TOOL_CONFIRMATION, AI_TOOL_RISKS } from './ai-tool-catalog.js';
import { AiToolRegistryError } from './ai-tool-registry.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32003,
  CONFIRMATION_REQUIRED: -32004,
  RESOURCE_NOT_FOUND: -32005,
});

export class AiMcpError extends Error {
  constructor(code, message, status = 400, data = null) {
    super(message);
    this.name = 'AiMcpError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function failureCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9][a-z0-9._-]{0,119}$/.test(error.code)
    ? error.code
    : 'ai_tool_failed';
}

function jsonRpcSuccess(id, result) {
  return Object.freeze({
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  });
}

function jsonRpcError(id, code, message, data = null) {
  const errorObj = { code, message };
  if (data !== null && data !== undefined) {
    errorObj.data = data;
  }
  return Object.freeze({
    jsonrpc: '2.0',
    id: id ?? null,
    error: Object.freeze(errorObj),
  });
}

async function resolveOverrides(policyStore, defaultOverrides, callOverrides) {
  if (callOverrides && typeof callOverrides === 'object' && !Array.isArray(callOverrides) && Object.keys(callOverrides).length > 0) {
    return callOverrides;
  }
  if (policyStore && typeof policyStore.getSnapshot === 'function') {
    const snapshot = await policyStore.getSnapshot();
    return snapshot.overrides ?? defaultOverrides ?? {};
  }
  return defaultOverrides ?? {};
}

function auditEvent(audit, { actorId, toolName, outcome, code = null }) {
  if (!audit || typeof audit.record !== 'function') return null;
  return audit.record({
    actorId,
    action: `ai.tool.${toolName}`,
    resourceType: 'ai_tool',
    resourceId: toolName,
    outcome,
    code,
  });
}

function formatErrorResponse(id, error) {
  if (error instanceof AiMcpError) {
    if (error.code === 'unauthenticated') {
      return jsonRpcError(id, MCP_ERROR_CODES.UNAUTHORIZED, error.message, error.data);
    }
    if (error.code === 'ai_tool_denied' || error.code === 'forbidden') {
      return jsonRpcError(id, MCP_ERROR_CODES.FORBIDDEN, error.message, error.data);
    }
    if (error.code === 'ai_action_confirmation_required' || error.code === 'ai_action_preview_stale') {
      return jsonRpcError(id, MCP_ERROR_CODES.CONFIRMATION_REQUIRED, error.message, error.data);
    }
    if (error.code === 'ai_tool_not_found') {
      return jsonRpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, error.message, error.data);
    }
    if (error.code === 'invalid_ai_tool_input' || error.code === 'invalid_ai_tool_name' || error.code === 'invalid_ai_request') {
      return jsonRpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, error.message, error.data);
    }
  }

  if (error instanceof AiToolRegistryError) {
    if (error.code === 'invalid_ai_tool_input' || error.code === 'ai_tool_input_too_large' || error.code === 'invalid_ai_tool_name') {
      return jsonRpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, error.message, { code: error.code });
    }
    if (error.code === 'ai_tool_not_found') {
      return jsonRpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, error.message, { code: error.code });
    }
    if (error.code === 'ai_tool_unavailable') {
      return jsonRpcError(id, MCP_ERROR_CODES.INTERNAL_ERROR, error.message, { code: error.code });
    }
  }

  if (error?.name === 'AiActionPlanError') {
    if (error.code === 'ai_tool_denied') {
      return jsonRpcError(id, MCP_ERROR_CODES.FORBIDDEN, error.message, { code: error.code });
    }
    if (error.code === 'ai_action_confirmation_required' || error.code === 'ai_action_preview_stale') {
      return jsonRpcError(id, MCP_ERROR_CODES.CONFIRMATION_REQUIRED, error.message, { code: error.code });
    }
  }

  return jsonRpcError(id, MCP_ERROR_CODES.INTERNAL_ERROR, error?.message || 'Internal error', {
    code: failureCode(error),
  });
}

export function createAiMcpAdapter({
  registry,
  audit = null,
  policyOverrides = {},
  policyStore = null,
  serverInfo = { name: 'yunpanel-ai', version: '1.0.0' },
} = {}) {
  if (!registry || ['list', 'get', 'prepare', 'execute'].some((m) => typeof registry[m] !== 'function')) {
    throw new AiMcpError('invalid_ai_tool_registry', 'AI MCP adapter requires a valid tool registry', 500);
  }

  function initialize(params = {}) {
    return Object.freeze({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: Object.freeze({
        tools: Object.freeze({
          listChanged: false,
        }),
      }),
      serverInfo: Object.freeze({
        name: serverInfo.name ?? 'yunpanel-ai',
        version: serverInfo.version ?? '1.0.0',
      }),
      instructions: 'YunPanel Model Context Protocol tool adapter providing secure, policy-guarded host operations.',
    });
  }

  async function listTools({ auth = null, overrides = null } = {}) {
    if (!auth || !auth.user || typeof auth.user.role !== 'string') {
      throw new AiMcpError('unauthenticated', 'Authentication is required for tool discovery', 401);
    }
    const effectiveOverrides = await resolveOverrides(policyStore, policyOverrides, overrides);

    const permitted = [];
    for (const tool of registry.list()) {
      const policy = evaluateAiToolPolicy({ tool, auth, overrides: effectiveOverrides });
      if (policy.decision !== 'deny') {
        permitted.push(Object.freeze({
          name: tool.name,
          description: tool.description,
          inputSchema: structuredClone(tool.inputSchema),
        }));
      }
    }
    return Object.freeze(permitted);
  }

  async function callTool({
    name,
    arguments: rawArgs = {},
    auth = null,
    overrides = null,
    confirmation = null,
    previewDigest = null,
  } = {}) {
    if (!auth || !auth.user || typeof auth.user.role !== 'string') {
      throw new AiMcpError('unauthenticated', 'Authentication is required to execute AI tools', 401);
    }
    if (typeof name !== 'string' || !name) {
      throw new AiMcpError('invalid_ai_tool_name', 'AI tool name must be a string', 400);
    }

    let tool;
    try {
      tool = registry.get(name);
    } catch (err) {
      throw new AiMcpError('ai_tool_not_found', `Tool ${name} was not found`, 404);
    }
    if (!tool.available) {
      throw new AiMcpError('ai_tool_unavailable', `Tool ${name} is not available`, 409);
    }

    const effectiveOverrides = await resolveOverrides(policyStore, policyOverrides, overrides);

    let plan;
    try {
      plan = createAiActionPlan({
        registry,
        name,
        input: rawArgs,
        auth,
        overrides: effectiveOverrides,
      });
    } catch (err) {
      if (err.code === 'ai_tool_denied') {
        auditEvent(audit, {
          actorId: auth.user.id,
          toolName: name,
          outcome: 'failed',
          code: 'forbidden',
        });
        throw new AiMcpError('ai_tool_denied', `Tool execution denied: ${err.message}`, 403);
      }
      throw err;
    }

    if (plan.decision === 'confirm') {
      if (!confirmation || !previewDigest) {
        throw new AiMcpError(
          'ai_action_confirmation_required',
          `Confirmation required for tool ${name}. Expected confirmation: ${plan.confirmation}`,
          409,
          Object.freeze({
            plan: Object.freeze({
              tool: plan.tool,
              decision: plan.decision,
              reason: plan.reason,
              previewDigest: plan.previewDigest,
              confirmation: plan.confirmation,
            }),
            previewDigest: plan.previewDigest,
            confirmation: plan.confirmation,
          }),
        );
      }
      verifyAiActionExecution({
        plan,
        previewDigest,
        confirmation,
      });
    }

    const actorId = auth.user.id;
    const role = auth.user.role;
    const tenantId = auth.user.tenantId ?? null;

    if (plan.tool.risk !== AI_TOOL_RISKS.READ) {
      auditEvent(audit, { actorId, toolName: name, outcome: 'accepted' });
    }

    try {
      const result = await registry.execute({
        name,
        input: rawArgs,
        context: Object.freeze({ actorId, role, tenantId }),
      });

      auditEvent(audit, { actorId, toolName: name, outcome: 'succeeded' });

      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return Object.freeze({
        content: Object.freeze([
          Object.freeze({
            type: 'text',
            text,
          }),
        ]),
        isError: false,
        result,
      });
    } catch (error) {
      auditEvent(audit, { actorId, toolName: name, outcome: 'failed', code: failureCode(error) });
      throw error;
    }
  }

  async function handleRequest(request, { auth = null, overrides = null } = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return jsonRpcError(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: request must be an object');
    }
    const { jsonrpc, id = null, method, params = {} } = request;
    if (jsonrpc !== '2.0') {
      return jsonRpcError(id, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
    }
    if (typeof method !== 'string') {
      return jsonRpcError(id, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: method must be a string');
    }

    try {
      switch (method) {
        case 'initialize': {
          const initResult = initialize(params);
          return jsonRpcSuccess(id, initResult);
        }
        case 'notifications/initialized': {
          return id != null ? jsonRpcSuccess(id, {}) : null;
        }
        case 'ping': {
          return jsonRpcSuccess(id, {});
        }
        case 'tools/list': {
          const tools = await listTools({ auth, overrides });
          return jsonRpcSuccess(id, { tools });
        }
        case 'tools/call': {
          if (!params || typeof params !== 'object' || Array.isArray(params)) {
            return jsonRpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'Invalid params for tools/call');
          }
          const toolName = params.name;
          if (typeof toolName !== 'string' || !toolName) {
            return jsonRpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'Tool name must be a string');
          }
          const rawArgs = params.arguments ?? params.input ?? {};
          if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
            return jsonRpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'Tool arguments must be an object');
          }

          const confirmation = params.confirmation ?? rawArgs.confirmation ?? rawArgs._confirmation ?? null;
          const previewDigest = params.previewDigest ?? rawArgs.previewDigest ?? rawArgs._previewDigest ?? null;

          const cleanArgs = { ...rawArgs };
          delete cleanArgs._confirmation;
          delete cleanArgs._previewDigest;

          let toolDef = null;
          try {
            toolDef = registry.get(toolName);
          } catch {
            // Let callTool throw proper not found error
          }

          if (toolDef && toolDef.inputSchema?.properties) {
            if (!Object.hasOwn(toolDef.inputSchema.properties, 'confirmation')) {
              delete cleanArgs.confirmation;
            }
            if (!Object.hasOwn(toolDef.inputSchema.properties, 'previewDigest')) {
              delete cleanArgs.previewDigest;
            }
          }

          const callResult = await callTool({
            name: toolName,
            arguments: cleanArgs,
            auth,
            overrides,
            confirmation,
            previewDigest,
          });

          return jsonRpcSuccess(id, {
            content: callResult.content,
            isError: callResult.isError,
          });
        }
        default: {
          return jsonRpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
      }
    } catch (error) {
      return formatErrorResponse(id, error);
    }
  }

  async function handleMessage(message, { auth = null, overrides = null } = {}) {
    let parsed = message;
    if (typeof message === 'string') {
      try {
        parsed = JSON.parse(message);
      } catch {
        return jsonRpcError(null, MCP_ERROR_CODES.PARSE_ERROR, 'Parse error: Invalid JSON');
      }
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return jsonRpcError(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: batch array is empty');
      }
      const responses = (await Promise.all(
        parsed.map((item) => handleRequest(item, { auth, overrides })),
      )).filter((res) => res !== null);
      return responses.length > 0 ? responses : null;
    }
    return handleRequest(parsed, { auth, overrides });
  }

  function createStdioHandler({
    auth = null,
    overrides = null,
    inputStream = process.stdin,
    outputStream = process.stdout,
  } = {}) {
    const rl = readline.createInterface({ input: inputStream, terminal: false });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const response = await handleMessage(trimmed, { auth, overrides });
        if (response !== null) {
          outputStream.write(`${JSON.stringify(response)}\n`);
        }
      } catch (err) {
        const errResponse = jsonRpcError(null, MCP_ERROR_CODES.INTERNAL_ERROR, err.message);
        outputStream.write(`${JSON.stringify(errResponse)}\n`);
      }
    });

    return Object.freeze({
      close: () => rl.close(),
    });
  }

  return Object.freeze({
    initialize,
    listTools,
    callTool,
    handleRequest,
    handleMessage,
    createStdioHandler,
  });
}

export const aiMcpInternals = Object.freeze({
  failureCode,
  jsonRpcSuccess,
  jsonRpcError,
  resolveOverrides,
  auditEvent,
  formatErrorResponse,
});
