import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createLiveConnectionAuthenticator } from '../src/auth-http.js';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import { createTerminalCapabilityRegistry } from '../src/terminal-capability-registry.js';
import { createTerminalWebSocketServer } from '../src/terminal-websocket.js';

const origin = 'https://panel.example.test';
const rawToken = 's'.repeat(43);
const sessionId = '12345678-1234-4234-9234-123456789012';
const userId = 'owner-1';
const target = Object.freeze({ scope: 'server', serverId: 'local', user: 'root', cwd: '/root' });

function nextMessage(websocket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString('utf8'));
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = (code, reason) => { cleanup(); reject(new Error(`closed ${code} ${reason}`)); };
    const cleanup = () => { websocket.off('message', onMessage); websocket.off('close', onClose); };
    websocket.on('message', onMessage);
    websocket.on('close', onClose);
  });
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (predicate()) { resolve(); return; }
      attempts += 1;
      if (attempts > 100) { reject(new Error('condition not reached')); return; }
      setTimeout(check, 5);
    };
    check();
  });
}

async function fixture(t, overrides = {}) {
  const state = { active: true, role: 'owner', mfa: true, touches: 0 };
  const store = {
    mfa: { enabled: () => state.mfa },
    getSession(token, { touch = false } = {}) {
      if (token !== rawToken || !state.active) return null;
      if (touch) state.touches += 1;
      return {
        id: sessionId,
        user: { id: userId, username: 'owner', role: state.role },
        expiresAt: Date.now() + 60_000,
        idleExpiresAt: Date.now() + 60_000,
        csrfToken: 'c'.repeat(43),
      };
    },
  };
  const liveSessions = createLiveSessionRegistry();
  const capabilities = createTerminalCapabilityRegistry({ liveSessions });
  const process = { writes: [], resizes: [], closes: 0, callbacks: null };
  const terminalProcessManager = {
    async open(options) {
      process.callbacks = options;
      return {
        write: (data) => process.writes.push(data),
        resize: (cols, rows) => process.resizes.push([cols, rows]),
        close: () => { process.closes += 1; },
      };
    },
  };
  const events = [];
  const auth = createLiveConnectionAuthenticator({ store, publicOrigin: origin });
  const transport = createTerminalWebSocketServer({
    ...auth,
    terminalCapabilityRegistry: capabilities,
    terminalProcessManager,
    liveSessions,
    audit: { record: (event) => { events.push(event); return event; } },
    ...overrides,
  });
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on('upgrade', transport.handleUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    transport.closeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/api/terminal`;
  function issue() {
    return capabilities.issue({ sessionId, userId, target });
  }
  function connect(issued = issue(), headers = {}) {
    return new WebSocket(url, ['yunpanel-terminal-v1', `yunpanel-terminal-capability.${issued.capability}`], {
      headers: { origin, cookie: `__Host-yunpanel_session=${rawToken}`, ...headers },
    });
  }
  return { state, liveSessions, capabilities, process, events, transport, issue, connect };
}

test('same-origin Owner opens one PTY and exchanges Unicode, controls and resize messages', async (t) => {
  const fx = await fixture(t);
  const websocket = fx.connect();
  const readyPromise = nextMessage(websocket, (message) => message.type === 'ready');
  await once(websocket, 'open');
  const ready = await readyPromise;
  assert.equal(websocket.protocol, 'yunpanel-terminal-v1');
  assert.deepEqual(ready.target, target);
  assert.match(ready.sessionId, /^[0-9a-f-]{36}$/);

  const outputPromise = nextMessage(websocket, (message) => message.type === 'output');
  fx.process.callbacks.onData('\u001b[32mçalıştı 世界\u001b[0m');
  assert.deepEqual(await outputPromise, { type: 'output', data: '\u001b[32mçalıştı 世界\u001b[0m' });
  websocket.send(JSON.stringify({ type: 'input', data: 'printf "çalıştı\\n"\r' }));
  websocket.send(JSON.stringify({ type: 'input', data: '\u0003' }));
  websocket.send(JSON.stringify({ type: 'resize', cols: 132, rows: 44 }));
  const pongPromise = nextMessage(websocket, (message) => message.type === 'pong');
  websocket.send(JSON.stringify({ type: 'ping' }));
  await pongPromise;
  await waitFor(() => fx.process.writes.length === 2 && fx.process.resizes.length === 1);
  assert.deepEqual(fx.process.writes, ['printf "çalıştı\\n"\r', '\u0003']);
  assert.deepEqual(fx.process.resizes, [[132, 44]]);

  websocket.close();
  await once(websocket, 'close');
  await waitFor(() => fx.process.closes === 1 && fx.events.length === 3);
  assert.equal(fx.process.closes, 1);
  assert.deepEqual(fx.events.map((event) => [event.action, event.outcome, event.code]), [
    ['terminal.server.opened', 'accepted', null],
    ['terminal.server.opened', 'succeeded', null],
    ['terminal.server.closed', 'succeeded', 'client_closed'],
  ]);
  assert.doesNotMatch(JSON.stringify(fx.events), /çalıştı|printf/);
});

test('origin, Owner role, exact protocol and single-use capability all fail closed', async (t) => {
  const fx = await fixture(t);
  const issued = fx.issue();
  const wrongOrigin = fx.connect(issued, { origin: 'https://attacker.example' });
  wrongOrigin.on('error', () => {});
  const [, wrongOriginResponse] = await once(wrongOrigin, 'unexpected-response');
  assert.equal(wrongOriginResponse.statusCode, 403);

  const valid = fx.connect(issued);
  const readyPromise = nextMessage(valid, (message) => message.type === 'ready');
  await once(valid, 'open');
  await readyPromise;
  valid.close();
  await once(valid, 'close');

  const replay = fx.connect(issued);
  replay.on('error', () => {});
  const [, replayResponse] = await once(replay, 'unexpected-response');
  assert.equal(replayResponse.statusCode, 401);

  fx.state.role = 'read_only';
  const denied = fx.connect();
  denied.on('error', () => {});
  const [, deniedResponse] = await once(denied, 'unexpected-response');
  assert.equal(deniedResponse.statusCode, 403);
});

test('logout-style live revocation closes the socket and its PTY immediately', async (t) => {
  const fx = await fixture(t);
  const websocket = fx.connect();
  const readyPromise = nextMessage(websocket, (message) => message.type === 'ready');
  await once(websocket, 'open');
  await readyPromise;
  const closed = once(websocket, 'close');
  assert.equal(fx.liveSessions.revokeSession(sessionId), 1);
  const [code, reason] = await closed;
  assert.equal(code, 4001);
  assert.equal(reason.toString(), 'session_revoked');
  assert.equal(fx.process.closes, 1);
  assert.equal(fx.transport.size(), 0);
});

test('invalid messages and bounded output terminate the process without auditing content', async (t) => {
  const fx = await fixture(t, { maxOutputBytes: 1024 });
  const websocket = fx.connect();
  const readyPromise = nextMessage(websocket, (message) => message.type === 'ready');
  await once(websocket, 'open');
  await readyPromise;
  const closed = once(websocket, 'close');
  fx.process.callbacks.onData('secret-output'.padEnd(1025, 'x'));
  const [code, reason] = await closed;
  assert.equal(code, 4009);
  assert.equal(reason.toString(), 'output_limit');
  assert.doesNotMatch(JSON.stringify(fx.events), /secret-output/);

  const next = fx.connect();
  const nextReady = nextMessage(next, (message) => message.type === 'ready');
  await once(next, 'open');
  await nextReady;
  const invalidClosed = once(next, 'close');
  next.send(JSON.stringify({ type: 'input', data: 'id', command: 'forbidden' }));
  assert.equal((await invalidClosed)[0], 1008);
});

test('concurrent session limit leaves the unused capability available for a later reconnect', async (t) => {
  const fx = await fixture(t, { maxSessions: 1, maxUserSessions: 1 });
  const first = fx.connect();
  const firstReady = nextMessage(first, (message) => message.type === 'ready');
  await once(first, 'open');
  await firstReady;

  const waitingCapability = fx.issue();
  const limited = fx.connect(waitingCapability);
  limited.on('error', () => {});
  const [, limitedResponse] = await once(limited, 'unexpected-response');
  assert.equal(limitedResponse.statusCode, 429);
  limitedResponse.resume();

  first.close();
  await once(first, 'close');
  await waitFor(() => fx.transport.size() === 0);
  const reconnected = fx.connect(waitingCapability);
  const reconnectReady = nextMessage(reconnected, (message) => message.type === 'ready');
  await once(reconnected, 'open');
  await reconnectReady;
  reconnected.close();
  await once(reconnected, 'close');
});

test('periodic authorization and idle deadlines terminate sessions whose authority has changed', async (t) => {
  let timestamp = 1_000;
  let tick;
  const fx = await fixture(t, {
    now: () => timestamp,
    idleMs: 1_000,
    lifetimeMs: 2_000,
    authCheckMs: 250,
    setIntervalFn: (callback) => { tick = callback; return { unref() {} }; },
    clearIntervalFn() {},
  });
  const websocket = fx.connect();
  const readyPromise = nextMessage(websocket, (message) => message.type === 'ready');
  await once(websocket, 'open');
  await readyPromise;
  const idleClosed = once(websocket, 'close');
  timestamp = 2_000;
  tick();
  assert.equal((await idleClosed)[1].toString(), 'idle_timeout');

  timestamp = 3_000;
  const changed = fx.connect();
  const changedReady = nextMessage(changed, (message) => message.type === 'ready');
  await once(changed, 'open');
  await changedReady;
  const authorityClosed = once(changed, 'close');
  fx.state.role = 'read_only';
  tick();
  const [code, reason] = await authorityClosed;
  assert.equal(code, 4001);
  assert.equal(reason.toString(), 'session_revoked');
});
