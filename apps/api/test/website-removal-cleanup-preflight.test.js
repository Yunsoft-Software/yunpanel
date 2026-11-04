import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { removalFixture, removalPreview } from '../test-support/website-removal-fixture.js';

test('preview allows removal when Unix ownership evidence is unavailable (unprovisioned or legacy user preserved)', async () => {
  const preview = removalPreview('site-a', {}, { systemUser: 'yunapp-site-a' });
  const identityUnavailableErr = () => {
    const err = new Error('Owned Website Unix identity evidence is unavailable');
    err.code = 'website_cleanup_identity_evidence_unavailable';
    throw err;
  };
  const f = await removalFixture({
    fileCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupInspector: identityUnavailableErr,
  }, preview);
  const runtime = createWebsiteRemovalRuntime({
    ...f.dependencies,
    fileCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupInspector: identityUnavailableErr,
  });
  const value = await runtime.preview({ websiteId: preview.website.id });
  assert.equal(value.readyToStart, true);
  assert.equal(value.hardBlockers.includes('unix_cleanup_evidence_unavailable'), false);
  assert.equal(value.hardBlockers.includes('file_cleanup_preflight_failed'), false);
  assert.ok(typeof value.confirmation === 'string' && value.confirmation.startsWith('start-website-remove:'));
});

test('preview allows removal when file cleanup inspector fails due to missing Unix provisioning evidence', async () => {
  const preview = removalPreview('site-a', {}, { systemUser: 'yunapp-site-a' });
  const identityUnavailableErr = () => {
    const err = new Error('Owned Website Unix identity evidence is unavailable');
    err.code = 'website_cleanup_identity_evidence_unavailable';
    throw err;
  };
  const f = await removalFixture({
    fileCleanupInspector: identityUnavailableErr,
    unixIdentityCleanupInspector: identityUnavailableErr,
  }, preview);
  const runtime = createWebsiteRemovalRuntime({
    ...f.dependencies,
    fileCleanupInspector: identityUnavailableErr,
    unixIdentityCleanupInspector: identityUnavailableErr,
  });
  const value = await runtime.preview({ websiteId: preview.website.id });
  assert.equal(value.readyToStart, true);
  assert.equal(value.hardBlockers.includes('file_cleanup_preflight_failed'), false);
  assert.equal(value.hardBlockers.includes('unix_cleanup_evidence_unavailable'), false);
  assert.ok(typeof value.confirmation === 'string' && value.confirmation.startsWith('start-website-remove:'));
});

test('preview still blocks unsafe canonical file roots before removal starts', async () => {
  const preview = removalPreview();
  const runtime = createWebsiteRemovalRuntime({
    ...(await removalFixture()).dependencies,
    fileCleanupInspector: async () => {
      const err = new Error('Managed Website cleanup root is not a regular directory');
      err.code = 'website_cleanup_path_unsafe';
      throw err;
    },
    unixIdentityCleanupInspector: async () => ({ ready: true }),
  });
  const value = await runtime.preview({ websiteId: preview.website.id });
  assert.equal(value.readyToStart, false);
  assert.ok(value.hardBlockers.includes('file_cleanup_preflight_failed'));
  assert.equal(value.confirmation, null);
});

test('execution succeeds when Unix identity and file cleanup lack ownership receipt evidence', async () => {
  const preview = removalPreview('site-a', {}, { systemUser: 'yunapp-site-a' });
  const identityUnavailableErr = () => {
    const err = new Error('Owned Website Unix identity evidence is unavailable');
    err.code = 'website_cleanup_identity_evidence_unavailable';
    throw err;
  };
  const f = await removalFixture({
    fileCleanupInspector: identityUnavailableErr,
    unixIdentityCleanupInspector: identityUnavailableErr,
    fileCleanupHandler: identityUnavailableErr,
    unixIdentityCleanupHandler: identityUnavailableErr,
  }, preview);
  const runtime = createWebsiteRemovalRuntime({
    ...f.dependencies,
    fileCleanupInspector: identityUnavailableErr,
    unixIdentityCleanupInspector: identityUnavailableErr,
    fileCleanupHandler: identityUnavailableErr,
    unixIdentityCleanupHandler: identityUnavailableErr,
  });
  const prev = await runtime.preview({ websiteId: preview.website.id });
  assert.equal(prev.readyToStart, true);

  const started = await runtime.start({
    websiteId: preview.website.id,
    previewDigest: prev.previewDigest,
    confirmation: prev.confirmation,
  });
  assert.ok(['running', 'removed'].includes(started.status));
});
