import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';

const applicationId = '22222222-2222-4222-8222-222222222222';
const websiteId = '33333333-3333-4333-8333-333333333333';
const domainId = '44444444-4444-4444-8444-444444444444';

test('site mutation lock serializes the same Application across lock instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    const alive = (pid) => {
      if (pid === 1111 || pid === 2222) return true;
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    };
    const firstLock = createSiteMutationLock({ root, pid: 1111, signalProcess: alive });
    const secondLock = createSiteMutationLock({ root, pid: 2222, signalProcess: alive });
    let release;
    let lockAcquired;
    const lockAcquiredPromise = new Promise((resolve) => { lockAcquired = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const first = firstLock.withApplicationLock(applicationId, async () => {
      lockAcquired();
      await pending;
      return 'first';
    });
    await lockAcquiredPromise;
    await assert.rejects(
      () => secondLock.withApplicationLock(applicationId, async () => 'second'),
      (error) => error.code === 'site_mutation_locked' && error.status === 409,
    );
    release();
    assert.equal(await first, 'first');
    assert.equal(await secondLock.withApplicationLock(applicationId, async () => 'third'), 'third');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('different Application and Website identities do not share a lock file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    const lock = createSiteMutationLock({ root, pid: 1234, signalProcess: () => true });
    let release;
    let lockAcquired;
    const lockAcquiredPromise = new Promise((resolve) => { lockAcquired = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const first = lock.withApplicationLock(applicationId, async () => {
      lockAcquired();
      await pending;
      return 'application';
    });
    await lockAcquiredPromise;
    assert.equal(await lock.withWebsiteLock(websiteId, async () => 'website'), 'website');
    release();
    assert.equal(await first, 'application');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dead-process stale lock is removed but invalid lock is never stolen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    await mkdir(root, { recursive: true });
    const target = path.join(root, `application-${applicationId}.lock`);
    await writeFile(target, JSON.stringify({
      version: 1,
      resourceType: 'application',
      resourceId: applicationId,
      pid: 1111,
      token: '44444444-4444-4444-8444-444444444444',
      createdAt: new Date().toISOString(),
    }));
    const lock = createSiteMutationLock({
      root,
      pid: 2222,
      signalProcess: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); },
    });
    assert.equal(await lock.withApplicationLock(applicationId, async () => 'recovered'), 'recovered');

    await writeFile(target, '{"broken":true}');
    await assert.rejects(
      () => lock.withApplicationLock(applicationId, async () => 'must-not-run'),
      (error) => error.code === 'site_mutation_lock_unreadable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('site lock prefers Application identity and falls back to Website identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    const lock = createSiteMutationLock({ root });
    assert.equal(await lock.withSiteLock({ applicationId, websiteId }, async () => 'app'), 'app');
    assert.equal(await lock.withSiteLock({ websiteId }, async () => 'website'), 'website');
    await assert.rejects(() => lock.withSiteLock({}, async () => {}), { code: 'site_mutation_lock_identity_invalid' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('mutation callback errors are preserved and the lock is still released', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    const lock = createSiteMutationLock({ root });
    const failure = Object.assign(new Error('domain mutation failed'), { code: 'domain_mutation_failed' });
    await assert.rejects(
      () => lock.withApplicationLock(applicationId, async () => { throw failure; }),
      (error) => error === failure,
    );
    assert.equal(await lock.withApplicationLock(applicationId, async () => 'after-failure'), 'after-failure');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('site mutation lock serializes the same Domain across lock instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    const alive = (pid) => {
      if (pid === 1111 || pid === 2222) return true;
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    };
    const firstLock = createSiteMutationLock({ root, pid: 1111, signalProcess: alive });
    const secondLock = createSiteMutationLock({ root, pid: 2222, signalProcess: alive });
    let release;
    let lockAcquired;
    const lockAcquiredPromise = new Promise((resolve) => { lockAcquired = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const first = firstLock.withDomainLock(domainId, async () => {
      lockAcquired();
      await pending;
      return 'first';
    });
    await lockAcquiredPromise;
    await assert.rejects(
      () => secondLock.withDomainLock(domainId, async () => 'second'),
      (error) => error.code === 'site_mutation_locked' && error.status === 409,
    );
    release();
    assert.equal(await first, 'first');
    assert.equal(await secondLock.withDomainLock(domainId, async () => 'third'), 'third');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('site lock falls back to Domain identity when applicationId and websiteId are null', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    const lock = createSiteMutationLock({ root });
    assert.equal(await lock.withSiteLock({ domainId }, async () => 'domain'), 'domain');
    assert.equal(await lock.withSiteLock({ websiteId, domainId }, async () => 'website'), 'website');
    assert.equal(await lock.withSiteLock({ applicationId, websiteId, domainId }, async () => 'app'), 'app');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid domain identity throws site_mutation_lock_identity_invalid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-'));
  try {
    const lock = createSiteMutationLock({ root });
    await assert.rejects(
      () => lock.withDomainLock('not-a-uuid', async () => {}),
      { code: 'site_mutation_lock_identity_invalid' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
