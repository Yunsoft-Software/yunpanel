import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAiPolicyStore } from '../src/ai-policy-store.js';

test('AI policy store persists revisioned allow/confirm/deny overrides in a private file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-ai-policy-'));
  const filePath = path.join(dir, 'state', 'ai-policy.json');
  const store = createAiPolicyStore({ filePath, now: () => '2026-09-21T00:00:00.000Z' });
  const initial = await store.init();
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.overrides, { tool: {}, risk: {} });

  const preview = await store.previewUpdate({
    expectedRevision: 1,
    tool: { 'application.deploy': 'allow' },
    risk: { reversible_write: 'confirm' },
  });
  const updated = await store.applyUpdate({
    expectedRevision: 1,
    tool: { 'application.deploy': 'allow' },
    risk: { reversible_write: 'confirm' },
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.overrides.tool['application.deploy'], 'allow');
  assert.equal(updated.overrides.risk.reversible_write, 'confirm');
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(parsed.revision, 2);
  store.clearCache();
  assert.equal((await store.getSnapshot()).digest, updated.digest);
});

test('AI policy store rejects stale revisions and unsafe destructive auto-allow overrides', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-ai-policy-'));
  const store = createAiPolicyStore({ filePath: path.join(dir, 'policy.json') });
  await store.init();

  await assert.rejects(
    store.previewUpdate({ expectedRevision: 2, tool: {} }),
    (error) => error.code === 'ai_policy_revision_conflict',
  );
  await assert.rejects(
    store.previewUpdate({ expectedRevision: 1, tool: { 'backup.restore': 'allow' } }),
    (error) => error.code === 'unsafe_ai_policy_override',
  );
  await assert.rejects(
    store.previewUpdate({ expectedRevision: 1, risk: { destructive: 'allow' } }),
    (error) => error.code === 'unsafe_ai_policy_override',
  );
});

test('AI policy store supports explicit override removal through null patch values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-ai-policy-'));
  const store = createAiPolicyStore({ filePath: path.join(dir, 'policy.json') });
  const first = await store.previewUpdate({ expectedRevision: 1, tool: { 'website.restart': 'deny' } });
  const snapshot = await store.applyUpdate({
    expectedRevision: 1,
    tool: { 'website.restart': 'deny' },
    previewDigest: first.previewDigest,
    confirmation: first.confirmation,
  });
  const second = await store.previewUpdate({ expectedRevision: snapshot.revision, tool: { 'website.restart': null } });
  const cleared = await store.applyUpdate({
    expectedRevision: snapshot.revision,
    tool: { 'website.restart': null },
    previewDigest: second.previewDigest,
    confirmation: second.confirmation,
  });
  assert.deepEqual(cleared.overrides.tool, {});
});
