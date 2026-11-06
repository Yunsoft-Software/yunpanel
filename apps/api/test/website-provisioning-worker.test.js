import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningWorker } from '../src/website-provisioning-worker.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const owner = { sessionId: 'session-1', userId: 'user-1', role: 'owner' };

function fixture({ operations, websites = ['site-1'], removals = {}, actors = {}, runNext } = {}) {
  const calls = [];
  const errors = [];
  const ops = operations ?? [{ operationId: 'op-1', websiteId: 'site-1', updatedAt: '2026-11-06T11:59:00.000Z' }];
  const worker = createWebsiteProvisioningWorker({
    registry: {
      listAdvanceable: async () => ops,
      getActor: async (id) => (id in actors ? actors[id] : owner),
    },
    runtime: { runNext: runNext ?? (async (id, actor) => { calls.push([id, actor]); return { outcome: 'progressed' }; }) },
    websiteRegistry: { getWebsite: async (id) => (websites.includes(id) ? { id } : null) },
    removalRegistry: { listForWebsite: async (id) => removals[id] ?? [] },
    now: () => NOW,
    onError: (error) => errors.push(error),
  });
  return { worker, calls, errors };
}

test('a stalled provisioning step is advanced on the server with the creator authority', async () => {
  const f = fixture();
  await f.worker.runOnce();
  assert.deepEqual(f.calls, [['op-1', owner]]);
});

test('provisioning of a removed Website or one being removed is never resumed', async () => {
  const gone = fixture({ websites: [] });
  await gone.worker.runOnce();
  assert.equal(gone.calls.length, 0);
  const removing = fixture({ removals: { 'site-1': [{ status: 'running' }] } });
  await removing.worker.runOnce();
  assert.equal(removing.calls.length, 0);
  const removedBefore = fixture({ removals: { 'site-1': [{ status: 'removed' }] } });
  await removedBefore.worker.runOnce();
  assert.equal(removedBefore.calls.length, 1);
});

test('an operation without an actor or idle for over a day is left for the panel', async () => {
  const noActor = fixture({ actors: { 'op-1': null } });
  await noActor.worker.runOnce();
  assert.equal(noActor.calls.length, 0);
  const old = fixture({ operations: [{ operationId: 'op-1', websiteId: 'site-1', updatedAt: '2026-11-04T11:00:00.000Z' }] });
  await old.worker.runOnce();
  assert.equal(old.calls.length, 0);
});

test('a refused authority pauses the operation until it changes, and a busy site is retried', async () => {
  let attempts = 0;
  const forbidden = fixture({ runNext: async () => { attempts += 1; throw Object.assign(new Error('changed'), { status: 403, code: 'website_provisioning_actor_forbidden' }); } });
  await forbidden.worker.runOnce();
  await forbidden.worker.runOnce();
  assert.equal(attempts, 1, 'the same journal state is not retried');
  assert.equal(forbidden.errors[0].code, 'website_provisioning_actor_forbidden');

  let busyAttempts = 0;
  const busy = fixture({ runNext: async () => { busyAttempts += 1; throw Object.assign(new Error('busy'), { code: 'site_mutation_locked' }); } });
  await busy.worker.runOnce();
  await busy.worker.runOnce();
  assert.equal(busyAttempts, 2);
  assert.equal(busy.errors.length, 0);
});
