import { createAiActionPlan, verifyAiActionExecution } from './ai-action-plan.js';
import { evaluateAiToolPolicy } from './ai-policy.js';
import { createProviderFromConfig } from './ai-provider-adapters.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const PROVIDER_FIELDS = new Set(['id', 'type', 'apiKey', 'baseUrl', 'defaultModel', 'makeActive']);

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

function providerBody(body) {
  const value = normalizeBody(body, PROVIDER_FIELDS);
  if (value.id != null && typeof value.id !== 'string') {
    throw new AiHttpError('invalid_ai_provider_request', 'AI provider id must be a string');
  }
  if (value.type != null && typeof value.type !== 'string') {
    throw new AiHttpError('invalid_ai_provider_request', 'AI provider type must be a string');
  }
  if (value.apiKey != null && typeof value.apiKey !== 'string') {
    throw new AiHttpError('invalid_ai_provider_request', 'AI provider apiKey must be a string');
  }
  if (value.baseUrl != null && typeof value.baseUrl !== 'string') {
    throw new AiHttpError('invalid_ai_provider_request', 'AI provider baseUrl must be a string');
  }
  if (value.defaultModel != null && typeof value.defaultModel !== 'string') {
    throw new AiHttpError('invalid_ai_provider_request', 'AI provider defaultModel must be a string');
  }
  return {
    id: value.id,
    type: value.type,
    apiKey: value.apiKey,
    baseUrl: value.baseUrl,
    defaultModel: value.defaultModel,
    makeActive: Boolean(value.makeActive),
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

function validateDependencies(app, registry, audit, policyOverrides, policyStore, providerRegistry) {
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
  if (providerRegistry !== null && (!providerRegistry
    || ['listProviders', 'getProvider', 'setProvider', 'deleteProvider', 'setActiveProvider', 'getActiveProvider']
      .some((method) => typeof providerRegistry[method] !== 'function'))) {
    throw new AiHttpError('invalid_ai_provider_registry', 'AI provider registry is invalid');
  }
}

export function mountAiRoutes(app, {
  registry,
  audit,
  policyOverrides = {},
  policyStore = null,
  providerRegistry = null,
  conversationService = null,
} = {}) {
  validateDependencies(app, registry, audit, policyOverrides, policyStore, providerRegistry);

  if (providerRegistry) {
    app.get('/api/ai/providers', requireAiOwner, asyncRoute(async (_request, response) => {
      const providers = await providerRegistry.listProviders();
      const active = await providerRegistry.getActiveProvider();
      return response.json({ data: providers, activeProviderId: active?.id ?? null });
    }));

    app.post('/api/ai/providers', requireAiOwner, asyncRoute(async (request, response) => {
      const body = providerBody(request.body);
      const actorId = request.auth.user.id;
      try {
        const provider = await providerRegistry.setProvider(body);
        audit.record({
          actorId,
          action: 'ai.provider.save',
          resourceType: 'ai_provider',
          resourceId: provider.id,
          outcome: 'succeeded',
          code: null,
        });
        return response.status(201).json({ data: provider });
      } catch (error) {
        audit.record({
          actorId,
          action: 'ai.provider.save',
          resourceType: 'ai_provider',
          resourceId: body.id ?? 'unknown',
          outcome: 'failed',
          code: failureCode(error),
        });
        throw error;
      }
    }));

    app.delete('/api/ai/providers/:providerId', requireAiOwner, asyncRoute(async (request, response) => {
      const providerId = request.params.providerId;
      const actorId = request.auth.user.id;
      const deleted = await providerRegistry.deleteProvider(providerId);
      if (!deleted) {
        throw new AiHttpError('provider_not_found', 'AI provider not found', 404);
      }
      audit.record({
        actorId,
        action: 'ai.provider.delete',
        resourceType: 'ai_provider',
        resourceId: providerId,
        outcome: 'succeeded',
        code: null,
      });
      return response.json({ data: { success: true } });
    }));

    app.post('/api/ai/providers/:providerId/active', requireAiOwner, asyncRoute(async (request, response) => {
      const providerId = request.params.providerId;
      const actorId = request.auth.user.id;
      const provider = await providerRegistry.setActiveProvider(providerId);
      audit.record({
        actorId,
        action: 'ai.provider.set_active',
        resourceType: 'ai_provider',
        resourceId: providerId,
        outcome: 'succeeded',
        code: null,
      });
      return response.json({ data: provider });
    }));

    app.post('/api/ai/providers/:providerId/test', requireAiOwner, asyncRoute(async (request, response) => {
      const providerId = request.params.providerId;
      const provider = await providerRegistry.getDecryptedProvider(providerId);
      if (!provider) {
        throw new AiHttpError('provider_not_found', 'AI provider not found', 404);
      }
      try {
        const adapter = createProviderFromConfig(provider);
        const testResult = await adapter.invoke({
          messages: [{ role: 'user', text: 'Respond with the word "pong" only.' }],
        });
        return response.json({ data: { success: true, response: testResult } });
      } catch (error) {
        throw new AiHttpError('provider_test_failed', `Provider connection test failed: ${error.message}`, 502);
      }
    }));
  }

  if (conversationService) {
    app.get('/api/ai/conversations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const query = normalizeBody(request.query, new Set(['websiteId', 'limit', 'cursor']));
      const websiteId = query.websiteId ?? null;
      if ((websiteId !== null && typeof websiteId !== 'string')
        || (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]?$/.test(query.limit)))
        || (query.cursor !== undefined && typeof query.cursor !== 'string')) {
        throw new AiHttpError('invalid_ai_history_query', 'History query is invalid.');
      }
      const options = { websiteId, auth: request.auth };
      const list = query.limit !== undefined || query.cursor !== undefined
        ? await conversationService.listConversationPage({ ...options, limit: query.limit === undefined ? 20 : Number(query.limit), cursor: query.cursor ?? null })
        : await conversationService.listConversations(options);
      return response.json({ data: list });
    }));

    app.post('/api/ai/conversations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const body = normalizeBody(request.body, new Set(['title', 'websiteId']));
      const conversation = await conversationService.createConversation({ title: body.title, websiteId: body.websiteId ?? null, auth: request.auth });
      return response.status(201).json({ data: conversation });
    }));

    app.get('/api/ai/conversations/:conversationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const conversation = await conversationService.getConversation(request.params.conversationId, { auth: request.auth });
      if (!conversation) throw new AiHttpError('conversation_not_found', 'Conversation not found', 404);
      return response.json({ data: conversation });
    }));

    app.delete('/api/ai/conversations/:conversationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const deleted = await conversationService.deleteConversation(request.params.conversationId, { auth: request.auth });
      if (!deleted) throw new AiHttpError('conversation_not_found', 'Conversation not found', 404);
      return response.json({ data: { success: true } });
    }));

    app.post('/api/ai/conversations/:conversationId/messages', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const text = request.body?.text;
      const message = await conversationService.sendMessage({
        conversationId: request.params.conversationId,
        text,
        auth: request.auth,
      });
      return response.json({ data: message });
    }));

    app.post('/api/ai/conversations/:conversationId/messages/stream', requirePanelRouteAccess, async (request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.setHeader('cache-control', 'no-cache');
      response.setHeader('connection', 'keep-alive');
      response.setHeader('x-accel-buffering', 'no');
      response.flushHeaders?.();

      const sendEvent = (event) => {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      try {
        await conversationService.sendMessage({
          conversationId: request.params.conversationId,
          text: request.body?.text,
          auth: request.auth,
          onEvent: sendEvent,
        });
        response.end();
      } catch (err) {
        sendEvent({ type: 'error', code: err.code || 'chat_error', message: err.message });
        response.end();
      }
    });
  }

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
  providerBody,
  policyPreviewBody,
  policyApplyBody,
  currentPolicyOverrides,
  failureCode,
  auditEvent,
  validateDependencies,
});
