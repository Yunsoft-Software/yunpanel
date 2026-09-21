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

function requireAiOwner(request, response, next) {
  return requirePanelRouteAccess(request, response, () => {
    if (request.auth?.user?.role === 'owner') return next();
    return response.status(403).json({ error: { code: 'forbidden', message: 'Owner access is required.' } });
  });
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

function policyPreviewBody(body) {
  const value = normalizeBody(body, new Set(['expectedRevision', 'tool', 'risk']));
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) {
    throw new AiHttpError('invalid_ai_policy_revision', 'AI policy expected revision is invalid');
  }
  return { expectedRevision: value.expectedRevision, tool: value.tool ?? {}, risk: value.risk ?? {} };
}

function policyApplyBody(body) {
  const value = normalizeBody(body, new Set(['expectedRevision', 'tool', 'risk', 'previewDigest', 'confirmation']));
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || typeof value.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewDigest)
    || typeof value.confirmation !== 'string') {
    throw new AiHttpError('invalid_ai_policy_request', 'AI policy apply request is invalid');
  }
  return {
    expectedRevision: value.expectedRevision,
    tool: value.tool ?? {},
    risk: value.risk ?? {},
    previewDigest: value.previewDigest,
    confirmation: value.confirmation,
  };
}

async function currentPolicyOverrides(policyStore, fallback) {
  if (!policyStore) return fallback;
  return (await policyStore.getSnapshot()).overrides;
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

function validateDependencies(app, registry, audit, policyOverrides, policyStore) {
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
  if (policyStore !== null && (!policyStore
    || ['getSnapshot', 'previewUpdate', 'applyUpdate'].some((method) => typeof policyStore[method] !== 'function'))) {
    throw new AiHttpError('invalid_ai_policy_store', 'AI policy store is invalid');
  }
}

export function mountAiRoutes(app, {
  registry,
  audit,
  policyOverrides = {},
  policyStore = null,
} = {}) {
  validateDependencies(app, registry, audit, policyOverrides, policyStore);

  app.get('/api/ai/tools', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const overrides = await currentPolicyOverrides(policyStore, policyOverrides);
    const data = registry.list().map((tool) => Object.freeze({
      ...tool,
      policy: evaluateAiToolPolicy({ tool, auth: request.auth, overrides }),
    }));
    return response.json({ data });
  }));

  app.post('/api/ai/tools/:toolName/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const toolName = normalizeToolName(request.params.toolName);
    const { input } = previewBody(request.body);
    const overrides = await currentPolicyOverrides(policyStore, policyOverrides);
    const plan = createAiActionPlan({
      registry,
      name: toolName,
      input,
      auth: request.auth,
      overrides,
    });
    return response.json({ data: plan });
  }));

  if (policyStore) {
    app.get('/api/ai/policy', requireAiOwner, asyncRoute(async (_request, response) => (
      response.json({ data: await policyStore.getSnapshot() })
    )));

    app.post('/api/ai/policy/preview', requireAiOwner, asyncRoute(async (request, response) => {
      const preview = await policyStore.previewUpdate(policyPreviewBody(request.body));
      return response.json({ data: preview });
    }));

    app.post('/api/ai/policy', requireAiOwner, asyncRoute(async (request, response) => {
      const actorId = request.auth.user.id;
      try {
        const snapshot = await policyStore.applyUpdate(policyApplyBody(request.body));
        audit.record({
          actorId,
          action: 'ai.policy.update',
          resourceType: 'ai_policy',
          resourceId: 'global',
          outcome: 'succeeded',
          code: null,
        });
        return response.json({ data: snapshot });
      } catch (error) {
        audit.record({
          actorId,
          action: 'ai.policy.update',
          resourceType: 'ai_policy',
          resourceId: 'global',
          outcome: 'failed',
          code: failureCode(error),
        });
        throw error;
      }
    }));
  }

  app.post('/api/ai/tools/:toolName/execute', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const toolName = normalizeToolName(request.params.toolName);
    const body = executeBody(request.body);
    const overrides = await currentPolicyOverrides(policyStore, policyOverrides);
    const plan = createAiActionPlan({
      registry,
      name: toolName,
      input: body.input,
      auth: request.auth,
      overrides,
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
  policyPreviewBody,
  policyApplyBody,
  currentPolicyOverrides,
  failureCode,
  auditEvent,
  validateDependencies,
});
