import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebsitePhpToolsService, WebsitePhpToolsServiceError } from '../src/website-php-tools-service.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const unixUser = 'yunapp-123456789abc';

function harness({ revision = 4, mutateAfterRead = false } = {}) {
  let reads = 0;
  const website = { id: websiteId, serverId, applicationId, unixUser, runtimeType: 'php', revision };
  const application = { id: applicationId, serverId, unixUser, type: 'php' };
  return createWebsitePhpToolsService({
    websiteRegistry: {
      async getWebsite(id) {
        assert.equal(id, websiteId);
        reads += 1;
        return { ...website, revision: mutateAfterRead && reads > 1 ? revision + 1 : revision };
      },
    },
    applicationRegistry: { async getApplication(id) { assert.equal(id, applicationId); return { ...application }; } },
    phpCliToolManager: {},
    lstatFn: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
}

test('reviewed action preview binds current Website and revision', async () => {
  const preview = await harness().getActionPreview(websiteId, 'wp.cache.flush');
  assert.equal(preview.websiteId, websiteId);
  assert.equal(preview.serverId, serverId);
  assert.equal(preview.applicationId, applicationId);
  assert.equal(preview.unixUser, unixUser);
  assert.equal(preview.websiteRevision, 4);
  assert.equal(preview.actionId, 'wp.cache.flush');
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.confirmation, /^php-tool:/);
});

test('unsupported raw-like action cannot be previewed', async () => {
  await assert.rejects(() => harness().getActionPreview(websiteId, 'plugin update --all'));
});

test('preview is rejected when Website revision changes during inspection', async () => {
  await assert.rejects(
    () => harness({ mutateAfterRead: true }).getActionPreview(websiteId, 'composer.dump-autoload'),
    (error) => error instanceof WebsitePhpToolsServiceError && error.code === 'website_php_context_changed',
  );
});

test('preview refuses Website records without a positive revision', async () => {
  await assert.rejects(
    () => harness({ revision: 0 }).getActionPreview(websiteId, 'wp.transients.delete-all'),
    (error) => error instanceof WebsitePhpToolsServiceError && error.code === 'website_php_context_changed',
  );
});
