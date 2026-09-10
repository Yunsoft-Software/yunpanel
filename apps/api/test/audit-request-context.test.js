import assert from 'node:assert/strict';
import test from 'node:test';
import { currentAuditActorId, withAuditActor } from '../src/audit-request-context.js';

test('audit actor context survives asynchronous work without leaking across requests', async () => {
  assert.equal(currentAuditActorId(), null);
  const values = await Promise.all([
    withAuditActor('owner-a', async () => {
      await Promise.resolve();
      return currentAuditActorId();
    }),
    withAuditActor('owner-b', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentAuditActorId();
    }),
  ]);
  assert.deepEqual(values, ['owner-a', 'owner-b']);
  assert.equal(currentAuditActorId(), null);
});

test('nested audit actor context restores the outer actor', () => {
  withAuditActor('owner-a', () => {
    assert.equal(currentAuditActorId(), 'owner-a');
    withAuditActor('owner-b', () => assert.equal(currentAuditActorId(), 'owner-b'));
    assert.equal(currentAuditActorId(), 'owner-a');
  });
});

test('invalid audit actor context is rejected before running work', () => {
  let called = false;
  assert.throws(() => withAuditActor('../bad', () => { called = true; }), /actor id/);
  assert.throws(() => withAuditActor('owner', null), /operation/);
  assert.equal(called, false);
});
