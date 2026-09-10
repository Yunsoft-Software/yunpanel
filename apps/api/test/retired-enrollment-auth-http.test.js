import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createAuthenticatedApi } from '../src/auth-http.js';

const origin = 'https://panel.example.test';

function fakeStore() {
  return {
    configured: () => true,
    mfa: { enabled: () => true },
    getSession: () => null,
  };
}

test('retired server enrollment cannot bypass the session boundary', async (t) => {
  let handlerCalls = 0;
  const listener = createAuthenticatedApi({
    store: fakeStore(),
    publicOrigin: origin,
    createHandler: () => (_request, response) => {
      handlerCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"unexpected":true}');
    },
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const url = `http://127.0.0.1:${server.address().port}/api/servers/enroll`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer obsolete-enrollment-or-agent-token',
      'content-type': 'application/json',
    },
    body: '{}',
  });

  assert.equal(response.status, 401);
  assert.equal(handlerCalls, 0);
  assert.equal((await response.json()).error.code, 'unauthorized');
});
