import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WebsitePhpToolActionError,
  verifyWebsitePhpToolAction,
  websitePhpToolActionIds,
  websitePhpToolActionPreview,
} from '../src/website-php-tool-action.js';

const binding = Object.freeze({
  websiteId: '11111111-1111-4111-8111-111111111111',
  serverId: '22222222-2222-4222-8222-222222222222',
  applicationId: '33333333-3333-4333-8333-333333333333',
  unixUser: 'yunapp-123456789abc',
  websiteRevision: 7,
});

test('catalog contains only fixed low-scope actions', () => {
  assert.deepEqual(websitePhpToolActionIds(), [
    'wp.cache.flush',
    'wp.transients.delete-all',
    'composer.dump-autoload',
  ]);
});

for (const actionId of websitePhpToolActionIds()) {
  test(`${actionId} preview is deterministic and binds Website revision`, () => {
    const first = websitePhpToolActionPreview(binding, actionId);
    const second = websitePhpToolActionPreview({ ...binding }, actionId);
    assert.equal(first.previewDigest, second.previewDigest);
    assert.equal(first.confirmation, second.confirmation);
    assert.equal(first.websiteRevision, 7);
    assert.match(first.confirmation, /^php-tool:11111111-1111-4111-8111-111111111111:/);
  });

  test(`${actionId} requires exact reviewed confirmation`, () => {
    const preview = websitePhpToolActionPreview(binding, actionId);
    const execution = verifyWebsitePhpToolAction(preview, {
      actionId,
      expectedWebsiteRevision: preview.websiteRevision,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    });
    assert.equal(typeof execution.command, 'string');
    assert.ok(Array.isArray(execution.args));
    assert.ok(Object.isFrozen(execution.args));
  });
}

test('raw commands are not accepted as action ids', () => {
  assert.throws(
    () => websitePhpToolActionPreview(binding, 'plugin update --all'),
    (error) => error instanceof WebsitePhpToolActionError && error.code === 'php_tool_action_unsupported',
  );
});

for (const patch of [
  { websiteId: 'not-a-uuid' },
  { serverId: null },
  { applicationId: '../other' },
  { unixUser: 'root' },
  { websiteRevision: 0 },
]) {
  test(`invalid binding ${Object.keys(patch)[0]} is rejected`, () => {
    assert.throws(() => websitePhpToolActionPreview({ ...binding, ...patch }, 'wp.cache.flush'));
  });
}

test('Website revision changes the preview identity', () => {
  const left = websitePhpToolActionPreview(binding, 'wp.cache.flush');
  const right = websitePhpToolActionPreview({ ...binding, websiteRevision: 8 }, 'wp.cache.flush');
  assert.notEqual(left.previewDigest, right.previewDigest);
  assert.notEqual(left.confirmation, right.confirmation);
});

for (const field of ['actionId', 'expectedWebsiteRevision', 'previewDigest', 'confirmation']) {
  test(`tampered ${field} is stale`, () => {
    const preview = websitePhpToolActionPreview(binding, 'wp.cache.flush');
    const input = {
      actionId: preview.actionId,
      expectedWebsiteRevision: preview.websiteRevision,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    };
    input[field] = field === 'expectedWebsiteRevision' ? 99 : 'tampered';
    assert.throws(
      () => verifyWebsitePhpToolAction(preview, input),
      (error) => error instanceof WebsitePhpToolActionError && error.code === 'php_tool_action_stale',
    );
  });
}

test('unexpected input fields are rejected before execution', () => {
  const preview = websitePhpToolActionPreview(binding, 'composer.dump-autoload');
  assert.throws(() => verifyWebsitePhpToolAction(preview, {
    actionId: preview.actionId,
    expectedWebsiteRevision: preview.websiteRevision,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    args: ['update'],
  }));
});

test('preview integrity is recomputed rather than trusted', () => {
  const preview = websitePhpToolActionPreview(binding, 'wp.transients.delete-all');
  assert.throws(
    () => verifyWebsitePhpToolAction({ ...preview, command: 'plugin' }, {
      actionId: preview.actionId,
      expectedWebsiteRevision: preview.websiteRevision,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (error) => error instanceof WebsitePhpToolActionError && error.code === 'php_tool_preview_invalid',
  );
});
