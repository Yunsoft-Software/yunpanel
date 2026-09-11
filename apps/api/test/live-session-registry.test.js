import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';

test('live session registry closes only the revoked session and removes registrations once', () => {
  const registry = createLiveSessionRegistry();
  const closed = [];
  registry.register({ sessionId: 'session-1', userId: 'user-1', terminate: (reason) => closed.push(['one', reason]) });
  const second = registry.register({ sessionId: 'session-2', userId: 'user-1', terminate: (reason) => closed.push(['two', reason]) });
  registry.register({ sessionId: 'session-3', userId: 'user-2', terminate: (reason) => closed.push(['three', reason]) });

  assert.equal(registry.revokeSession('session-1'), 1);
  assert.deepEqual(closed, [['one', 'session_revoked']]);
  assert.equal(registry.revokeSession('session-1'), 0);
  assert.equal(second.unregister(), true);
  assert.equal(second.unregister(), false);
  assert.equal(registry.size(), 1);
});

test('user revocation and shutdown terminate every matching live connection without trusting callbacks', () => {
  const registry = createLiveSessionRegistry();
  const closed = [];
  registry.register({ sessionId: 'session-1', userId: 'user-1', terminate() { throw new Error('untrusted close'); } });
  registry.register({ sessionId: 'session-2', userId: 'user-1', terminate: (reason) => closed.push(reason) });
  registry.register({ sessionId: 'session-3', userId: 'user-2', terminate: (reason) => closed.push(reason) });

  assert.equal(registry.revokeUser('user-1', 'password_changed'), 2);
  assert.deepEqual(closed, ['password_changed']);
  assert.equal(registry.closeAll(), 1);
  assert.deepEqual(closed, ['password_changed', 'server_shutdown']);
  assert.equal(registry.size(), 0);
});

test('invalid identities and missing terminate callbacks cannot enter the live registry', () => {
  const registry = createLiveSessionRegistry();
  assert.throws(() => registry.register({ sessionId: '', userId: 'user', terminate() {} }), /sessionId/);
  assert.throws(() => registry.register({ sessionId: 'session', userId: 'bad\nuser', terminate() {} }), /userId/);
  assert.throws(() => registry.register({ sessionId: 'session', userId: 'user' }), /terminate/);
});
