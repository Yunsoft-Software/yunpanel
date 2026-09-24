import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

// The real conversation service and real temporary filesystem run in the child.
// Only provider/orchestrator imports are replaced; no external model is called.
test('conversation ownership, legacy preservation, paging and storage failures through the real service', () => {
  const moduleUrl = new URL('../src/ai-conversation-service.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdtemp, readFile, writeFile, stat, rm, mkdir } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    const moduleUrl = ${JSON.stringify(moduleUrl)};
    let providerCalls = 0;
    mock.module(new URL('./ai-orchestrator.js', moduleUrl).href, { namedExports: { createAiOrchestrator: () => ({ proposeTurn: async () => { providerCalls++; return { type: 'message', message: { text: 'fixture reply' } }; } }) } });
    mock.module(new URL('./ai-provider-adapters.js', moduleUrl).href, { namedExports: { createProviderFromConfig: () => { throw new Error('unexpected provider'); } } });
    const { createAiConversationService } = await import(moduleUrl);
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-history-'));
    const filePath = path.join(dir, 'history.json');
    const siteA = '11111111-1111-4111-8111-111111111111';
    const siteB = '22222222-2222-4222-8222-222222222222';
    const auth = (id) => ({ user: { id, role: 'owner' }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } });
    const owner = auth('owner-a'), other = auth('owner-b');
    const make = () => createAiConversationService({ filePath, providerAdapter: { defaultModel: 'fixture' }, toolRegistry: {}, websiteRegistry: { getWebsite: async (id) => id === siteA || id === siteB ? { id } : null } });
    try {
      const legacy = { id: '33333333-3333-4333-8333-333333333333', title: 'legacy', websiteId: siteA, messages: [{ text: 'keep this' }], createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' };
      const original = JSON.stringify({ version: 1, conversations: [legacy] });
      await writeFile(filePath, original);
      const service = make();
      assert.equal((await service.listConversationPage({ auth: owner })).legacyUnassigned, true);
      assert.equal(await service.getConversation(legacy.id, { auth: owner }), null);
      assert.equal(await service.deleteConversation(legacy.id, { auth: owner }), false);
      const created = await service.createConversation({ title: 'A', websiteId: siteA, auth: owner });
      assert.equal(await readFile(filePath + '.v1-backup', 'utf8'), original);
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      assert.equal((await stat(filePath + '.v1-backup')).mode & 0o777, 0o600);
      const stored = JSON.parse(await readFile(filePath, 'utf8'));
      assert.equal(stored.version, 2); assert.equal(stored.conversations[0].messages[0].text, 'keep this');
      assert.equal(stored.conversations[1].actorId, owner.user.id); assert.equal(created.actorId, undefined);
      assert.equal(await service.getConversation(created.id, { auth: other }), null);
      assert.equal(await service.deleteConversation(created.id, { auth: other }), false);
      await assert.rejects(service.sendMessage({ conversationId: created.id, text: 'steal', auth: other }), { status: 404 });
      assert.equal(providerCalls, 0);
      await service.sendMessage({ conversationId: created.id, text: 'hello', auth: owner });
      assert.equal(providerCalls, 1); assert.equal((await service.getConversation(created.id, { auth: owner })).messages.length, 2);
      const fresh = make(); assert.equal((await fresh.getConversation(created.id, { auth: owner })).messages.length, 2);
      assert.equal((await fresh.listConversations({ auth: other })).length, 0);
      await assert.rejects(fresh.listConversations(), { status: 401 });
      await assert.rejects(fresh.createConversation({ title: 'wrong-site', websiteId: '44444444-4444-4444-8444-444444444444', auth: owner }), { status: 404 });
      const manager = { user: { id: 'manager-a', role: 'site_manager', websiteIds: [siteA] }, access: { mode: 'site_management' }, security: { managementAllowed: true } };
      const own = await fresh.createConversation({ title: 'my site', websiteId: siteA, auth: manager });
      await assert.rejects(fresh.createConversation({ websiteId: siteB, auth: manager }), { status: 404 });
      await assert.rejects(fresh.createConversation({ auth: manager }), { status: 403 });
      manager.user.websiteIds = [];
      assert.equal(await fresh.getConversation(own.id, { auth: manager }), null);
      await assert.rejects(fresh.sendMessage({ conversationId: own.id, text: 'blocked', auth: manager }), { status: 404 });
      assert.equal(await fresh.deleteConversation(own.id, { auth: manager }), false);
      await Promise.all(Array.from({ length: 24 }, (_, i) => fresh.createConversation({ title: 'C' + i, auth: owner })));
      const restarted = make();
      let page = await restarted.listConversationPage({ auth: owner, limit: 10 }); const ids = page.items.map((r) => r.id);
      while (page.nextCursor) { page = await restarted.listConversationPage({ auth: owner, cursor: page.nextCursor, limit: 10 }); ids.push(...page.items.map((r) => r.id)); }
      assert.equal(ids.length, 25); assert.equal(new Set(ids).size, 25);
      assert.equal(await restarted.deleteConversation(created.id, { auth: owner }), true);
      assert.equal(await make().getConversation(created.id, { auth: owner }), null);
      // Reaching the existing 100-conversation ceiling never silently evicts history.
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      const seed = raw.conversations.find((r) => r.actorId === owner.user.id);
      raw.conversations = [legacy, ...Array.from({ length: 100 }, (_, i) => ({ ...seed, id: '55555555-5555-4555-8555-' + String(i).padStart(12, '0') }))];
      await writeFile(filePath, JSON.stringify(raw)); const full = make();
      await assert.rejects(full.createConversation({ auth: owner }), { code: 'ai_conversation_limit' });
      assert.equal(JSON.parse(await readFile(filePath, 'utf8')).conversations.length, 101);
      await writeFile(filePath, '{broken'); const corrupt = make();
      await assert.rejects(corrupt.createConversation({ auth: owner }), { code: 'ai_history_store_unavailable' });
      assert.equal(await readFile(filePath, 'utf8'), '{broken');
      // A conflicting migration backup must not be overwritten.
      await writeFile(filePath, original + ' '); const conflict = make();
      await assert.rejects(conflict.createConversation({ auth: owner }), { code: 'ai_history_store_unavailable' });
      assert.equal(await readFile(filePath + '.v1-backup', 'utf8'), original);
      await assert.rejects(conflict.listConversations({ auth: owner }), { code: 'ai_history_store_unavailable' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
});

test('real mounted conversation handlers preserve the auth boundary and reject actor/query spoofing', () => {
  const routeUrl = new URL('../src/ai-http.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    const route = ${JSON.stringify(routeUrl)};
    const guard = (_request, _response, next) => next();
    mock.module(new URL('./panel-http-guard.js', route).href, { namedExports: { requirePanelRouteAccess: guard } });
    mock.module(new URL('./ai-action-plan.js', route).href, { namedExports: { createAiActionPlan: () => {}, verifyAiActionExecution: () => {} } });
    mock.module(new URL('./ai-policy.js', route).href, { namedExports: { evaluateAiToolPolicy: () => {} } });
    mock.module(new URL('./ai-provider-adapters.js', route).href, { namedExports: { createProviderFromConfig: () => {} } });
    mock.module(new URL('./ai-orchestrator.js', route).href, { namedExports: { createAiOrchestrator: () => { throw new Error('provider must not run'); } } });
    const { mountAiRoutes } = await import(route);
    const { createAiConversationService } = await import(new URL('./ai-conversation-service.js', route).href);
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-http-history-'));
    try {
      const service = createAiConversationService({ filePath: path.join(directory, 'history.json') });
      const routes = new Map(), app = {};
      for (const method of ['get', 'post', 'delete']) app[method] = (path, ...handlers) => routes.set(method + ' ' + path, handlers);
      mountAiRoutes(app, { registry: { list() {}, get() {}, prepare() {}, execute() {} }, audit: { record() {} }, conversationService: service });
      const auth = (id) => ({ user: { id, role: 'owner' }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } });
      const owner = auth('owner-a');
      async function invoke(method, route, request = {}) {
        const handlers = routes.get(method + ' ' + route); assert.equal(handlers[0], guard);
        const response = { code: 200, output: '', status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; }, setHeader() {}, flushHeaders() {}, write(value) { this.output += value; }, end() {} };
        const req = { query: {}, params: {}, body: {}, auth: owner, ...request };
        try { await handlers[1](req, response, (error) => { throw error; }); } catch (error) { response.error = error; }
        return response;
      }
      const route = '/api/ai/conversations';
      const created = await invoke('post', route, { body: { title: 'owner-only' } });
      assert.equal(created.code, 201); const id = created.body.data.id;
      let result = await invoke('get', route); assert.ok(Array.isArray(result.body.data)); assert.equal(result.body.data.length, 1);
      result = await invoke('get', route, { query: { limit: '20' } });
      assert.equal(result.body.data.scope.actorId, owner.user.id); assert.equal(result.body.data.items.length, 1);
      result = await invoke('get', route, { auth: auth('owner-b'), query: { limit: '20' } }); assert.equal(result.body.data.items.length, 0);
      for (const query of [{ actorId: 'owner-a' }, { limit: ['20'] }, { limit: '51' }, { limit: '20oops' }, { websiteId: ['anything'] }, { cursor: {} }]) {
        const invalid = await invoke('get', route, { query }); assert.equal(invalid.error.status, 400);
      }
      result = await invoke('post', route, { body: { title: 'spoof', actorId: 'owner-a' }, auth: auth('owner-b') }); assert.equal(result.error.status, 400);
      for (const method of ['get', 'delete']) {
        result = await invoke(method, route + '/:conversationId', { params: { conversationId: id }, auth: auth('owner-b') });
        assert.equal(result.error.status, 404);
      }
      result = await invoke('post', route + '/:conversationId/messages', { params: { conversationId: id }, body: { text: 'steal' }, auth: auth('owner-b') }); assert.equal(result.error.status, 404);
      result = await invoke('post', route + '/:conversationId/messages/stream', { params: { conversationId: id }, body: { text: 'steal' }, auth: auth('owner-b') });
      assert.ok(result.output.includes('conversation_not_found')); assert.equal(result.output.includes('owner-only'), false);
      result = await invoke('get', route, { auth: null }); assert.equal(result.error.status, 401);
      result = await invoke('get', route + '/:conversationId', { params: { conversationId: id } }); assert.equal(result.body.data.title, 'owner-only');
      result = await invoke('delete', route + '/:conversationId', { params: { conversationId: id } }); assert.equal(result.body.data.success, true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
});
