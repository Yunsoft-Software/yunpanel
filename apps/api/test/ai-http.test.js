import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { aiHttpInternals, mountAiRoutes } from '../src/ai-http.js';
import { createAiConversationService } from '../src/ai-conversation-service.js';
import { createAiToolRegistry } from '../src/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import { createAuthenticatedApi } from '../src/auth-http.js';

test('AI HTTP request parsers reject extra fields and non-string confirmation material', () => {
  assert.deepEqual(aiHttpInternals.previewBody({ input: { websiteId: 'site-1' } }), { input: { websiteId: 'site-1' } });
  assert.throws(() => aiHttpInternals.previewBody({ input: {}, overrides: {} }), (error) => error.code === 'invalid_ai_request');
  assert.throws(() => aiHttpInternals.executeBody({ input: {}, previewDigest: 123 }), (error) => error.code === 'invalid_ai_request');
});

test('AI HTTP mounts only tool list, preview and execution routes', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers.length]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers.length]); },
  };
  const registry = { list() { return []; }, get() {}, prepare() {}, execute() {} };
  const audit = { record() {} };
  mountAiRoutes(app, { registry, audit });
  assert.deepEqual(routes, [
    ['GET', '/api/ai/tools', 2],
    ['POST', '/api/ai/tools/:toolName/preview', 2],
    ['POST', '/api/ai/tools/:toolName/execute', 2],
  ]);
});

test('AI audit helper records metadata but never request input or model text', () => {
  const events = [];
  aiHttpInternals.auditEvent({ record(event) { events.push(event); return event; } }, {
    actorId: 'owner-1', toolName: 'website.inspect', outcome: 'succeeded',
  });
  assert.deepEqual(events, [{
    actorId: 'owner-1', action: 'ai.tool.website.inspect', resourceType: 'ai_tool', resourceId: 'website.inspect', outcome: 'succeeded', code: null,
  }]);
});

test('assertNoActorSpoofing helper verifies current session user id against candidate actor id', () => {
  const reqValid = { auth: { user: { id: 'user-1' } }, body: {}, query: {}, headers: {} };
  assert.doesNotThrow(() => aiHttpInternals.assertNoActorSpoofing(reqValid));

  const reqSame = { auth: { user: { id: 'user-1' } }, body: { actorId: 'user-1' }, query: {}, headers: {} };
  assert.doesNotThrow(() => aiHttpInternals.assertNoActorSpoofing(reqSame));

  for (const patch of [
    { body: { actorId: 'user-2' } },
    { body: { actor_id: 'user-2' } },
    { query: { actorId: 'user-2' } },
    { query: { actor_id: 'user-2' } },
    { headers: { 'x-actor-id': 'user-2' } },
    { headers: { 'x-yunpanel-actor-id': 'user-2' } },
    { headers: { 'x-actor': 'user-2' } },
  ]) {
    const spoofed = { auth: { user: { id: 'user-1' } }, body: {}, query: {}, headers: {}, ...patch };
    assert.throws(() => aiHttpInternals.assertNoActorSpoofing(spoofed), (err) => err.code === 'forbidden' && err.status === 403);
  }
});

const origin = 'https://panel.example.test';
const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';

function setupMultiUserFixture(tempDir, { onInvoke, onToolExecute, user1Role = 'site_manager' } = {}) {
  const filePath = path.join(tempDir, 'conversations.json');
  let user1Websites = [siteA];
  let user1Active = true;
  let user2Websites = [siteB];
  let user2Active = true;
  const sessions = new Map();

  const user1 = {
    id: user1Role === 'owner' ? 'owner-user-1' : 'site-user-1',
    username: 'user1',
    role: user1Role,
    get websiteIds() { return user1Websites; },
    get active() { return user1Active; },
  };
  const session1 = {
    id: '11111111-aaaa-4111-8111-111111111111',
    user: user1,
    csrfToken: 'csrf-site-1',
  };
  sessions.set('session-token-1', session1);

  const user2 = {
    id: 'site-user-2',
    username: 'user2',
    role: 'site_manager',
    get websiteIds() { return user2Websites; },
    get active() { return user2Active; },
  };
  const session2 = {
    id: '22222222-bbbb-4222-8222-222222222222',
    user: user2,
    csrfToken: 'csrf-site-2',
  };
  sessions.set('session-token-2', session2);

  const store = {
    sessions,
    revokeSession: (token) => { sessions.delete(token); },
    revokeUser1Grant: () => { user1Websites = []; },
    revokeUser2Grant: () => { user2Websites = []; },
    deactivateUser1: () => { user1Active = false; },
    configured: () => true,
    mfa: { enabled: () => true },
    getSession: (token) => sessions.get(token) || null,
    audit: { record() {}, list() { return { events: [], total: 0, offset: 0, limit: 50 }; } },
  };

  const toolRegistry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  toolRegistry.bind('website.inspect', async ({ input, context, tool }) => {
    if (onToolExecute) return onToolExecute(input, context);
    return { websiteId: input.websiteId, inspected: true, status: 'running' };
  });

  const mockAdapter = {
    id: 'test-adapter',
    defaultModel: 'test-model',
    complete: async (params) => {
      if (onInvoke) {
        const custom = await onInvoke(params);
        if (custom) return custom;
      }
      const last = params.messages[params.messages.length - 1];
      return {
        type: 'message',
        text: `Echo: ${last.text}`,
      };
    },
  };

  const websiteRegistry = {
    getWebsite: async (id) => {
      if (id === siteA) return { id: siteA, domain: 'site-a.example' };
      if (id === siteB) return { id: siteB, domain: 'site-b.example' };
      return null;
    },
  };

  const conversationService = createAiConversationService({
    filePath,
    websiteRegistry,
    providerAdapter: mockAdapter,
    toolRegistry,
    authorizeActor: async ({ sessionId }) => {
      for (const [, s] of sessions.entries()) {
        if (s.id === sessionId) {
          return {
            active: s.user.active !== false,
            websiteIds: s.user.websiteIds,
          };
        }
      }
      return null;
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  mountAiRoutes(app, {
    registry: toolRegistry,
    audit: store.audit,
    conversationService,
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
      ? error.status
      : (error.statusCode || 500);
    return response.status(status).json({
      error: {
        code: error.code || 'internal_error',
        message: error.message,
      },
    });
  });

  const listener = createAuthenticatedApi({
    store,
    publicOrigin: origin,
    createHandler: () => app,
  });

  const server = http.createServer(listener);

  return { store, conversationService, server, sessions };
}

function createClient(server, { token, csrfToken } = {}) {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return async (path, { method = 'GET', headers = {}, body } = {}) => {
    const reqHeaders = {
      origin,
      ...(token ? { cookie: `__Host-yunpanel_session=${token}` } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    };
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
  };
}

test('two users and two Websites: real HTTP, auth cookies, CSRF, and tenant isolation', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-http-multi-user-'));
  const { store, server } = setupMultiUserFixture(tempDir);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  const user1 = createClient(server, { token: 'session-token-1', csrfToken: 'csrf-site-1' });
  const user2 = createClient(server, { token: 'session-token-2', csrfToken: 'csrf-site-2' });

  // 1. User 1 creates conversation for Site A
  const createRes1 = await user1('/api/ai/conversations', {
    method: 'POST',
    body: { title: 'Site 1 Chat', websiteId: siteA },
  });
  assert.equal(createRes1.status, 201);
  const { data: conv1 } = await createRes1.json();
  assert.equal(conv1.websiteId, siteA);

  // 2. User 2 creates conversation for Site B
  const createRes2 = await user2('/api/ai/conversations', {
    method: 'POST',
    body: { title: 'Site 2 Chat', websiteId: siteB },
  });
  assert.equal(createRes2.status, 201);
  const { data: conv2 } = await createRes2.json();
  assert.equal(conv2.websiteId, siteB);

  // 3. User 1 cannot create conversation for Site B (unauthorized website)
  const failCreate = await user1('/api/ai/conversations', {
    method: 'POST',
    body: { title: 'Unauthorized Site', websiteId: siteB },
  });
  assert.equal(failCreate.status, 404);

  // 4. Conversation listing is isolated
  const listRes1 = await user1('/api/ai/conversations');
  assert.equal(listRes1.status, 200);
  const list1 = await listRes1.json();
  assert.equal(list1.data.length, 1);
  assert.equal(list1.data[0].id, conv1.id);

  const listRes2 = await user2('/api/ai/conversations');
  assert.equal(listRes2.status, 200);
  const list2 = await listRes2.json();
  assert.equal(list2.data.length, 1);
  assert.equal(list2.data[0].id, conv2.id);

  // 5. User 2 fails closed (404) when accessing User 1's conversation across all operations
  const getOther = await user2(`/api/ai/conversations/${conv1.id}`);
  assert.equal(getOther.status, 404);
  assert.equal((await getOther.json()).error.code, 'conversation_not_found');

  const delOther = await user2(`/api/ai/conversations/${conv1.id}`, { method: 'DELETE' });
  assert.equal(delOther.status, 404);
  assert.equal((await delOther.json()).error.code, 'conversation_not_found');

  const msgOther = await user2(`/api/ai/conversations/${conv1.id}/messages`, {
    method: 'POST',
    body: { text: 'Unauthorized message' },
  });
  assert.equal(msgOther.status, 404);
  assert.equal((await msgOther.json()).error.code, 'conversation_not_found');

  const streamOther = await user2(`/api/ai/conversations/${conv1.id}/messages/stream`, {
    method: 'POST',
    body: { text: 'Unauthorized stream' },
  });
  assert.equal(streamOther.status, 404);
  assert.equal(streamOther.headers.get('content-type')?.includes('application/json'), true);
  assert.equal((await streamOther.json()).error.code, 'conversation_not_found');

  // 6. Client actorId impersonation fails closed (403) across all endpoints and vectors
  // Query parameter spoofing
  const spoofListQ = await user1('/api/ai/conversations?actorId=site-user-2');
  assert.equal(spoofListQ.status, 403);
  assert.equal((await spoofListQ.json()).error.code, 'forbidden');

  const spoofGetQ = await user1(`/api/ai/conversations/${conv1.id}?actorId=site-user-2`);
  assert.equal(spoofGetQ.status, 403);

  const spoofDelQ = await user1(`/api/ai/conversations/${conv1.id}?actorId=site-user-2`, { method: 'DELETE' });
  assert.equal(spoofDelQ.status, 403);

  // Body parameter spoofing
  const spoofMsgBody = await user1(`/api/ai/conversations/${conv1.id}/messages`, {
    method: 'POST',
    body: { text: 'hello', actorId: 'site-user-2' },
  });
  assert.equal(spoofMsgBody.status, 403);

  const spoofStreamBody = await user1(`/api/ai/conversations/${conv1.id}/messages/stream`, {
    method: 'POST',
    body: { text: 'hello', actorId: 'site-user-2' },
  });
  assert.equal(spoofStreamBody.status, 403);
  assert.equal((await spoofStreamBody.json()).error.code, 'forbidden');

  // Header spoofing
  const spoofHeader = await user1('/api/ai/conversations', {
    headers: { 'x-actor-id': 'site-user-2' },
  });
  assert.equal(spoofHeader.status, 403);

  const spoofStreamHeader = await user1(`/api/ai/conversations/${conv1.id}/messages/stream`, {
    method: 'POST',
    headers: { 'x-yunpanel-actor-id': 'site-user-2' },
    body: { text: 'hello' },
  });
  assert.equal(spoofStreamHeader.status, 403);

  // 7. CSRF validation on mutating operations
  const csrfCreate = await user1('/api/ai/conversations', {
    method: 'POST',
    headers: { 'x-csrf-token': 'invalid-token' },
    body: { title: 'Bad CSRF', websiteId: siteA },
  });
  assert.equal(csrfCreate.status, 403);
  assert.equal((await csrfCreate.json()).error.code, 'csrf_invalid');

  const csrfDel = await user1(`/api/ai/conversations/${conv1.id}`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': '' },
  });
  assert.equal(csrfDel.status, 403);

  const csrfMsg = await user1(`/api/ai/conversations/${conv1.id}/messages`, {
    method: 'POST',
    headers: { 'x-csrf-token': 'wrong' },
    body: { text: 'hi' },
  });
  assert.equal(csrfMsg.status, 403);

  const csrfStream = await user1(`/api/ai/conversations/${conv1.id}/messages/stream`, {
    method: 'POST',
    headers: { 'x-csrf-token': '' },
    body: { text: 'hi' },
  });
  assert.equal(csrfStream.status, 403);

  // 8. Legitimate messaging and streaming work for authorized User 1
  const msgRes = await user1(`/api/ai/conversations/${conv1.id}/messages`, {
    method: 'POST',
    body: { text: 'How do I inspect my site?' },
  });
  assert.equal(msgRes.status, 200);
  const msgData = await msgRes.json();
  assert.equal(msgData.data.text, 'Echo: How do I inspect my site?');

  // Legitimate streaming response
  const streamRes = await user1(`/api/ai/conversations/${conv1.id}/messages/stream`, {
    method: 'POST',
    body: { text: 'Stream this message' },
  });
  assert.equal(streamRes.status, 200);
  assert.equal(streamRes.headers.get('content-type')?.includes('text/event-stream'), true);
  const streamText = await streamRes.text();
  assert.ok(streamText.includes('event: thinking'));
  assert.ok(streamText.includes('event: text'));
  assert.ok(streamText.includes('event: done'));

  // 9. Website grant revocation immediately fails closed
  store.revokeUser1Grant();

  const listRevoked = await user1('/api/ai/conversations');
  assert.equal(listRevoked.status, 200);
  assert.deepEqual((await listRevoked.json()).data, []);

  const getRevoked = await user1(`/api/ai/conversations/${conv1.id}`);
  assert.equal(getRevoked.status, 404);

  const delRevoked = await user1(`/api/ai/conversations/${conv1.id}`, { method: 'DELETE' });
  assert.equal(delRevoked.status, 404);

  const postRevoked = await user1(`/api/ai/conversations/${conv1.id}/messages`, {
    method: 'POST',
    body: { text: 'Hello again' },
  });
  assert.equal(postRevoked.status, 404);

  const streamRevoked = await user1(`/api/ai/conversations/${conv1.id}/messages/stream`, {
    method: 'POST',
    body: { text: 'Stream after grant revoked' },
  });
  assert.equal(streamRevoked.status, 404);
  assert.equal(streamRevoked.headers.get('content-type')?.includes('application/json'), true);
  assert.equal((await streamRevoked.json()).error.code, 'conversation_not_found');

  // 10. Session revocation / logout returns 401
  store.revokeSession('session-token-2');
  const loggedOutRes = await user2('/api/ai/conversations');
  assert.equal(loggedOutRes.status, 401);
  assert.equal((await loggedOutRes.json()).error.code, 'unauthorized');
});

test('mid-flight live authorization revocation during long-running provider call fails closed without saving messages', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-http-midflight-provider-'));
  let invokeStartedResolve;
  const invokeStarted = new Promise((resolve) => { invokeStartedResolve = resolve; });

  const { store, server } = setupMultiUserFixture(tempDir, {
    onInvoke: async ({ signal }) => {
      invokeStartedResolve();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return { type: 'message', text: 'Never reached' };
    },
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  const user1 = createClient(server, { token: 'session-token-1', csrfToken: 'csrf-site-1' });

  const createRes = await user1('/api/ai/conversations', {
    method: 'POST',
    body: { title: 'Mid-flight Test', websiteId: siteA },
  });
  assert.equal(createRes.status, 201);
  const { data: conv } = await createRes.json();

  // Start stream request
  const streamPromise = user1(`/api/ai/conversations/${conv.id}/messages/stream`, {
    method: 'POST',
    body: { text: 'Long running query' },
  });

  // Wait for provider invoke to start
  await invokeStarted;

  // Revoke session while provider is running
  store.revokeSession('session-token-1');

  const streamRes = await streamPromise;
  assert.equal(streamRes.status, 200); // SSE headers had been flushed on thinking
  const bodyText = await streamRes.text();
  assert.ok(bodyText.includes('event: error'));
  assert.ok(bodyText.includes('"code":"forbidden"'));

  // Verify conversation in store contains NO saved user or assistant messages
  const rawData = await user1(`/api/ai/conversations/${conv.id}`);
  assert.equal(rawData.status, 401); // session was revoked

  // Restore session to inspect conversation detail
  store.sessions.set('session-token-1', {
    id: '11111111-aaaa-4111-8111-111111111111',
    user: { id: 'site-user-1', username: 'user1', role: 'site_manager', websiteIds: [siteA] },
    csrfToken: 'csrf-site-1',
  });

  const detailRes = await user1(`/api/ai/conversations/${conv.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.data.messages.length, 0); // No leaked or saved messages!
});

test('mid-flight live authorization revocation during long-running tool execution fails closed without saving tool results', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-http-midflight-tool-'));
  let toolStartedResolve;
  const toolStarted = new Promise((resolve) => { toolStartedResolve = resolve; });

  const { store, server } = setupMultiUserFixture(tempDir, {
    user1Role: 'owner',
    onInvoke: async ({ messages }) => {
      // First turn: propose autoExecutable tool
      if (messages.filter((m) => m.role === 'tool').length === 0) {
        return {
          type: 'tool_calls',
          calls: [{
            id: 'call-1',
            name: 'website.inspect',
            input: { websiteId: siteA },
          }],
        };
      }
      return { type: 'message', text: 'Inspection complete' };
    },
    onToolExecute: async (input, context) => {
      toolStartedResolve();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 800);
        context?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(context.signal.reason);
        }, { once: true });
      });
      return { websiteId: input.websiteId, status: 'ok' };
    },
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  const user1 = createClient(server, { token: 'session-token-1', csrfToken: 'csrf-site-1' });

  const createRes = await user1('/api/ai/conversations', {
    method: 'POST',
    body: { title: 'Tool Mid-flight Test', websiteId: siteA },
  });
  assert.equal(createRes.status, 201);
  const { data: conv } = await createRes.json();

  const streamPromise = user1(`/api/ai/conversations/${conv.id}/messages/stream`, {
    method: 'POST',
    body: { text: 'Inspect my site' },
  });

  // Wait for tool execution to begin
  await toolStarted;

  // Revoke session while tool is executing
  store.revokeSession('session-token-1');

  const streamRes = await streamPromise;
  assert.equal(streamRes.status, 200);
  const bodyText = await streamRes.text();
  assert.ok(bodyText.includes('event: error'));
  assert.ok(bodyText.includes('"code":"forbidden"'));
  assert.ok(!bodyText.includes('event: tool_result')); // tool_result is NOT emitted!
});
