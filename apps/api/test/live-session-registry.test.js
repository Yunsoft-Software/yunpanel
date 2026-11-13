import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';

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

test('T898 pure Website reservation blocks only that Website and binds one durable operation', async () => {
  const registry = createLiveSessionRegistry();
  const closed = [];
  registry.register({ sessionId: 'owner-session', userId: 'owner', websiteId: 'website-a', terminate: () => closed.push('a') });
  registry.register({ sessionId: 'owner-session', userId: 'owner', websiteId: 'website-b', terminate: () => closed.push('b') });
  registry.register({ sessionId: 'owner-session', userId: 'owner', terminate: () => closed.push('root') });
  const reservation = registry.reserveWebsiteRemoval('website-a');
  assert.throws(() => registry.assertWebsiteOpen('website-a'), { code: 'terminal_website_removing' });
  assert.doesNotThrow(() => registry.assertWebsiteOpen('website-b'));
  assert.deepEqual(closed, [], 'A provisional fence must not close processes before the journal exists');
  const snapshot = await reservation.snapshot();
  assert.equal(snapshot.websiteId, 'website-a');
  assert.deepEqual(snapshot.leases, []);
  registry.commitWebsiteRemoval('website-a', 'operation-a', snapshot);
  assert.deepEqual(closed, ['a']);
  assert.throws(() => registry.commitWebsiteRemoval('website-a', 'operation-other', snapshot), { code: 'terminal_website_fence_conflict' });
  const receipt = await registry.drainWebsite('website-a', 'operation-a', { snapshot });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.websiteId, 'website-a');
  assert.equal(receipt.operationId, 'operation-a');
  assert.equal(receipt.processCount, 0);
  assert.equal(registry.size(), 2);
});

test('T898 pure pending-open lease stays tracked until its real scheduling barrier settles without spawning', async () => {
  const registry = createLiveSessionRegistry();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let stopRequested = false;
  const lease = registry.beginWebsiteOpen({
    websiteId: 'website-a', backend: 'node-pty',
    snapshot: () => ({ version: 1, started: false }),
    stop: () => { stopRequested = true; },
    drain: async () => { await barrier; lease.settleWithoutProcess(); },
  });
  const reservation = registry.reserveWebsiteRemoval('website-a');
  const snapshot = await reservation.snapshot();
  registry.commitWebsiteRemoval('website-a', 'operation-a', snapshot);
  assert.equal(stopRequested, true);
  assert.throws(() => registry.beginWebsiteOpen({ websiteId: 'website-a' }), { code: 'terminal_website_removing' });
  let finished = false;
  const draining = registry.drainWebsite('website-a', 'operation-a', { snapshot }).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(registry.websiteLifecycleSize('website-a'), 1);
  release();
  const receipt = await draining;
  assert.equal(receipt.verified, true);
  assert.equal(receipt.processCount, 0);
  assert.equal(registry.websiteLifecycleSize('website-a'), 0);
});

test('T898 provisional fence decision blocks a pending lifecycle action until durable bind or cancellation', async () => {
  for (const action of ['commit', 'cancel']) {
    const registry = createLiveSessionRegistry(); let release;
    const lease = registry.beginWebsiteOpen({ websiteId: 'website-a', backend: 'node-pty',
      snapshot: () => ({ version: 1, started: false }), stop: () => {}, drain: () => {} });
    const reservation = registry.reserveWebsiteRemoval('website-a');
    const decision = lease.awaitRemovalDecision().then(() => { release = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(release, undefined, 'A provisional reservation cannot authorize process signals');
    if (action === 'commit') registry.commitWebsiteRemoval('website-a', 'operation-a', await reservation.snapshot());
    else assert.equal(reservation.cancel(), true);
    await decision; assert.equal(release, true);
    if (action === 'cancel') assert.doesNotThrow(() => registry.assertWebsiteOpen('website-a'));
    else assert.throws(() => registry.assertWebsiteOpen('website-a'), { code: 'terminal_website_removing' });
    lease.settleWithoutProcess();
  }
});

test('T898 an empty restarted tracker cannot manufacture absent lifecycle evidence', async () => {
  const restarted = createLiveSessionRegistry();
  restarted.restoreWebsiteRemoval('website-a', 'operation-a', null);
  assert.throws(() => restarted.assertWebsiteOpen('website-a'), { code: 'terminal_website_removing' });
  await assert.rejects(restarted.drainWebsite('website-a', 'operation-a'), { code: 'terminal_drain_evidence_unavailable' });
});

test('T898 production generation UNKNOWN rejects fresh zero and new site opens without affecting root registration', async () => {
  const registry = createLiveSessionRegistry({ requireGenerationBoundary: true,
    generationBoundary: { version: 1, verified: false, code: 'terminal_drain_generation_unknown' } });
  assert.throws(() => registry.assertWebsiteOpen('website-a'), { code: 'terminal_drain_generation_unknown' });
  assert.throws(() => registry.beginWebsiteOpen({ websiteId: 'website-a', backend: 'node-pty' }), { code: 'terminal_drain_generation_unknown' });
  const reservation = registry.reserveWebsiteRemoval('website-a');
  await assert.rejects(reservation.snapshot(), { code: 'terminal_drain_generation_unknown' });
  assert.equal(reservation.cancel(), true);
  const root = registry.register({ sessionId: 'owner-session', userId: 'owner-user', terminate() {} });
  assert.equal(registry.size(), 1); assert.equal(root.unregister(), true);
  const isolated = createLiveSessionRegistry();
  const isolatedSnapshot = await isolated.reserveWebsiteRemoval('website-a').snapshot();
  assert.equal(isolatedSnapshot.generationBoundary, null, 'Isolated policy tests are not a production startup attestation');
  assert.throws(() => registry.restoreWebsiteRemoval('website-a', 'operation-a', isolatedSnapshot), { code: 'terminal_drain_generation_unknown' });
});

test('T898 actual file-backed journal preserves a fenced zero-open snapshot and verified checkpoint across restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t898-journal-'));
  try {
    const filePath = path.join(directory, 'removals.json');
    const lifecycle = createLiveSessionRegistry();
    const reservation = lifecycle.reserveWebsiteRemoval('website-a');
    const snapshot = await reservation.snapshot();
    const registry = createWebsiteRemovalOperationRegistry({ filePath });
    await registry.init();
    const operation = await registry.create({
      operation: 'website_remove', readyToStart: true,
      website: { id: 'website-a', serverId: 'server-a', applicationId: null, systemUser: null },
      previewDigest: 'policy-preview', confirmation: 'policy-confirmation',
      plan: { domainIds: [], additional: {}, terminalLifecycle: snapshot },
    });
    lifecycle.commitWebsiteRemoval('website-a', operation.id, snapshot);
    const receipt = await lifecycle.drainWebsite('website-a', operation.id, { snapshot });
    const step = operation.steps.find(value => value.kind === 'file_cleanup');
    await registry.checkpointStep(operation.id, step.id, { terminalDrain: receipt });
    const diskRegistry = createWebsiteRemovalOperationRegistry({ filePath });
    await diskRegistry.init();
    const durable = await diskRegistry.get(operation.id);
    const restored = createLiveSessionRegistry();
    restored.restoreWebsiteRemoval(durable.websiteId, durable.id, durable.plan.terminalLifecycle, durable.steps.find(value => value.id === step.id).result.terminalDrain);
    const recovered = await restored.drainWebsite(durable.websiteId, durable.id);
    assert.equal(recovered.verified, true);
    assert.equal(recovered.snapshotSha256, receipt.snapshotSha256);
    assert.equal((await diskRegistry.listForWebsite('website-a')).length, 1);
    assert.throws(() => restored.assertWebsiteOpen('website-a'), { code: 'terminal_website_removing' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T898 malformed persisted closure cannot become zero-process proof and a bounded pending failure stays fenced', async () => {
  const registry = createLiveSessionRegistry();
  const reservation = registry.reserveWebsiteRemoval('website-a');
  const snapshot = await reservation.snapshot();
  registry.commitWebsiteRemoval('website-a', 'operation-a', snapshot);
  const receipt = await registry.drainWebsite('website-a', 'operation-a');
  for (const change of [{ processCount: 1 }, { leaseCount: 1 }, { zeroOpenUnderFence: false }, { scope: 'all_uid_processes' }, { completedAt: 'invalid' }]) {
    const restarted = createLiveSessionRegistry();
    restarted.restoreWebsiteRemoval('website-a', 'operation-a', snapshot, { ...receipt, ...change });
    await assert.rejects(restarted.drainWebsite('website-a', 'operation-a'), { code: 'terminal_drain_unverified' });
    assert.throws(() => restarted.assertWebsiteOpen('website-a'), { code: 'terminal_website_removing' });
  }
  const pending = createLiveSessionRegistry();
  pending.beginWebsiteOpen({ websiteId: 'website-a', backend: 'node-pty', snapshot: () => ({ version: 1, started: false }),
    stop: () => {}, drain: () => new Promise(() => {}) });
  const pendingSnapshot = await pending.reserveWebsiteRemoval('website-a').snapshot();
  pending.commitWebsiteRemoval('website-a', 'operation-a', pendingSnapshot);
  await assert.rejects(pending.drainWebsite('website-a', 'operation-a', { timeoutMs: 20 }), { code: 'terminal_drain_timeout' });
  assert.equal(pending.websiteLifecycleSize('website-a'), 1);
  assert.throws(() => pending.assertWebsiteOpen('website-a'), { code: 'terminal_website_removing' });
});
