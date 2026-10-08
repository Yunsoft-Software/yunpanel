import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiOrchestrator, AiOrchestratorError } from '../src/ai-orchestrator.js';
import { createAiProviderAdapter } from '../src/ai-provider.js';
import { createAiToolRegistry } from '../src/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';

const ownerAuth = Object.freeze({
  user: Object.freeze({ id: 'owner-user-1', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const readOnlyAuth = Object.freeze({
  user: Object.freeze({ id: 'reader-1', role: 'read_only' }),
  access: Object.freeze({ mode: 'read_only', permissions: Object.freeze(['audit.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

const customerTenantAuth = Object.freeze({
  user: Object.freeze({ id: 'cust-1', role: 'customer', tenantId: 'cust-tenant-1' }),
  access: Object.freeze({ mode: 'customer', permissions: Object.freeze(['website.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

const resellerTenantAuth = Object.freeze({
  user: Object.freeze({ id: 'reseller-1', role: 'reseller', tenantId: 'reseller-tenant-1' }),
  access: Object.freeze({ mode: 'reseller', permissions: Object.freeze(['customer.manage']) }),
  security: Object.freeze({ managementAllowed: false }),
});

function createMockRegistry() {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ status: 'healthy' }));
  registry.bind('website.list', async () => [{ id: 'site-1' }]);
  registry.bind('website.inspect', async ({ input }) => ({ websiteId: input.websiteId }));
  registry.bind('website.restart', async ({ input }) => ({ restarted: true, websiteId: input.websiteId }));
  registry.bind('application.deploy', async ({ input }) => ({ deployed: true, applicationId: input.applicationId }));
  registry.bind('service.restart', async ({ input }) => ({ serviceId: input.serviceId, restarted: true }));
  registry.bind('backup.create', async ({ input }) => ({ created: true, websiteId: input.websiteId }));
  registry.bind('backup.restore', async ({ input }) => ({ restored: true, websiteId: input.websiteId, snapshotId: input.snapshotId }));
  return registry;
}

test('AI Orchestrator: validates provider, registry, and policyOverrides dependencies', () => {
  const registry = createMockRegistry();
  const provider = createAiProviderAdapter({
    id: 'test-provider',
    invoke: async () => ({ type: 'message', text: 'ok' }),
  });

  assert.throws(
    () => createAiOrchestrator({ provider: null, registry }),
    (err) => err instanceof AiOrchestratorError && err.code === 'invalid_ai_provider',
  );
  assert.throws(
    () => createAiOrchestrator({ provider, registry: null }),
    (err) => err instanceof AiOrchestratorError && err.code === 'invalid_ai_tool_registry',
  );
  assert.throws(
    () => createAiOrchestrator({ provider, registry, policyOverrides: 'invalid' }),
    (err) => err instanceof AiOrchestratorError && err.code === 'invalid_ai_policy_overrides',
  );

  const orchestrator = createAiOrchestrator({ provider, registry });
  assert.equal(typeof orchestrator.availableTools, 'function');
  assert.equal(typeof orchestrator.proposeTurn, 'function');
});

test('AI Orchestrator: Owner session exposes bound read diagnostics and reversible write tools', () => {
  const registry = createMockRegistry();
  const provider = createAiProviderAdapter({
    id: 'test-provider',
    invoke: async () => ({ type: 'message', text: 'ok' }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  const tools = orchestrator.availableTools(ownerAuth);
  const toolNames = tools.map((t) => t.tool.name);
  assert.ok(toolNames.includes('server.health'));
  assert.ok(toolNames.includes('website.inspect'));
  assert.ok(toolNames.includes('website.restart'));
  assert.ok(toolNames.includes('application.deploy'));
  assert.ok(toolNames.includes('service.restart'));
  assert.ok(toolNames.includes('backup.create'));
  assert.ok(toolNames.includes('backup.restore'));
  // Unbound tools must NOT be present
  assert.ok(!toolNames.includes('dns.inspect'));
  assert.ok(!toolNames.includes('mail.inspect'));
});

test('AI Orchestrator: Read-only and tenant actors fail-closed with zero unauthorized write tools', () => {
  const registry = createMockRegistry();
  const provider = createAiProviderAdapter({
    id: 'test-provider',
    invoke: async () => ({ type: 'message', text: 'ok' }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  // Read-only actor sees only read tools
  const readOnlyTools = orchestrator.availableTools(readOnlyAuth);
  assert.ok(readOnlyTools.length > 0);
  assert.ok(readOnlyTools.every((t) => t.tool.risk === 'read'));
  assert.ok(!readOnlyTools.some((t) => t.tool.name === 'website.restart'));
  assert.ok(!readOnlyTools.some((t) => t.tool.name === 'application.deploy'));
  assert.ok(!readOnlyTools.some((t) => t.tool.name === 'service.restart'));
  assert.ok(!readOnlyTools.some((t) => t.tool.name === 'backup.create'));
  assert.ok(!readOnlyTools.some((t) => t.tool.name === 'backup.restore'));

  // Tenant customer sees zero management tools
  const customerTools = orchestrator.availableTools(customerTenantAuth);
  assert.equal(customerTools.length, 0);

  // Tenant reseller sees zero management tools
  const resellerTools = orchestrator.availableTools(resellerTenantAuth);
  assert.equal(resellerTools.length, 0);

  // Unauthenticated actor sees zero tools
  const anonTools = orchestrator.availableTools(null);
  assert.equal(anonTools.length, 0);
});

test('AI Orchestrator: returns assistant message turn when provider outputs text', async () => {
  const registry = createMockRegistry();
  const provider = createAiProviderAdapter({
    id: 'provider-gemini',
    invoke: async () => ({ type: 'message', text: 'Everything looks healthy.' }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  const turn = await orchestrator.proposeTurn({
    model: 'gemini-1.5-pro',
    messages: [{ role: 'user', text: 'Check server state' }],
    auth: ownerAuth,
  });

  assert.equal(turn.type, 'message');
  assert.equal(turn.provider, 'provider-gemini');
  assert.equal(turn.message.role, 'assistant');
  assert.equal(turn.message.text, 'Everything looks healthy.');
});

test('AI Orchestrator: turns provider tool calls into action proposals with risk-appropriate plans', async () => {
  let executionCount = 0;
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => { executionCount += 1; return { ok: true }; });
  registry.bind('website.inspect', async () => { executionCount += 1; return { ok: true }; });
  registry.bind('application.deploy', async () => { executionCount += 1; return { ok: true }; });
  registry.bind('backup.restore', async () => { executionCount += 1; return { ok: true }; });

  const provider = createAiProviderAdapter({
    id: 'provider-test',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [
        { id: 'call-1', name: 'server.health', input: {} },
        { id: 'call-2', name: 'website.inspect', input: { websiteId: 'site-alpha' } },
        { id: 'call-3', name: 'application.deploy', input: { applicationId: 'app-beta' } },
        { id: 'call-4', name: 'backup.restore', input: { websiteId: 'site-alpha', snapshotId: 'snap-1' } },
      ],
    }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  const turn = await orchestrator.proposeTurn({
    model: 'model-1',
    messages: [{ role: 'user', text: 'Inspect and deploy' }],
    auth: ownerAuth,
  });

  assert.equal(turn.type, 'tool_proposals');
  assert.equal(turn.provider, 'provider-test');
  assert.equal(turn.proposals.length, 4);

  // Read tools: autoExecutable
  const [healthProp, inspectProp, deployProp, restoreProp] = turn.proposals;
  assert.equal(healthProp.name, 'server.health');
  assert.equal(healthProp.autoExecutable, true);
  assert.equal(healthProp.plan.decision, 'allow');

  assert.equal(inspectProp.name, 'website.inspect');
  assert.equal(inspectProp.autoExecutable, true);
  assert.equal(inspectProp.plan.decision, 'allow');

  // Reversible write with default confirm: NOT autoExecutable, requires confirmation
  assert.equal(deployProp.name, 'application.deploy');
  assert.equal(deployProp.autoExecutable, false);
  assert.equal(deployProp.plan.decision, 'confirm');
  assert.match(deployProp.plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(deployProp.plan.confirmation, `ai:application.deploy:${deployProp.plan.previewDigest}`);

  // Destructive write: ALWAYS confirmation
  assert.equal(restoreProp.name, 'backup.restore');
  assert.equal(restoreProp.autoExecutable, false);
  assert.equal(restoreProp.plan.decision, 'confirm');
  assert.match(restoreProp.plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(restoreProp.plan.confirmation, `ai:backup.restore:${restoreProp.plan.previewDigest}`);

  // Critical: Proposing a turn NEVER executes handlers
  assert.equal(executionCount, 0);
});

test('AI Orchestrator: fails closed if provider requests an unavailable or denied tool', async () => {
  const registry = createMockRegistry();
  const provider = createAiProviderAdapter({
    id: 'provider-test',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [{ id: 'call-bad', name: 'service.restart', input: { serviceId: 'nginx' } }],
    }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  // Read-only actor cannot run service.restart
  await assert.rejects(
    orchestrator.proposeTurn({
      model: 'm',
      messages: [{ role: 'user', text: 'restart nginx' }],
      auth: readOnlyAuth,
    }),
    (err) => err instanceof AiOrchestratorError && err.code === 'ai_provider_requested_disallowed_tool',
  );

  // Non-existent tool fails closed
  const providerUnknown = createAiProviderAdapter({
    id: 'provider-test',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [{ id: 'call-unknown', name: 'raw.shell.exec', input: { cmd: 'id' } }],
    }),
  });
  const orchestratorUnknown = createAiOrchestrator({ provider: providerUnknown, registry });
  await assert.rejects(
    orchestratorUnknown.proposeTurn({
      model: 'm',
      messages: [{ role: 'user', text: 'run command' }],
      auth: ownerAuth,
    }),
    (err) => err instanceof AiOrchestratorError && err.code === 'ai_provider_requested_disallowed_tool',
  );
});

test('AI Orchestrator: rejects excessive tool proposals exceeding maximum limit (MAX_PROPOSALS = 8)', async () => {
  const registry = createMockRegistry();
  const calls = Array.from({ length: 9 }, (_, i) => ({
    id: `call-${i}`,
    name: 'server.health',
    input: {},
  }));
  const rawProvider = {
    id: 'flood-provider',
    complete: async () => ({ type: 'tool_calls', calls }),
  };
  const orchestrator = createAiOrchestrator({ provider: rawProvider, registry });

  await assert.rejects(
    orchestrator.proposeTurn({
      model: 'm',
      messages: [{ role: 'user', text: 'inspect all' }],
      auth: ownerAuth,
    }),
    (err) => err instanceof AiOrchestratorError && err.code === 'too_many_ai_tool_proposals' && err.status === 502,
  );
});

test('AI Orchestrator: rejects invalid schema inputs and prompt injection attempts before execution', async () => {
  const registry = createMockRegistry();
  const provider = createAiProviderAdapter({
    id: 'inject-provider',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [{
        id: 'call-inject',
        name: 'website.inspect',
        input: {
          websiteId: 'site-1',
          maliciousField: '; rm -rf / ; cat /etc/shadow',
        },
      }],
    }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  // Additional fields rejected by schema
  await assert.rejects(
    orchestrator.proposeTurn({
      model: 'm',
      messages: [{ role: 'user', text: 'inspect' }],
      auth: ownerAuth,
    }),
    (err) => err.code === 'invalid_ai_tool_input',
  );
});

test('AI Orchestrator: passes abort signal to provider.complete', async () => {
  const registry = createMockRegistry();
  let receivedSignal = null;
  const provider = createAiProviderAdapter({
    id: 'signal-provider',
    invoke: async (req) => {
      receivedSignal = req.signal;
      return { type: 'message', text: 'done' };
    },
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  const controller = new AbortController();
  await orchestrator.proposeTurn({
    model: 'm',
    messages: [{ role: 'user', text: 'test' }],
    auth: ownerAuth,
    signal: controller.signal,
  });

  assert.equal(receivedSignal, controller.signal);
});

test('AI Orchestrator: propagates state and epoch to action plans for drift and restart protection', async () => {
  const registry = createMockRegistry();
  const provider = createAiProviderAdapter({
    id: 'state-provider',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [{ id: 'call-1', name: 'service.restart', input: { serviceId: 'nginx' } }],
    }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });

  const turn = await orchestrator.proposeTurn({
    model: 'm',
    messages: [{ role: 'user', text: 'restart nginx' }],
    auth: ownerAuth,
    state: { revision: 1 },
    epoch: 10,
  });

  assert.equal(turn.type, 'tool_proposals');
  assert.equal(turn.proposals[0].plan.epoch, 10);
  assert.ok(turn.proposals[0].plan.stateFingerprint);
  assert.match(turn.proposals[0].plan.previewDigest, /^[a-f0-9]{64}$/);
});
