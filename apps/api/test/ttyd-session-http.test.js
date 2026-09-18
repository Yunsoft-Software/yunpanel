import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mountTtydSessionRoutes,
} from '../src/ttyd-session-http.js';
import { TtydSessionError } from '../src/ttyd-session-manager.js';

const capability = 'T'.repeat(43);
const target = Object.freeze({
  scope: 'server',
  serverId: 'local',
  user: 'root',
  cwd: '/root',
});
const session = Object.freeze({
  version: 1,
  protocol: 'yunpanel-ttyd-v1',
  audience: 'terminal',
  sessionId: '12345678-1234-4234-8234-123456789012',
  target,
  basePath: '/tools/ttyd/12345678-1234-4234-8234-123456789012/',
  expiresAt: 99_999,
});

function fixture() {
  const routes = [];
  const calls = [];
  const app = {
    post(path, ...handlers) {
      routes.push({ method: 'POST', path, handler: handlers.at(-1) });
    },
    delete(path, ...handlers) {
      routes.push({ method: 'DELETE', path, handler: handlers.at(-1) });
    },
  };
  const terminalCapabilityRegistry = {
    consume(value, binding) {
      calls.push(['consume', value, binding]);
      if (binding.sessionId !== 'owner-session' || binding.userId !== 'owner-user') {
        throw Object.assign(new Error('wrong binding'), {
          code: 'terminal_capability_binding_invalid',
          status: 403,
        });
      }
      return { target, expiresAt: 60_000 };
    },
  };
  const ttydSessionManager = {
    async start(input) {
      calls.push(['start', input]);
      return session;
    },
    terminateOwned(id, binding) {
      calls.push(['terminate', id, binding]);
      return id === session.sessionId
        && binding.ownerSessionId === 'owner-session'
        && binding.userId === 'owner-user';
    },
  };
  mountTtydSessionRoutes(app, {
    terminalCapabilityRegistry,
    ttydSessionManager,
  });
  return {
    startRoute: routes.find((route) => route.method === 'POST'),
    closeRoute: routes.find((route) => route.method === 'DELETE'),
    calls,
  };
}

async function invoke(handler, { body, auth } = {}) {
  let status = 200;
  let payload = null;
  let error = null;
  const response = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  try {
    await handler({ body, auth }, response);
  } catch (failure) {
    error = failure;
  }
  return { status, payload, error };
}

test('ttyd session bridge consumes capability in the exact Owner session and returns only public session data', async () => {
  const fx = fixture();
  assert.equal(fx.startRoute.path, '/api/terminal/ttyd-sessions');

  const response = await invoke(fx.startRoute.handler, {
    body: { capability },
    auth: {
      id: 'owner-session',
      user: { id: 'owner-user', role: 'owner' },
    },
  });

  assert.equal(response.error, null);
  assert.equal(response.status, 201);
  assert.deepEqual(response.payload, { data: session });
  assert.deepEqual(fx.calls, [
    ['consume', capability, {
      sessionId: 'owner-session',
      userId: 'owner-user',
    }],
    ['start', {
      ownerSessionId: 'owner-session',
      userId: 'owner-user',
      target,
    }],
  ]);
  assert.doesNotMatch(JSON.stringify(response.payload), /\.sock|capability|X-YunPanel-TTYD-Auth/);
});

test('ttyd session bridge rejects expanded body or non-Owner auth before manager start', async () => {
  for (const request of [
    {
      body: { capability, command: 'id' },
      auth: { id: 'owner-session', user: { id: 'owner-user', role: 'owner' } },
      code: 'ttyd_session_request_invalid',
    },
    {
      body: { capability },
      auth: { id: 'owner-session', user: { id: 'owner-user', role: 'read_only' } },
      code: 'terminal_session_invalid',
    },
  ]) {
    const fx = fixture();
    const response = await invoke(fx.startRoute.handler, request);
    assert.ok(response.error);
    assert.equal(response.error.code, request.code);
    assert.equal(fx.calls.length, 0);
  }
});

test('ttyd session bridge rejects malformed capability shape', async () => {
  const fx = fixture();
  const response = await invoke(fx.startRoute.handler, {
    body: { capability: 'short' },
    auth: {
      id: 'owner-session',
      user: { id: 'owner-user', role: 'owner' },
    },
  });
  assert.ok(response.error instanceof TtydSessionError);
  assert.equal(response.error.code, 'ttyd_session_request_invalid');
  assert.equal(fx.calls.length, 0);
});


test('ttyd session close endpoint terminates only the exact Owner-bound session', async () => {
  const fx = fixture();
  assert.equal(
    fx.closeRoute.path,
    '/api/terminal/ttyd-sessions/:sessionId',
  );
  const response = await invoke(
    (request, result) => fx.closeRoute.handler(
      {
        ...request,
        params: { sessionId: session.sessionId },
      },
      {
        ...result,
        end() { return this; },
      },
    ),
    {
      body: {},
      auth: {
        id: 'owner-session',
        user: { id: 'owner-user', role: 'owner' },
      },
    },
  );

  assert.equal(response.error, null);
  assert.equal(response.status, 204);
  assert.deepEqual(fx.calls, [[
    'terminate',
    session.sessionId,
    { ownerSessionId: 'owner-session', userId: 'owner-user' },
  ]]);
});

test('ttyd session close endpoint rejects foreign or expanded close requests', async () => {
  {
    const fx = fixture();
    const response = await invoke(
      (request, result) => fx.closeRoute.handler(
        {
          ...request,
          params: { sessionId: '22345678-1234-4234-8234-123456789012' },
        },
        {
          ...result,
          end() { return this; },
        },
      ),
      {
        body: {},
        auth: {
          id: 'owner-session',
          user: { id: 'owner-user', role: 'owner' },
        },
      },
    );
    assert.equal(response.error?.code, 'ttyd_session_not_found');
  }

  {
    const fx = fixture();
    const response = await invoke(
      (request, result) => fx.closeRoute.handler(
        {
          ...request,
          params: { sessionId: session.sessionId },
        },
        {
          ...result,
          end() { return this; },
        },
      ),
      {
        body: { reason: 'kill-all' },
        auth: {
          id: 'owner-session',
          user: { id: 'owner-user', role: 'owner' },
        },
      },
    );
    assert.equal(response.error?.code, 'ttyd_session_close_request_invalid');
    assert.equal(fx.calls.length, 0);
  }
});
