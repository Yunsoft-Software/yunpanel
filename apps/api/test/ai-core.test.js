import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import { AiToolRegistryError, createAiToolRegistry } from '../src/ai-tool-registry.js';
import { evaluateAiToolPolicy } from '../src/ai-policy.js';

const ownerAuth = Object.freeze({
  user: Object.freeze({ id: 'owner-1', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const readOnlyAuth = Object.freeze({
  user: Object.freeze({ id: 'reader-1', role: 'read_only' }),
  access: Object.freeze({ mode: 'read_only', permissions: Object.freeze(['audit.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

test('default AI tool catalog is strict, unique and starts with twenty high-value operations', () => {
  assert.equal(DEFAULT_AI_TOOL_DEFINITIONS.length, 20);
  assert.equal(new Set(DEFAULT_AI_TOOL_DEFINITIONS.map((tool) => tool.name)).size, 20);
  assert.ok(DEFAULT_AI_TOOL_DEFINITIONS.some((tool) => tool.name === 'backup.restore' && tool.confirmation === 'always'));
  assert.ok(DEFAULT_AI_TOOL_DEFINITIONS.some((tool) => tool.name === 'website.restart' && tool.defaultPolicy === 'allow'));
});

test('tool registry exposes metadata without handlers and refuses unbound execution', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const tools = registry.list();
  assert.equal(tools.length, 20);
  assert.equal(tools.find((tool) => tool.name === 'server.health').available, false);
  await assert.rejects(
    registry.execute({ name: 'server.health' }),
    (error) => error instanceof AiToolRegistryError && error.code === 'ai_tool_unavailable',
  );
});

test('bound tool receives cloned bounded input and cannot be bound twice', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  let seen;
  registry.bind('website.inspect', async ({ input, context, tool }) => {
    seen = { input, context, tool };
    input.websiteId = 'mutated-inside-handler';
    return { ok: true };
  });
  assert.equal(registry.get('website.inspect').available, true);
  const input = { websiteId: 'site-1' };
  assert.deepEqual(await registry.execute({ name: 'website.inspect', input, context: { actorId: 'owner-1' } }), { ok: true });
  assert.equal(input.websiteId, 'site-1');
  assert.equal(seen.context.actorId, 'owner-1');
  assert.equal(seen.tool.name, 'website.inspect');
  assert.throws(
    () => registry.bind('website.inspect', () => {}),
    (error) => error.code === 'ai_tool_already_bound',
  );
});

test('tool registry rejects oversized or non-object model input before handler execution', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  let calls = 0;
  registry.bind('logs.query', async () => { calls += 1; });
  await assert.rejects(registry.execute({ name: 'logs.query', input: 'raw-shell-command' }), (error) => error.code === 'invalid_ai_tool_input');
  await assert.rejects(registry.execute({ name: 'logs.query', input: { query: 'x'.repeat(70 * 1024) } }), (error) => error.code === 'ai_tool_input_too_large');
  assert.equal(calls, 0);
});

test('owner policy allows reads, preserves configurable defaults and accepts explicit configurable overrides', () => {
  const byName = new Map(DEFAULT_AI_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  assert.deepEqual(evaluateAiToolPolicy({ tool: byName.get('server.health'), auth: ownerAuth }), { decision: 'allow', reason: 'read_safe' });
  assert.deepEqual(evaluateAiToolPolicy({ tool: byName.get('application.deploy'), auth: ownerAuth }), { decision: 'confirm', reason: 'tool_default' });
  assert.deepEqual(evaluateAiToolPolicy({
    tool: byName.get('application.deploy'), auth: ownerAuth, overrides: { tool: { 'application.deploy': 'allow' } },
  }), { decision: 'allow', reason: 'configured_override' });
  assert.deepEqual(evaluateAiToolPolicy({
    tool: byName.get('website.restart'), auth: ownerAuth, overrides: { risk: { reversible_write: 'deny' } },
  }), { decision: 'deny', reason: 'explicit_deny' });
});

test('always-confirm destructive tools cannot be weakened by full-access override', () => {
  const restore = DEFAULT_AI_TOOL_DEFINITIONS.find((tool) => tool.name === 'backup.restore');
  assert.deepEqual(evaluateAiToolPolicy({
    tool: restore,
    auth: ownerAuth,
    overrides: { tool: { 'backup.restore': 'allow' }, risk: { destructive: 'allow' } },
  }), { decision: 'confirm', reason: 'always_confirm' });
});

test('read-only actor can use read tools but cannot run mutations', () => {
  const byName = new Map(DEFAULT_AI_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  assert.deepEqual(evaluateAiToolPolicy({ tool: byName.get('website.inspect'), auth: readOnlyAuth }), { decision: 'allow', reason: 'read_only_safe' });
  assert.deepEqual(evaluateAiToolPolicy({ tool: byName.get('website.restart'), auth: readOnlyAuth }), { decision: 'deny', reason: 'owner_management_required' });
  assert.deepEqual(evaluateAiToolPolicy({ tool: byName.get('server.health'), auth: null }), { decision: 'deny', reason: 'owner_management_required' });
});


test('tool registry enforces the declared bounded input schema before execution', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  let calls = 0;
  registry.bind('website.inspect', async () => { calls += 1; return { ok: true }; });
  await assert.rejects(
    registry.execute({ name: 'website.inspect', input: {} }),
    (error) => error.code === 'invalid_ai_tool_input',
  );
  await assert.rejects(
    registry.execute({ name: 'website.inspect', input: { websiteId: 'site-1', extra: true } }),
    (error) => error.code === 'invalid_ai_tool_input',
  );
  assert.equal(calls, 0);
});
