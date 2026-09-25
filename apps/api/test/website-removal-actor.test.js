import assert from 'node:assert/strict';
import test from 'node:test';
import { removalContinue, removalFixture, removalStart } from '../test-support/website-removal-fixture.js';

const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherUserId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const actor = (sessionId = sessionA, id = userId) => ({ sessionId, userId: id, role: 'owner' });

test('Website removal blocks continuation after the Owner session loses live authorization', async () => {
  let allowedSession = sessionA;
  const f = await removalFixture({
    authorizeActor: async (candidate) => candidate.sessionId === allowedSession
      && candidate.userId === userId && candidate.role === 'owner'
      ? Object.freeze({ ...candidate })
      : null,
  });

  let operation = await f.runtime.start({ ...removalStart(f.preview), actor: actor() });
  assert.equal(Object.hasOwn(operation, 'actor'), false);
  const before = operation.updatedAt;
  allowedSession = null;

  await assert.rejects(
    () => f.runtime.continueStep({ ...removalContinue(operation), actor: actor() }),
    (error) => error.code === 'website_removal_actor_forbidden' && error.status === 403,
  );
  operation = await f.runtime.get(operation.id);
  assert.equal(operation.updatedAt, before);
  assert.equal(operation.steps.filter((step) => step.status === 'succeeded').length, 1);
});

test('same Owner account may continue a removal after login rotates to a new live session', async () => {
  let allowedSession = sessionA;
  const f = await removalFixture({
    authorizeActor: async (candidate) => candidate.sessionId === allowedSession
      && candidate.userId === userId && candidate.role === 'owner'
      ? Object.freeze({ ...candidate })
      : null,
  });

  let operation = await f.runtime.start({ ...removalStart(f.preview), actor: actor(sessionA) });
  allowedSession = sessionB;
  operation = await f.runtime.continueStep({
    ...removalContinue(operation),
    actor: actor(sessionB),
  });
  assert.equal(operation.steps.filter((step) => step.status === 'succeeded').length, 2);
});

test('different Owner account cannot take over an existing removal journal', async () => {
  const f = await removalFixture({
    authorizeActor: async (candidate) => Object.freeze({ ...candidate }),
  });
  const operation = await f.runtime.start({ ...removalStart(f.preview), actor: actor() });
  await assert.rejects(
    () => f.runtime.continueStep({
      ...removalContinue(operation),
      actor: actor(sessionB, otherUserId),
    }),
    (error) => error.code === 'website_removal_actor_mismatch' && error.status === 403,
  );
});
