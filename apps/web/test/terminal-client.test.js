import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerminalWebSocket,
  normalizeTerminalCapability,
  parseTerminalMessage,
  terminalWebSocketUrl,
} from '../src/workspace/terminal-client.js';

const capability = Object.freeze({
  capability: 'a'.repeat(43),
  expiresAt: Date.now() + 30_000,
  protocol: 'yunpanel-terminal-v1',
  target: { scope: 'server', serverId: 'local', user: 'root', cwd: '/root' },
});

test('terminal socket keeps capability out of URL and uses exact subprotocols', () => {
  const calls = [];
  class FakeWebSocket {
    constructor(url, protocols) { calls.push({ url, protocols }); }
  }
  createTerminalWebSocket(capability, {
    WebSocketClass: FakeWebSocket,
    locationLike: { href: 'https://panel.example.test/websites/site/terminal?old=value' },
  });
  assert.deepEqual(calls, [{
    url: 'wss://panel.example.test/api/terminal',
    protocols: ['yunpanel-terminal-v1', `yunpanel-terminal-capability.${'a'.repeat(43)}`],
  }]);
  assert.equal(calls[0].url.includes(capability.capability), false);
  assert.equal(terminalWebSocketUrl({ href: 'http://127.0.0.1:5173/' }), 'ws://127.0.0.1:5173/api/terminal');
});

test('capability and server messages fail closed on target or shape drift', () => {
  assert.deepEqual(normalizeTerminalCapability(capability).target, capability.target);
  assert.throws(() => normalizeTerminalCapability({ ...capability, command: 'id' }));
  assert.throws(() => normalizeTerminalCapability({ ...capability, expiresAt: Date.now() - 1 }));
  assert.deepEqual(parseTerminalMessage(JSON.stringify({ type: 'output', data: '\u001b[31mçalıştı\u001b[0m' })), {
    type: 'output', data: '\u001b[31mçalıştı\u001b[0m',
  });
  assert.throws(() => parseTerminalMessage(JSON.stringify({ type: 'output', data: 'ok', html: '<img>' })));
  assert.throws(() => parseTerminalMessage(JSON.stringify({ type: 'ready', sessionId: 'bad', target: capability.target })));
});
