import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { renderCronTaskFile } from '@yunpanel/config-templates';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createLocalWebsiteCronOperation,
  LocalWebsiteCronOperationError,
} from '../src/local-website-cron-operation.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const taskId = '22345678-1234-4234-8234-123456789012';
const websiteId = '32345678-1234-4234-8234-123456789012';
const applicationId = '42345678-1234-4234-8234-123456789012';
const unixUser = 'yunapp-0123456789ab';
const actor = Object.freeze({
  sessionId: '52345678-1234-4234-8234-123456789012',
  userId: '62345678-1234-4234-8234-123456789012',
  role: 'site_manager',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createFixtures({ taskOverrides = {} } = {}) {
  const task = {
    id: taskId,
    websiteId,
    serverId,
    applicationId,
    unixUser,
    name: 'Backup Job',
    schedule: '0 2 * * *',
    command: '/usr/bin/backup.sh',
    enabled: true,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...taskOverrides,
  };

  const rendered = renderCronTaskFile({
    taskId: task.id,
    user: task.unixUser,
    schedule: task.schedule,
    command: task.command,
    enabled: task.enabled,
  });
  const desiredStateSha256 = sha256(rendered);

  let deletedTask = null;
  let currentTask = task;
  const websiteCronRegistry = {
    getTask: async (id) => (id === task.id ? currentTask : null),
    deleteTask: async (id) => {
      deletedTask = id;
      currentTask = null;
      return { deleted: true, taskId: id };
    },
  };

  let appliedInput = null;
  let removedInput = null;
  const websiteCronManager = {
    apply: async (input) => {
      appliedInput = input;
      return { currentSha256: desiredStateSha256, sideEffects: true };
    },
    remove: async (input) => {
      removedInput = input;
      return { taskId, removed: true, previousSha256: desiredStateSha256, sideEffects: true };
    },
  };

  let writtenReceipt = null;
  const receiptStore = {
    write: async (receipt) => {
      writtenReceipt = receipt;
      return receipt;
    },
  };

  const execution = {
    jobId: 'job-cron-001',
    serverId,
    resourceType: 'website_cron',
    resourceId: taskId,
  };

  const payload = {
    taskId,
    websiteId,
    applicationId,
    unixUser,
    expectedRevision: task.revision,
    desiredStateSha256,
    authorizationMode: 'user',
    actorSessionId: actor.sessionId,
    actorUserId: actor.userId,
    actorRole: actor.role,
  };

  return {
    task,
    desiredStateSha256,
    websiteCronRegistry,
    websiteCronManager,
    receiptStore,
    execution,
    payload,
    getAppliedInput: () => appliedInput,
    getRemovedInput: () => removedInput,
    getWrittenReceipt: () => writtenReceipt,
    getDeletedTask: () => deletedTask,
    authorizeActor: async (candidate, targetWebsiteId) => (
      candidate.sessionId === actor.sessionId
      && candidate.userId === actor.userId
      && candidate.role === actor.role
      && targetWebsiteId === websiteId ? actor : null
    ),
  };
}

test('LocalWebsiteCronOperation executes CRON_APPLY and writes receipt', async () => {
  const f = createFixtures();
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
    authorizeActor: f.authorizeActor,
  });

  const result = await operation.execute(OPERATIONS.CRON_APPLY, f.payload, f.execution);

  assert.equal(result.version, 1);
  assert.equal(result.taskId, taskId);
  assert.equal(result.applied, true);
  assert.equal(result.sideEffects, true);
  assert.equal(result.contentSha256, f.desiredStateSha256);

  assert.equal(f.getAppliedInput().taskId, taskId);
  assert.equal(f.getWrittenReceipt().operation, OPERATIONS.CRON_APPLY);
  assert.equal(f.getWrittenReceipt().result.applied, true);
});

test('LocalWebsiteCronOperation executes CRON_REMOVE, deletes from registry and writes receipt', async () => {
  const f = createFixtures();
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
    authorizeActor: f.authorizeActor,
  });

  const result = await operation.execute(OPERATIONS.CRON_REMOVE, f.payload, f.execution);

  assert.equal(result.version, 1);
  assert.equal(result.taskId, taskId);
  assert.equal(result.removed, true);
  assert.equal(result.sideEffects, true);

  assert.equal(f.getRemovedInput().taskId, taskId);
  assert.equal(f.getDeletedTask(), taskId);
  assert.equal(f.getWrittenReceipt().operation, OPERATIONS.CRON_REMOVE);
  assert.equal(f.getWrittenReceipt().result.removed, true);
});

test('LocalWebsiteCronOperation rejects invalid execution context or mismatched payload', async () => {
  const f = createFixtures();
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
    authorizeActor: f.authorizeActor,
  });

  // Invalid execution
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_APPLY, f.payload, { ...f.execution, resourceType: 'domain' }),
    (err) => err instanceof LocalWebsiteCronOperationError && err.code === 'website_cron_execution_context_invalid',
  );

  // Resource mismatch
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_APPLY, f.payload, { ...f.execution, resourceId: 'wrong-task' }),
    (err) => err instanceof LocalWebsiteCronOperationError && err.code === 'website_cron_resource_mismatch',
  );

  // Task not found
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_APPLY, { ...f.payload, taskId: '33333333-1234-4234-8234-123456789012' }, { ...f.execution, resourceId: '33333333-1234-4234-8234-123456789012' }),
    (err) => err instanceof LocalWebsiteCronOperationError && err.code === 'website_cron_task_not_found',
  );

  // Revision conflict
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_APPLY, { ...f.payload, expectedRevision: 99 }, f.execution),
    (err) => err instanceof LocalWebsiteCronOperationError && err.code === 'website_cron_state_conflict',
  );

  // Digest mismatch
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_APPLY, { ...f.payload, desiredStateSha256: 'f'.repeat(64) }, f.execution),
    (err) => err instanceof LocalWebsiteCronOperationError && err.code === 'website_cron_digest_mismatch',
  );
});


test('LocalWebsiteCronOperation holds the shared site lock during host mutation', async () => {
  const f = createFixtures();
  const locks = [];
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
    authorizeActor: f.authorizeActor,
    siteMutationLock: {
      withSiteLock: async (identity, action) => {
        locks.push(identity);
        return action();
      },
    },
  });
  await operation.execute(OPERATIONS.CRON_APPLY, f.payload, f.execution);
  assert.deepEqual(locks, [{ applicationId, websiteId }]);
});


test('LocalWebsiteCronOperation refuses host mutation after live Website grant is revoked', async () => {
  const f = createFixtures();
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
    authorizeActor: async () => null,
  });
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_APPLY, f.payload, f.execution),
    (error) => error.code === 'website_cron_actor_forbidden',
  );
  assert.equal(f.getAppliedInput(), null);
  assert.equal(f.getWrittenReceipt(), null);
});

test('system_removal cron authorization cannot be used for cron.apply', async () => {
  const f = createFixtures();
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
  });
  const systemPayload = {
    ...f.payload,
    authorizationMode: 'system_removal',
  };
  delete systemPayload.actorSessionId;
  delete systemPayload.actorUserId;
  delete systemPayload.actorRole;
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_APPLY, systemPayload, f.execution),
    (error) => error.code === 'website_cron_authorization_invalid',
  );
  assert.equal(f.getAppliedInput(), null);
});


test('system_removal cron remove requires live removal-journal authorization before host mutation', async () => {
  const f = createFixtures();
  const systemPayload = {
    ...f.payload,
    authorizationMode: 'system_removal',
  };
  delete systemPayload.actorSessionId;
  delete systemPayload.actorUserId;
  delete systemPayload.actorRole;
  const authorizations = [];
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
    authorizeSystemRemoval: async (input) => {
      authorizations.push(input);
      return { authorized: true, operationId: 'ws-rem-test', userId: 'owner-test' };
    },
  });
  const result = await operation.execute(OPERATIONS.CRON_REMOVE, systemPayload, f.execution);
  assert.equal(result.removed, true);
  assert.equal(f.getRemovedInput().taskId, taskId);
  assert.deepEqual(authorizations, [{
    taskId,
    websiteId,
    applicationId,
    serverId,
    jobId: f.execution.jobId,
  }]);
});

test('system_removal cron remove is denied before host mutation when removal Owner is no longer live', async () => {
  const f = createFixtures();
  const systemPayload = {
    ...f.payload,
    authorizationMode: 'system_removal',
  };
  delete systemPayload.actorSessionId;
  delete systemPayload.actorUserId;
  delete systemPayload.actorRole;
  const operation = createLocalWebsiteCronOperation({
    websiteCronRegistry: f.websiteCronRegistry,
    websiteCronManager: f.websiteCronManager,
    receiptStore: f.receiptStore,
    authorizeSystemRemoval: async () => null,
  });
  await assert.rejects(
    () => operation.execute(OPERATIONS.CRON_REMOVE, systemPayload, f.execution),
    (error) => error.code === 'website_cron_actor_forbidden' && error.status === 403,
  );
  assert.equal(f.getRemovedInput(), null);
  assert.equal(f.getDeletedTask(), null);
  assert.equal(f.getWrittenReceipt(), null);
});
