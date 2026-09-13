import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createDatabaseCredentialApplyService,
  DatabaseCredentialApplyError,
} from '../src/database-credential-apply-service.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const credentialId = '32345678-1234-4234-8234-123456789012';
const websiteId = '42345678-1234-4234-8234-123456789012';
const applicationId = '52345678-1234-4234-8234-123456789012';

function fixture({ activeJobs = [] } = {}) {
  const enqueued = [];
  const binding = {
    id: bindingId,
    serverId,
    databaseName: 'app_main',
    websiteId,
    applicationId,
    unixUser: 'yunapp-abcdef123456',
    revision: 2,
  };
  const credential = {
    id: credentialId,
    databaseBindingId: bindingId,
    serverId,
    databaseName: 'app_main',
    websiteId,
    applicationId,
    siteUnixUser: 'yunapp-abcdef123456',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
    revision: 4,
    passwordUpdatedAt: '2026-09-13T02:30:00.000Z',
  };
  const service = createDatabaseCredentialApplyService({
    databaseBindingRegistry: { async getBinding(id) { return id === bindingId ? binding : null; } },
    databaseCredentialRegistry: { async getCredential(id) { return id === credentialId ? credential : null; } },
    jobRegistry: {
      async listJobs() { return activeJobs; },
      async enqueue(input) {
        enqueued.push(structuredClone(input));
        return { id: '62345678-1234-4234-8234-123456789012', status: 'queued', operation: input.operation };
      },
    },
  });
  return { service, enqueued };
}

test('database credential apply preview queues only secret-free pinned metadata', async () => {
  const state = fixture();
  const preview = await state.service.previewApply(credentialId);
  assert.equal(preview.databaseCredentialId, credentialId);
  assert.equal(preview.databaseBindingId, bindingId);
  assert.equal(preview.expectedCredentialRevision, 4);
  assert.equal(preview.expectedBindingRevision, 2);
  assert.match(preview.desiredStateSha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.sideEffects, false);

  const queued = await state.service.queueApply({
    credentialId,
    expectedCredentialRevision: 4,
    expectedBindingRevision: 2,
    expectedDesiredStateSha256: preview.desiredStateSha256,
    confirmation: preview.confirmation,
  });
  assert.equal(queued.job.operation, OPERATIONS.DATABASE_CREDENTIAL_APPLY);
  assert.deepEqual(state.enqueued[0].payload, {
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    expectedCredentialRevision: 4,
    expectedBindingRevision: 2,
    desiredStateSha256: preview.desiredStateSha256,
  });
  assert.equal(state.enqueued[0].resourceType, 'database');
  assert.equal(state.enqueued[0].resourceId, 'app_main');
  assert.doesNotMatch(JSON.stringify(state.enqueued[0]), /password|ciphertext|siteUnixUser/);
});

test('database credential delete uses separate durable operation with same desired-state pinning', async () => {
  const state = fixture();
  const preview = await state.service.previewDelete(credentialId);
  await state.service.queueDelete({
    credentialId,
    expectedCredentialRevision: preview.expectedCredentialRevision,
    expectedBindingRevision: preview.expectedBindingRevision,
    expectedDesiredStateSha256: preview.desiredStateSha256,
    confirmation: preview.confirmation,
  });
  assert.equal(state.enqueued[0].operation, OPERATIONS.DATABASE_CREDENTIAL_DELETE);
  assert.equal(state.enqueued[0].resourceId, 'app_main');
});

test('stale preview or concurrent database work blocks queueing', async () => {
  const state = fixture();
  const preview = await state.service.previewApply(credentialId);
  await assert.rejects(
    state.service.queueApply({
      credentialId,
      expectedCredentialRevision: 3,
      expectedBindingRevision: 2,
      expectedDesiredStateSha256: preview.desiredStateSha256,
      confirmation: preview.confirmation,
    }),
    (error) => error instanceof DatabaseCredentialApplyError && error.code === 'database_credential_preview_stale',
  );

  const blocked = fixture({ activeJobs: [{ status: 'running', operation: OPERATIONS.DATABASE_INSPECT }] });
  await assert.rejects(
    blocked.service.previewApply(credentialId),
    (error) => error instanceof DatabaseCredentialApplyError && error.code === 'database_job_conflict',
  );
  assert.equal(blocked.enqueued.length, 0);
});
