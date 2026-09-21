import { createAiActionPlan, verifyAiActionExecution } from './ai-action-plan.js';
import { evaluateAiToolPolicy } from './ai-policy.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

export class AiHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response)).catch(next);
}

function normalizeToolName(value) {
  if (typeof value !== 'string' || value.length > 96 || !TOOL_NAME_PATTERN.test(value)) {
    throw new AiHttpError('invalid_ai_tool_name', 'AI tool name is invalid');
  }
  return value;
}

function normalizeBody(body, allowed) {
  const value = body ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiHttpError('invalid_ai_request', 'AI request body must be an object');
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AiHttpError('invalid_ai_request', 'AI request body contains unsupported fields');
  }
  return value;
}

function previewBody(body) {
  const value = normalizeBody(body, new Set(['input']));
  return { input: value.input ?? {} };
}

function executeBody(body) {
  const value = normalizeBody(body, new Set(['input', 'previewDigest', 'confirmation']));
  if (value.previewDigest != null && typeof value.previewDigest !== 'string') {
    throw new AiHttpError('invalid_ai_request', 'AI preview digest must be a string');
  }
  if (value.confirmation != null && typeof value.confirmation !== 'string') {
    throw new AiHttpError('invalid_ai_request', 'AI confirmation must be a string');
  }
  return {
    input: value.input ?? {},
    previewDigest: value.previewDigest ?? null,
    confirmation: value.confirmation ?? null,
  };
}

function auditEvent(audit, { actorId, toolName, outcome, code = null }) {
  return audit.record({
    actorId,
    action: `ai.tool.${toolName}`,
    resourceType: 'ai_tool',
    resourceId: toolName,
    outcome,
    code,
  });
}

function failureCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9][a-z0-9._-]{0,119}$/.test(error.code)
    ? error.code
    : 'ai_tool_failed';
}

function validateDependencies(app, registry, audit, policyOverrides) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new AiHttpError('invalid_ai_http_app', 'AI HTTP app is invalid');
  }
  if (!registry || ['list', 'get', 'prepare', 'execute'].some((method) => typeof registry[method] !== 'function')) {
    throw new AiHttpError('invalid_ai_tool_registry', 'AI HTTP requires the tool registry');
  }
  if (!audit || typeof audit.record !== 'function') {
    throw new AiHttpError('invalid_ai_audit_store', 'AI HTTP requires the audit store');
  }
  if (!policyOverrides || typeof policyOverrides !== 'object' || Array.isArray(policyOverrides)) {
    throw new AiHttpError('invalid_ai_policy_overrides', 'AI policy overrides are invalid');
  }
}

export function mountAiRoutes(app, {
  registry,
  audit,
  policyOverrides = {},
} = {}) {
  validateDependencies(app, registry, audit, policyOverrides);

  app.get('/api/ai/tools', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const data = registry.list().map((tool) => Object.freeze({
      ...tool,
      policy: evaluateAiToolPolicy({ tool, auth: request.auth, overrides: policyOverrides }),
    }));
    return response.json({ data });
  }));

  app.post('/api/ai/tools/:toolName/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const toolName = normalizeToolName(request.params.toolName);
    const { input } = previewBody(request.body);
    const plan = createAiActionPlan({
      registry,
      name: toolName,
      input,
      auth: request.auth,
      overrides: policyOverrides,
    });
    return response.json({ data: plan });
  }));

  app.post('/api/ai/tools/:toolName/execute', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const toolName = normalizeToolName(request.params.toolName);
    const body = executeBody(request.body);
    const plan = createAiActionPlan({
      registry,
      name: toolName,
      input: body.input,
      auth: request.auth,
      overrides: policyOverrides,
    });
    if (plan.decision === 'confirm') {
      verifyAiActionExecution({
        plan,
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      });
    }

    const actorId = request.auth.user.id;
    if (plan.tool.risk !== 'read') {
      auditEvent(audit, { actorId, toolName, outcome: 'accepted' });
    }
    try {
      const result = await registry.execute({
        name: toolName,
        input: body.input,
        context: Object.freeze({ actorId, role: request.auth.user.role }),
      });
      if (plan.tool.risk === 'read') {
        auditEvent(audit, { actorId, toolName, outcome: 'succeeded' });
      }
      return response.json({ data: Object.freeze({ tool: plan.tool, result }) });
    } catch (error) {
      auditEvent(audit, { actorId, toolName, outcome: 'failed', code: failureCode(error) });
      throw error;
    }
  }));
}

export const aiHttpInternals = Object.freeze({
  normalizeToolName,
  normalizeBody,
  previewBody,
  executeBody,
  failureCode,
  auditEvent,
  validateDependencies,
});
