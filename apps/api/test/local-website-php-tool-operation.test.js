import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalWebsitePhpToolOperation } from '../src/local-website-php-tool-operation.js';
import { websitePhpToolActionPreview } from '../src/website-php-tool-action.js';

const binding = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  serverId: '33333333-3333-4333-8333-333333333333',
  applicationId: '22222222-2222-4222-8222-222222222222',
  unixUser: 'yunapp-123456789abc',
  websiteRevision: 4,
};
const preview = websitePhpToolActionPreview(binding, 'wp.cache.flush');
const payload = Object.freeze({
  websiteId: binding.websiteId,
  applicationId: binding.applicationId,
  unixUser: binding.unixUser,
  expectedWebsiteRevision: binding.websiteRevision,
  actorSessionId: '44444444-4444-4444-8444-444444444444',
  actorUserId: '55555555-5555-4555-8555-555555555555',
  actorRole: 'site_manager',
  actionId: preview.actionId,
  previewDigest: preview.previewDigest,
  confirmation: preview.confirmation,
});
const execution = Object.freeze({
  jobId: 'php-action-job-01',
  serverId: binding.serverId,
  resourceType: 'application',
  resourceId: payload.applicationId,
});

test('local PHP action runs only the reviewed fixed action and returns no stdout', async () => {
  const calls = [];
  const operation = createLocalWebsitePhpToolOperation({
    websitePhpToolsService: {
      getActionPreview: async () => preview,
      runWpCli: async (websiteId, action) => {
        calls.push({ websiteId, action });
        return { success: true, exitCode: 0, stdout: 'secret-ish output', stderr: '' };
      },
      runComposer: async () => { throw new Error('unexpected composer'); },
    },
    authorizeActor: async () => ({ sessionId: payload.actorSessionId, userId: payload.actorUserId, role: payload.actorRole }),
  });
  const result = await operation.execute(payload, execution);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action.command, 'cache');
  assert.deepEqual(calls[0].action.args, ['flush']);
  assert.equal(result.completed, true);
  assert.equal(result.sideEffects, true);
  assert.equal(Object.hasOwn(result, 'stdout'), false);
  assert.equal(Object.hasOwn(result, 'stderr'), false);
});

test('local PHP action rejects a mismatched Application execution context before command execution', async () => {
  let ran = false;
  const operation = createLocalWebsitePhpToolOperation({
    websitePhpToolsService: {
      getActionPreview: async () => preview,
      runWpCli: async () => { ran = true; return { success: true, exitCode: 0 }; },
      runComposer: async () => { ran = true; return { success: true, exitCode: 0 }; },
    },
    authorizeActor: async () => ({ sessionId: payload.actorSessionId, userId: payload.actorUserId, role: payload.actorRole }),
  });
  await assert.rejects(() => operation.execute(payload, { ...execution, resourceId: payload.websiteId }));
  assert.equal(ran, false);
});

test('local PHP action refuses stale preview identity', async () => {
  let ran = false;
  const operation = createLocalWebsitePhpToolOperation({
    websitePhpToolsService: {
      getActionPreview: async () => ({ ...preview, websiteRevision: 5 }),
      runWpCli: async () => { ran = true; return { success: true, exitCode: 0 }; },
      runComposer: async () => { ran = true; return { success: true, exitCode: 0 }; },
    },
    authorizeActor: async () => ({ sessionId: payload.actorSessionId, userId: payload.actorUserId, role: payload.actorRole }),
  });
  await assert.rejects(() => operation.execute(payload, execution));
  assert.equal(ran, false);
});

test('failed command is a failed local operation, not a succeeded job with success=false', async () => {
  const operation = createLocalWebsitePhpToolOperation({
    websitePhpToolsService: {
      getActionPreview: async () => preview,
      runWpCli: async () => ({ success: false, exitCode: 1, stdout: '', stderr: 'private' }),
      runComposer: async () => ({ success: false, exitCode: 1 }),
    },
    authorizeActor: async () => ({ sessionId: payload.actorSessionId, userId: payload.actorUserId, role: payload.actorRole }),
  });
  await assert.rejects(
    () => operation.execute(payload, execution),
    (error) => error.code === 'website_php_action_failed',
  );
});


test('local PHP action holds the shared site lock during command execution', async () => {
  const locks = [];
  const operation = createLocalWebsitePhpToolOperation({
    websitePhpToolsService: {
      getActionPreview: async () => preview,
      runWpCli: async () => ({ success: true, exitCode: 0 }),
      runComposer: async () => ({ success: true, exitCode: 0 }),
    },
    authorizeActor: async () => ({ sessionId: payload.actorSessionId, userId: payload.actorUserId, role: payload.actorRole }),
    siteMutationLock: {
      withSiteLock: async (identity, action) => {
        locks.push(identity);
        return action();
      },
    },
  });
  await operation.execute(payload, execution);
  assert.deepEqual(locks, [{
    applicationId: payload.applicationId,
    websiteId: payload.websiteId,
  }]);
});
