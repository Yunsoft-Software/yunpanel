import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import {
  createTerminalCapabilityRegistry,
  TerminalCapabilityError,
} from '../src/terminal-capability-registry.js';

const serverTarget = {
  scope: 'server', serverId: 'server-1', user: 'root', cwd: '/root',
};

test('terminal capabilities are short-lived single-use values bound to one session and user', () => {
  let now = 1_000;
  const registry = createTerminalCapabilityRegistry({ now: () => now, ttlMs: 5_000 });
  const issued = registry.issue({ sessionId: 'session-1', userId: 'user-1', target: serverTarget });
  assert.match(issued.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, 6_000);
  assert.equal(issued.protocol, 'yunpanel-terminal-v1');
  const consumed = registry.consume(issued.capability, { sessionId: 'session-1', userId: 'user-1' });
  assert.deepEqual(consumed.target, serverTarget);
  assert.throws(
    () => registry.consume(issued.capability, { sessionId: 'session-1', userId: 'user-1' }),
    (error) => error instanceof TerminalCapabilityError && error.code === 'terminal_capability_invalid',
  );

  const expired = registry.issue({ sessionId: 'session-1', userId: 'user-1', target: serverTarget });
  now = expired.expiresAt;
  assert.throws(
    () => registry.consume(expired.capability, { sessionId: 'session-1', userId: 'user-1' }),
    (error) => error instanceof TerminalCapabilityError && error.code === 'terminal_capability_expired',
  );
});

test('binding mismatch consumes the capability and live session revocation removes unused values', () => {
  const liveSessions = createLiveSessionRegistry();
  const registry = createTerminalCapabilityRegistry({ liveSessions });
  const mismatched = registry.issue({ sessionId: 'session-1', userId: 'user-1', target: serverTarget });
  assert.throws(
    () => registry.consume(mismatched.capability, { sessionId: 'session-2', userId: 'user-1' }),
    (error) => error instanceof TerminalCapabilityError && error.code === 'terminal_capability_binding_invalid',
  );
  assert.equal(registry.size(), 0);

  const revoked = registry.issue({ sessionId: 'session-1', userId: 'user-1', target: serverTarget });
  assert.equal(registry.size(), 1);
  liveSessions.revokeSession('session-1');
  assert.equal(registry.size(), 0);
  assert.throws(() => registry.consume(revoked.capability, { sessionId: 'session-1', userId: 'user-1' }), {
    code: 'terminal_capability_invalid',
  });
});

test('terminal target policy accepts only exact root or isolated site identities', () => {
  const registry = createTerminalCapabilityRegistry();
  assert.throws(() => registry.issue({
    sessionId: 'session', userId: 'user', target: { ...serverTarget, user: 'ubuntu' },
  }), { code: 'terminal_target_invalid' });
  assert.doesNotThrow(() => registry.issue({
    sessionId: 'session',
    userId: 'user',
    target: {
      scope: 'site', serverId: 'server-1', websiteId: 'website-1', user: 'yunapp-123456789abc', cwd: '/var/www/yunpanel/apps/app/current',
    },
  }));
});
