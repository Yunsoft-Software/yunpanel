import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsiteMigrationPolicyStore,
  WebsiteMigrationPolicyError,
} from '../src/website-migration-policy.js';

const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);

function completePreview(value = digest) {
  return {
    version: 1,
    digest: value,
    destructive: false,
    autoApply: false,
    counts: { total: 2, alreadyBound: 2, ready: 0, ambiguous: 0, unresolved: 0 },
    items: [
      { status: 'already_bound', action: 'none', requiresConfirmation: false },
      { status: 'already_bound', action: 'none', requiresConfirmation: false },
    ],
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-website-policy-'));
  const filePath = path.join(root, 'website-migration-policy.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createWebsiteMigrationPolicyStore({
    filePath,
    now: () => Date.parse('2026-09-11T00:30:00.000Z'),
  });
  await store.init();
  return { root, filePath, store };
}

test('policy starts in compatibility and finalizes only a complete exact preview', async (t) => {
  const { filePath, store } = await fixture(t);
  assert.deepEqual(store.snapshot(), {
    version: 1,
    mode: 'compatibility',
    enforcedDigest: null,
    transitionedAt: null,
    websiteBindingRequired: false,
  });

  const enforced = await store.finalize({ preview: completePreview(), previewDigest: digest });
  assert.equal(enforced.mode, 'enforced');
  assert.equal(enforced.enforcedDigest, digest);
  assert.equal(enforced.websiteBindingRequired, true);
  assert.equal(enforced.transitionedAt, '2026-09-11T00:30:00.000Z');
  assert.equal((await stat(filePath)).mode & 0o077, 0);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.mode, 'enforced');
  assert.equal(persisted.enforcedDigest, digest);
  assert.equal(Object.hasOwn(persisted, 'websiteBindingRequired'), false);
});

test('finalize rejects stale and incomplete migration state without mutating policy', async (t) => {
  const { filePath, store } = await fixture(t);
  const cases = [
    [{ preview: completePreview(otherDigest), previewDigest: digest }, 'website_migration_preview_stale'],
    [{ preview: { ...completePreview(), counts: { total: 2, alreadyBound: 1, ready: 1, ambiguous: 0, unresolved: 0 } }, previewDigest: digest }, 'website_migration_not_complete'],
    [{ preview: completePreview(), previewDigest: 'bad' }, 'website_migration_preview_digest_invalid'],
  ];

  for (const [input, code] of cases) {
    await assert.rejects(
      store.finalize(input),
      (error) => error instanceof WebsiteMigrationPolicyError && error.code === code,
    );
    assert.equal(store.snapshot().mode, 'compatibility');
  }
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), {
    version: 1,
    mode: 'compatibility',
    enforcedDigest: null,
    transitionedAt: null,
  });
});

test('finalize is idempotent for the same digest and rejects a different finalized state', async (t) => {
  const { store } = await fixture(t);
  const first = await store.finalize({ preview: completePreview(), previewDigest: digest });
  const retry = await store.finalize({ preview: completePreview(), previewDigest: digest });
  assert.deepEqual(retry, first);

  await assert.rejects(
    store.finalize({ preview: completePreview(otherDigest), previewDigest: otherDigest }),
    (error) => error instanceof WebsiteMigrationPolicyError && error.code === 'website_migration_policy_conflict',
  );
  assert.equal(store.snapshot().enforcedDigest, digest);
});

test('rollback requires the exact enforced digest and returns to compatibility without touching resource state', async (t) => {
  const { store } = await fixture(t);
  await store.finalize({ preview: completePreview(), previewDigest: digest });

  await assert.rejects(
    store.rollback({ enforcedDigest: otherDigest }),
    (error) => error instanceof WebsiteMigrationPolicyError && error.code === 'website_migration_rollback_digest_mismatch',
  );
  assert.equal(store.snapshot().mode, 'enforced');

  const rolledBack = await store.rollback({ enforcedDigest: digest });
  assert.equal(rolledBack.mode, 'compatibility');
  assert.equal(rolledBack.enforcedDigest, null);
  assert.equal(rolledBack.websiteBindingRequired, false);
  assert.equal((await store.rollback({ enforcedDigest: digest })).mode, 'compatibility');
});

test('corrupt persisted policy state fails closed', async (t) => {
  const { filePath } = await fixture(t);
  for (const state of [
    { version: 1, mode: 'enforced', enforcedDigest: null, transitionedAt: null },
    { version: 1, mode: 'compatibility', enforcedDigest: digest, transitionedAt: null },
    { version: 99, mode: 'compatibility', enforcedDigest: null, transitionedAt: null },
    { version: 1, mode: 'unknown', enforcedDigest: null, transitionedAt: null },
  ]) {
    await writeFile(filePath, JSON.stringify(state), { mode: 0o600 });
    const reopened = createWebsiteMigrationPolicyStore({ filePath });
    await assert.rejects(reopened.init());
  }
});
