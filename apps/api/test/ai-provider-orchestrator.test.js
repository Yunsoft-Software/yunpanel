import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiProviderAdapter, AiProviderError } from '../src/ai-provider.js';
import { createAiToolRegistry } from '../src/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import { createAiOrchestrator } from '../src/ai-orchestrator.js';

const ownerAuth = Object.freeze({
  user: Object.freeze({ id: 'owner-1', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ managementAllowed: true }),
});

function registryFixture() {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('website.inspect', async () => ({ ok: true }));
  registry.bind('application.deploy', async () => ({ queued: true }));
  return registry;
}

test('provider adapter sends only normalized bounded messages and tools to the provider', async () => {
  let seen;
  const provider = createAiProviderAdapter({
    id: 'fixture',
    invoke: async (request) => {
      seen = request;
      return { type: 'message', text: 'ok' };
    },
  });
  const result = await provider.complete({
    model: 'model-1',
    messages: [{ role: 'user', text: 'inspect the site' }],
    tools: [{ name: 'website.inspect', description: 'Inspect site', inputSchema: { type: 'object' } }],
  });
  assert.deepEqual(result, { type: 'message', text: 'ok' });
  assert.equal(seen.messages[0].role, 'user');
  assert.equal(seen.tools[0].name, 'website.inspect');
  assert.equal(Object.hasOwn(seen, 'apiKey'), false);
});

test('provider adapter rejects malformed or duplicate tool calls', async () => {
  const duplicate = createAiProviderAdapter({
    id: 'fixture',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [
        { id: 'call-1', name: 'website.inspect', input: { websiteId: 'site-1' } },
        { id: 'call-1', name: 'website.inspect', input: { websiteId: 'site-2' } },
      ],
    }),
  });
  await assert.rejects(
    duplicate.complete({ model: 'm', messages: [{ role: 'user', text: 'x' }] }),
    (error) => error instanceof AiProviderError && error.code === 'duplicate_ai_provider_call_id',
  );
});

test('orchestrator exposes only bound and policy-allowed tools to the provider', async () => {
  const registry = registryFixture();
  let seenTools;
  const provider = createAiProviderAdapter({
    id: 'fixture',
    invoke: async ({ tools }) => {
      seenTools = tools.map((tool) => tool.name);
      return { type: 'message', text: 'done' };
    },
  });
  const orchestrator = createAiOrchestrator({ provider, registry });
  const result = await orchestrator.proposeTurn({
    model: 'm',
    messages: [{ role: 'user', text: 'what is wrong?' }],
    auth: ownerAuth,
  });
  assert.equal(result.type, 'message');
  assert.deepEqual(seenTools, ['application.deploy', 'website.inspect']);
});

test('orchestrator turns provider tool calls into policy-bound action proposals without executing them', async () => {
  const registry = registryFixture();
  let calls = 0;
  registry.bind('job.inspect', async () => { calls += 1; return { id: 'job-1' }; });
  const provider = createAiProviderAdapter({
    id: 'fixture',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [
        { id: 'call-read', name: 'website.inspect', input: { websiteId: 'site-1' } },
        { id: 'call-write', name: 'application.deploy', input: { applicationId: 'app-1' } },
      ],
    }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });
  const result = await orchestrator.proposeTurn({
    model: 'm',
    messages: [{ role: 'user', text: 'inspect then deploy' }],
    auth: ownerAuth,
  });
  assert.equal(result.type, 'tool_proposals');
  assert.equal(result.proposals.length, 2);
  assert.equal(result.proposals[0].autoExecutable, true);
  assert.equal(result.proposals[1].plan.decision, 'confirm');
  assert.match(result.proposals[1].plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(calls, 0);
});

test('orchestrator fails closed if provider asks for an unavailable or denied tool', async () => {
  const registry = registryFixture();
  const provider = createAiProviderAdapter({
    id: 'fixture',
    invoke: async () => ({
      type: 'tool_calls',
      calls: [{ id: 'call-1', name: 'backup.restore', input: { websiteId: 'site-1', snapshotId: 'snap-1' } }],
    }),
  });
  const orchestrator = createAiOrchestrator({ provider, registry });
  await assert.rejects(
    orchestrator.proposeTurn({ model: 'm', messages: [{ role: 'user', text: 'restore' }], auth: ownerAuth }),
    (error) => error.code === 'ai_provider_requested_disallowed_tool',
  );
});
