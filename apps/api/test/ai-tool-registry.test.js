import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import {
  AiToolRegistryError,
  createAiToolRegistry,
  aiToolRegistryInternals,
  createAiMcpAdapter,
  AiMcpError,
  MCP_ERROR_CODES,
} from '../src/ai-tool-registry.js';
import { evaluateAiToolPolicy } from '../src/ai-policy.js';
import { createAiActionPlan } from '../src/ai-action-plan.js';
import { mountAiRoutes, mountAiMcpRoutes, aiHttpInternals } from '../src/ai-http.js';

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

const customerTenantAuth = Object.freeze({
  user: Object.freeze({ id: 'cust-1', role: 'customer', tenantId: 'tenant-1' }),
  access: Object.freeze({ mode: 'customer', permissions: Object.freeze(['website.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

const resellerTenantAuth = Object.freeze({
  user: Object.freeze({ id: 'reseller-1', role: 'reseller', tenantId: 'reseller-tenant-1' }),
  access: Object.freeze({ mode: 'reseller', permissions: Object.freeze(['customer.manage']) }),
  security: Object.freeze({ managementAllowed: false }),
});

function createMockAudit() {
  const events = [];
  return {
    events,
    record(event) {
      events.push(event);
      return event;
    },
  };
}

// =========================================================================
// Section 1: Tool Registry Core & Schema Validation
// =========================================================================

test('Tool Registry: validates definitions, normalizes schemas, and lists metadata', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const tools = registry.list();
  assert.equal(tools.length, 20);
  assert.equal(new Set(tools.map((t) => t.name)).size, 20);

  const serverHealth = registry.get('server.health');
  assert.equal(serverHealth.name, 'server.health');
  assert.equal(serverHealth.risk, 'read');
  assert.equal(serverHealth.confirmation, 'never');
  assert.equal(serverHealth.defaultPolicy, 'allow');
  assert.equal(serverHealth.available, false);
});

test('Tool Registry: rejects duplicate definitions and malformed metadata', () => {
  const validDef = DEFAULT_AI_TOOL_DEFINITIONS[0];
  assert.throws(
    () => createAiToolRegistry({ definitions: [validDef, validDef] }),
    (err) => err instanceof AiToolRegistryError && err.code === 'duplicate_ai_tool',
  );
  assert.throws(
    () => createAiToolRegistry({ definitions: 'not-an-array' }),
    (err) => err instanceof AiToolRegistryError && err.code === 'invalid_ai_tool_definitions',
  );
  assert.throws(
    () => createAiToolRegistry({ definitions: [{ ...validDef, name: 'INVALID_CAPS' }] }),
    (err) => err instanceof AiToolRegistryError && err.code === 'invalid_ai_tool_name',
  );
});

test('Tool Registry: binds handlers once and rejects duplicate binding', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  assert.equal(registry.get('website.list').available, false);

  registry.bind('website.list', async () => [{ id: 'site-1', domain: 'example.com' }]);
  assert.equal(registry.get('website.list').available, true);

  assert.throws(
    () => registry.bind('website.list', async () => []),
    (err) => err instanceof AiToolRegistryError && err.code === 'ai_tool_already_bound',
  );
  assert.throws(
    () => registry.bind('website.list', 'not-a-function'),
    (err) => err instanceof AiToolRegistryError && err.code === 'invalid_ai_tool_handler',
  );
  assert.throws(
    () => registry.bind('non.existent.tool', async () => {}),
    (err) => err instanceof AiToolRegistryError && err.code === 'ai_tool_not_found',
  );
});

test('Tool Registry: refuses execution of unbound tool', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  await assert.rejects(
    registry.execute({ name: 'website.list' }),
    (err) => err instanceof AiToolRegistryError && err.code === 'ai_tool_unavailable',
  );
});

test('Tool Registry: strictly enforces inputSchema bounds and immutability', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  let receivedInput = null;
  registry.bind('website.inspect', async ({ input }) => {
    receivedInput = input;
    input.websiteId = 'tampered';
    return { ok: true };
  });

  // Missing required argument
  await assert.rejects(
    registry.execute({ name: 'website.inspect', input: {} }),
    (err) => err instanceof AiToolRegistryError && err.code === 'invalid_ai_tool_input',
  );

  // Extra unsupported property (additionalProperties: false)
  await assert.rejects(
    registry.execute({ name: 'website.inspect', input: { websiteId: 'site-1', extraField: 'injection' } }),
    (err) => err instanceof AiToolRegistryError && err.code === 'invalid_ai_tool_input',
  );

  // Non-object input
  await assert.rejects(
    registry.execute({ name: 'website.inspect', input: 'site-1' }),
    (err) => err instanceof AiToolRegistryError && err.code === 'invalid_ai_tool_input',
  );

  // Successful execution with cloned input
  const originalInput = { websiteId: 'site-original' };
  const result = await registry.execute({ name: 'website.inspect', input: originalInput });
  assert.deepEqual(result, { ok: true });
  assert.equal(originalInput.websiteId, 'site-original'); // Caller input not mutated
  assert.equal(receivedInput.websiteId, 'tampered'); // Handler mutation only affected its clone
});

test('Tool Registry: enforces 64KB input size limit', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('logs.query', async () => ({ count: 0 }));

  const oversized = 'a'.repeat(70 * 1024);
  await assert.rejects(
    registry.execute({ name: 'logs.query', input: { query: oversized } }),
    (err) => err instanceof AiToolRegistryError && err.code === 'ai_tool_input_too_large',
  );
});

// =========================================================================
// Section 2: Policy Engine & Action Plan Integration
// =========================================================================

test('Policy Engine: Owner can run reads, configurable write tools default appropriately', () => {
  const byName = new Map(DEFAULT_AI_TOOL_DEFINITIONS.map((t) => [t.name, t]));
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('server.health'), auth: ownerAuth }),
    { decision: 'allow', reason: 'read_safe' },
  );
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('website.restart'), auth: ownerAuth }),
    { decision: 'allow', reason: 'tool_default' },
  );
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('application.deploy'), auth: ownerAuth }),
    { decision: 'confirm', reason: 'tool_default' },
  );
});

test('Policy Engine: Destructive tools ALWAYS require confirmation and cannot be bypassed', () => {
  const restore = DEFAULT_AI_TOOL_DEFINITIONS.find((t) => t.name === 'backup.restore');
  // Attempt to override destructive tool to allow
  const policy = evaluateAiToolPolicy({
    tool: restore,
    auth: ownerAuth,
    overrides: {
      tool: { 'backup.restore': 'allow' },
      risk: { destructive: 'allow' },
    },
  });
  assert.deepEqual(policy, { decision: 'confirm', reason: 'always_confirm' });
});

test('Policy Engine: Read-only and tenant actors fail-closed on unauthorized operations', () => {
  const byName = new Map(DEFAULT_AI_TOOL_DEFINITIONS.map((t) => [t.name, t]));

  // Read-only actor allowed read tools, denied write tools
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('website.inspect'), auth: readOnlyAuth }),
    { decision: 'allow', reason: 'read_only_safe' },
  );
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('website.restart'), auth: readOnlyAuth }),
    { decision: 'deny', reason: 'owner_management_required' },
  );

  // Tenant customer denied all server-level tools
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('server.health'), auth: customerTenantAuth }),
    { decision: 'deny', reason: 'owner_management_required' },
  );
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('service.restart'), auth: customerTenantAuth }),
    { decision: 'deny', reason: 'owner_management_required' },
  );

  // Tenant reseller denied server-level tools
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('service.restart'), auth: resellerTenantAuth }),
    { decision: 'deny', reason: 'owner_management_required' },
  );

  // Unauthenticated actor denied
  assert.deepEqual(
    evaluateAiToolPolicy({ tool: byName.get('server.health'), auth: null }),
    { decision: 'deny', reason: 'owner_management_required' },
  );
});

// =========================================================================
// Section 3: MCP Adapter — Initialization and Tool Discovery
// =========================================================================

test('MCP Adapter: initialize returns standard MCP protocol version and server capabilities', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({ registry, serverInfo: { name: 'yunpanel-test', version: '2.0.0' } });

  const init = adapter.initialize();
  assert.equal(init.protocolVersion, '2024-11-05');
  assert.equal(init.serverInfo.name, 'yunpanel-test');
  assert.equal(init.serverInfo.version, '2.0.0');
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
  assert.ok(typeof init.instructions === 'string');
});

test('MCP Adapter: registry.createMcpAdapter factory helper produces functional adapter', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  assert.equal(typeof registry.createMcpAdapter, 'function');
  const adapter = registry.createMcpAdapter();
  assert.equal(adapter.initialize().protocolVersion, '2024-11-05');
});

test('MCP Adapter: tools/list requires authentication and fails-closed when unauthenticated', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({ registry });

  await assert.rejects(
    adapter.listTools({ auth: null }),
    (err) => err instanceof AiMcpError && err.code === 'unauthenticated' && err.status === 401,
  );

  const response = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  }, { auth: null });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.error.code, MCP_ERROR_CODES.UNAUTHORIZED);
});

test('MCP Adapter: tenant isolation prevents non-management actors from discovering restricted tools', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({ registry });

  // Customer discovers 0 server management tools
  const customerTools = await adapter.listTools({ auth: customerTenantAuth });
  assert.equal(customerTools.length, 0);

  // Reseller discovers 0 server management tools
  const resellerTools = await adapter.listTools({ auth: resellerTenantAuth });
  assert.equal(resellerTools.length, 0);

  // Read-only actor discovers only safe read tools (11 read tools)
  const readOnlyTools = await adapter.listTools({ auth: readOnlyAuth });
  assert.ok(readOnlyTools.length > 0);
  assert.ok(readOnlyTools.every((t) => {
    const orig = DEFAULT_AI_TOOL_DEFINITIONS.find((d) => d.name === t.name);
    return orig.risk === 'read';
  }));
  assert.ok(!readOnlyTools.some((t) => t.name === 'website.restart'));
  assert.ok(!readOnlyTools.some((t) => t.name === 'backup.restore'));
  assert.ok(!readOnlyTools.some((t) => t.name === 'service.restart'));
});

test('MCP Adapter: Owner discovers all allowed tools formatted in standard MCP schema', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({ registry });

  const tools = await adapter.listTools({ auth: ownerAuth });
  assert.equal(tools.length, 20);

  for (const tool of tools) {
    assert.ok(typeof tool.name === 'string');
    assert.ok(typeof tool.description === 'string');
    assert.equal(typeof tool.inputSchema, 'object');
    assert.equal(tool.inputSchema.type, 'object');
  }

  // MCP JSON-RPC protocol message tools/list
  const rpcResponse = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 'req-tools-1',
    method: 'tools/list',
    params: {},
  }, { auth: ownerAuth });

  assert.equal(rpcResponse.jsonrpc, '2.0');
  assert.equal(rpcResponse.id, 'req-tools-1');
  assert.ok(Array.isArray(rpcResponse.result.tools));
  assert.equal(rpcResponse.result.tools.length, 20);
});

test('MCP Adapter: tool discovery respects explicit policy overrides', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({
    registry,
    policyOverrides: {
      tool: { 'server.health': 'deny' },
      risk: { destructive: 'deny' },
    },
  });

  const tools = await adapter.listTools({ auth: ownerAuth });
  assert.ok(!tools.some((t) => t.name === 'server.health'));
  assert.ok(!tools.some((t) => t.name === 'backup.restore'));
  assert.ok(tools.some((t) => t.name === 'website.inspect'));
});

// =========================================================================
// Section 4: MCP Adapter — Tool Execution (tools/call) & Policy Enforcement
// =========================================================================

test('MCP Adapter: tools/call requires authentication and fails-closed', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ status: 'healthy' }));
  const adapter = createAiMcpAdapter({ registry });

  await assert.rejects(
    adapter.callTool({ name: 'server.health', auth: null }),
    (err) => err instanceof AiMcpError && err.code === 'unauthenticated' && err.status === 401,
  );

  const response = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'server.health', arguments: {} },
  }, { auth: null });

  assert.equal(response.error.code, MCP_ERROR_CODES.UNAUTHORIZED);
});

test('MCP Adapter: tenant customer attempting tool execution fails-closed with forbidden error', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('website.inspect', async () => ({ website: {} }));
  const audit = createMockAudit();
  const adapter = createAiMcpAdapter({ registry, audit });

  await assert.rejects(
    adapter.callTool({ name: 'website.inspect', arguments: { websiteId: 'site-1' }, auth: customerTenantAuth }),
    (err) => err instanceof AiMcpError && err.code === 'ai_tool_denied' && err.status === 403,
  );

  const rpcResponse = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'website.inspect', arguments: { websiteId: 'site-1' } },
  }, { auth: customerTenantAuth });

  assert.equal(rpcResponse.error.code, MCP_ERROR_CODES.FORBIDDEN);
  assert.ok(rpcResponse.error.message.includes('denied'));

  // Verified audit logged forbidden failure
  const deniedEvent = audit.events.find((e) => e.outcome === 'failed' && e.code === 'forbidden');
  assert.ok(deniedEvent);
  assert.equal(deniedEvent.actorId, 'cust-1');
  assert.equal(deniedEvent.resourceId, 'website.inspect');
});

test('MCP Adapter: read-only actor can invoke read tools but is denied write tools', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ memory: 'ok', disk: 'ok' }));
  registry.bind('website.restart', async () => ({ restarted: true }));
  const adapter = createAiMcpAdapter({ registry });

  // Read tool succeeds
  const readRes = await adapter.callTool({ name: 'server.health', auth: readOnlyAuth });
  assert.equal(readRes.isError, false);
  assert.ok(readRes.content[0].text.includes('memory'));

  // Write tool denied
  await assert.rejects(
    adapter.callTool({ name: 'website.restart', arguments: { websiteId: 'site-1' }, auth: readOnlyAuth }),
    (err) => err instanceof AiMcpError && err.code === 'ai_tool_denied' && err.status === 403,
  );

  const rpcResponse = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'website.restart', arguments: { websiteId: 'site-1' } },
  }, { auth: readOnlyAuth });

  assert.equal(rpcResponse.error.code, MCP_ERROR_CODES.FORBIDDEN);
});

test('MCP Adapter: Owner executes allowed tools and receives MCP standard text content', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  let receivedContext = null;
  registry.bind('website.inspect', async ({ input, context }) => {
    receivedContext = context;
    return { website: { id: input.websiteId, domain: 'example.com' } };
  });

  const audit = createMockAudit();
  const adapter = createAiMcpAdapter({ registry, audit });

  const rpcResponse = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'website.inspect',
      arguments: { websiteId: 'site-owner-1' },
    },
  }, { auth: ownerAuth });

  assert.equal(rpcResponse.jsonrpc, '2.0');
  assert.equal(rpcResponse.id, 20);
  assert.equal(rpcResponse.result.isError, false);
  assert.equal(rpcResponse.result.content[0].type, 'text');
  assert.ok(rpcResponse.result.content[0].text.includes('site-owner-1'));

  // Context received actorId and role
  assert.equal(receivedContext.actorId, 'owner-1');
  assert.equal(receivedContext.role, 'owner');

  // Audit logged
  assert.ok(audit.events.some((e) => e.action === 'ai.tool.website.inspect' && e.outcome === 'succeeded'));
});

test('MCP Adapter: schema validation fails-closed on invalid parameters or command injection', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('website.inspect', async () => ({ ok: true }));
  const adapter = createAiMcpAdapter({ registry });

  // Missing required argument
  const missingArg = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: { name: 'website.inspect', arguments: {} },
  }, { auth: ownerAuth });
  assert.equal(missingArg.error.code, MCP_ERROR_CODES.INVALID_PARAMS);

  // Attempting to pass shell command / extra field
  const injectionArg = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: { name: 'website.inspect', arguments: { websiteId: 'site-1', exec: 'rm -rf /' } },
  }, { auth: ownerAuth });
  assert.equal(injectionArg.error.code, MCP_ERROR_CODES.INVALID_PARAMS);

  // Unknown tool not in registry
  const unknownTool = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: { name: 'root.shell.exec', arguments: { cmd: 'id' } },
  }, { auth: ownerAuth });
  assert.equal(unknownTool.error.code, MCP_ERROR_CODES.METHOD_NOT_FOUND);
});

test('MCP Adapter: confirmation requirement enforces fail-closed execution without valid token', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('application.deploy', async ({ input }) => ({ deployed: true, appId: input.applicationId }));
  const adapter = createAiMcpAdapter({ registry });

  // 1. Initial call without confirmation must fail-closed with confirmation_required
  const initialCall = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/call',
    params: {
      name: 'application.deploy',
      arguments: { applicationId: 'app-node-1' },
    },
  }, { auth: ownerAuth });

  assert.equal(initialCall.error.code, MCP_ERROR_CODES.CONFIRMATION_REQUIRED);
  assert.ok(initialCall.error.data?.previewDigest);
  assert.ok(initialCall.error.data?.confirmation);
  const { previewDigest, confirmation } = initialCall.error.data;
  assert.equal(confirmation, `ai:application.deploy:${previewDigest}`);

  // 2. Call with invalid / forged confirmation fails closed
  const forgedCall = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'application.deploy',
      arguments: { applicationId: 'app-node-1' },
      previewDigest,
      confirmation: 'forged-confirmation-token',
    },
  }, { auth: ownerAuth });
  assert.equal(forgedCall.error.code, MCP_ERROR_CODES.CONFIRMATION_REQUIRED);

  // 3. Call with valid confirmation succeeds
  const confirmedCall = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: {
      name: 'application.deploy',
      arguments: { applicationId: 'app-node-1' },
      previewDigest,
      confirmation,
    },
  }, { auth: ownerAuth });

  assert.equal(confirmedCall.result.isError, false);
  assert.ok(confirmedCall.result.content[0].text.includes('app-node-1'));
});

test('MCP Adapter: destructive backup.restore ALWAYS requires confirmation even with overrides', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('backup.restore', async ({ input }) => ({ restored: true, snapshot: input.snapshotId }));
  const adapter = createAiMcpAdapter({
    registry,
    policyOverrides: {
      tool: { 'backup.restore': 'allow' },
      risk: { destructive: 'allow' },
    },
  });

  // Even with overrides attempting to auto-allow, destructive action cannot execute without confirmation
  const unconfirmed = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 40,
    method: 'tools/call',
    params: {
      name: 'backup.restore',
      arguments: { websiteId: 'web-1', snapshotId: 'snap-1' },
    },
  }, { auth: ownerAuth });

  assert.equal(unconfirmed.error.code, MCP_ERROR_CODES.CONFIRMATION_REQUIRED);
  const { previewDigest, confirmation } = unconfirmed.error.data;

  // Execute with valid confirmation
  const confirmed = await adapter.handleMessage({
    jsonrpc: '2.0',
    id: 41,
    method: 'tools/call',
    params: {
      name: 'backup.restore',
      arguments: { websiteId: 'web-1', snapshotId: 'snap-1' },
      previewDigest,
      confirmation,
    },
  }, { auth: ownerAuth });

  assert.equal(confirmed.result.isError, false);
  assert.ok(confirmed.result.content[0].text.includes('snap-1'));
});

// =========================================================================
// Section 5: Protocol Edge Cases, Batching, and Stdio Transport
// =========================================================================

test('MCP Adapter: handles ping and initialized notifications properly', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({ registry });

  // ping
  const pingRes = await adapter.handleMessage({ jsonrpc: '2.0', id: 50, method: 'ping' });
  assert.deepEqual(pingRes, { jsonrpc: '2.0', id: 50, result: {} });

  // notification has no id -> returns null
  const notifRes = await adapter.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notifRes, null);

  // unknown method
  const unknown = await adapter.handleMessage({ jsonrpc: '2.0', id: 51, method: 'unknown/method' });
  assert.equal(unknown.error.code, MCP_ERROR_CODES.METHOD_NOT_FOUND);
});

test('MCP Adapter: handles batch JSON-RPC requests', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ healthy: true }));
  const adapter = createAiMcpAdapter({ registry });

  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'server.health', arguments: {} } },
  ];

  const batchResponses = await adapter.handleMessage(batch, { auth: ownerAuth });
  assert.ok(Array.isArray(batchResponses));
  assert.equal(batchResponses.length, 2);
  assert.equal(batchResponses[0].id, 1);
  assert.equal(batchResponses[1].id, 2);
  assert.equal(batchResponses[1].result.isError, false);
});

test('MCP Adapter: handles string JSON-RPC parsing and parse errors', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({ registry });

  // Malformed JSON string
  const malformed = await adapter.handleMessage('{ invalid json string ...');
  assert.equal(malformed.error.code, MCP_ERROR_CODES.PARSE_ERROR);

  // Valid JSON string
  const valid = await adapter.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }));
  assert.equal(valid.id, 99);
  assert.deepEqual(valid.result, {});
});

test('MCP Adapter: Stdio handler reads line-delimited JSON-RPC and writes responses', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ status: 'online' }));
  const adapter = createAiMcpAdapter({ registry });

  const inputStream = new PassThrough();
  const outputStream = new PassThrough();

  const lines = [];
  outputStream.on('data', (chunk) => {
    lines.push(chunk.toString());
  });

  const stdio = adapter.createStdioHandler({
    auth: ownerAuth,
    inputStream,
    outputStream,
  });

  inputStream.write(JSON.stringify({ jsonrpc: '2.0', id: 'stdio-1', method: 'initialize' }) + '\n');
  inputStream.write(JSON.stringify({ jsonrpc: '2.0', id: 'stdio-2', method: 'tools/list' }) + '\n');

  await new Promise((resolve) => setTimeout(resolve, 50));
  stdio.close();

  const combinedOutput = lines.join('');
  assert.ok(combinedOutput.includes('stdio-1'));
  assert.ok(combinedOutput.includes('stdio-2'));
  assert.ok(combinedOutput.includes('2024-11-05'));
});

// =========================================================================
// Section 6: HTTP Integration & Route Mounting
// =========================================================================

test('MCP HTTP: mounts /api/ai/mcp routes and executes requests with auth guard', async () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers.length]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers.length]); },
  };
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ ok: true }));
  const adapter = createAiMcpAdapter({ registry });
  const audit = createMockAudit();

  mountAiRoutes(app, {
    registry,
    audit,
    mcpAdapter: adapter,
  });

  assert.ok(routes.some(([method, path]) => method === 'GET' && path === '/api/ai/mcp'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/mcp'));
});

test('MCP HTTP: standalone mountAiMcpRoutes helper mounts routes correctly', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers.length]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers.length]); },
  };
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });

  mountAiMcpRoutes(app, { registry });

  assert.deepEqual(routes, [
    ['GET', '/api/ai/mcp', 2],
    ['POST', '/api/ai/mcp', 2],
  ]);
});

// =========================================================================
// Section 7: Functional Completion Verification (Criterion 5)
// =========================================================================

test('MCP Completion: HTTP/UI presence alone is NOT completion without functional adapter & policy integration', async () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ status: 'operational' }));
  const adapter = createAiMcpAdapter({ registry });

  // 1. Adapter must be functional object with full protocol methods
  assert.equal(typeof adapter.initialize, 'function');
  assert.equal(typeof adapter.listTools, 'function');
  assert.equal(typeof adapter.callTool, 'function');
  assert.equal(typeof adapter.handleMessage, 'function');
  assert.equal(typeof adapter.createStdioHandler, 'function');

  // 2. Policy engine must be actively bound: unauthenticated calls fail-closed
  await assert.rejects(
    adapter.callTool({ name: 'server.health', auth: null }),
    (err) => err instanceof AiMcpError && err.status === 401,
  );

  // 3. Authenticated owner call must successfully execute tool and return MCP content
  const result = await adapter.callTool({ name: 'server.health', auth: ownerAuth });
  assert.equal(result.isError, false);
  assert.ok(result.content[0].text.includes('operational'));
});
