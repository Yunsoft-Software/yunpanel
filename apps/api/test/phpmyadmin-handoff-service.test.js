import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import {
  createPhpMyAdminHandoffService,
  PhpMyAdminHandoffError,
} from '../src/phpmyadmin-handoff-service.js';

function fixture({ liveSessions = null, now = () => 10_000 } = {}) {
  const serverId = randomUUID();
  const websiteId = randomUUID();
  const applicationId = randomUUID();
  const bindingId = randomUUID();
  const credentialId = randomUUID();
  const username = 'ydb_0123456789abcdef01234567';
  const state = {
    bindingRevision: 2,
    credentialRevision: 3,
    desiredStateSha256: 'a'.repeat(64),
    password: 'database-secret-value',
  };
  const calls = [];
  const binding = () => ({
    id: bindingId,
    serverId,
    websiteId,
    applicationId,
    databaseName: 'site_main',
    unixUser: 'yunapp-0123456789ab',
    revision: state.bindingRevision,
  });
  const credential = () => ({
    id: credentialId,
    databaseBindingId: bindingId,
    serverId,
    websiteId,
    applicationId,
    databaseName: 'site_main',
    siteUnixUser: 'yunapp-0123456789ab',
    username,
    host: 'localhost',
    privileges: ['SELECT'],
    revision: state.credentialRevision,
    passwordUpdatedAt: '2026-09-18T00:00:00.000Z',
  });
  const appliedJob = () => ({
    id: 'database-credential-apply-job',
    serverId,
    operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
    resourceType: 'database',
    resourceId: 'site_main',
    status: 'succeeded',
    createdAt: '2026-09-18T00:00:01.000Z',
    startedAt: '2026-09-18T00:00:02.000Z',
    finishedAt: '2026-09-18T00:00:03.000Z',
    result: {
      version: 1,
      databaseCredentialId: credentialId,
      databaseBindingId: bindingId,
      credentialRevision: state.credentialRevision,
      bindingRevision: state.bindingRevision,
      databaseName: 'site_main',
      username,
      host: 'localhost',
      desiredStateSha256: state.desiredStateSha256,
      applied: true,
      sideEffects: true,
    },
  });
  const jobs = [appliedJob()];
  const service = createPhpMyAdminHandoffService({
    databaseBindingRegistry: {
      async getBinding(id) {
        calls.push(['binding', id]);
        return id === bindingId ? binding() : null;
      },
    },
    databaseCredentialRegistry: {
      async getCredential(id) {
        calls.push(['credential', id]);
        return id === credentialId ? credential() : null;
      },
      async materializeCredential(id, input) {
        calls.push(['materialize', id, structuredClone(input)]);
        return id === credentialId ? { ...credential(), password: state.password } : null;
      },
    },
    databaseCredentialApplyService: {
      async previewApply(id) {
        calls.push(['preview', id]);
        const current = credential();
        const currentBinding = binding();
        return {
          version: 1,
          operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
          databaseCredentialId: id,
          databaseBindingId: bindingId,
          serverId,
          databaseName: current.databaseName,
          username: current.username,
          host: current.host,
          privileges: ['SELECT'],
          expectedCredentialRevision: current.revision,
          expectedBindingRevision: currentBinding.revision,
          passwordUpdatedAt: current.passwordUpdatedAt,
          desiredStateSha256: state.desiredStateSha256,
          confirmation: 'unused',
          sideEffects: false,
        };
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['jobs', structuredClone(filter)]);
        return jobs.map((job) => structuredClone(job));
      },
    },
    liveSessions,
    now,
    ttlMs: 5_000,
  });
  return {
    service,
    state,
    calls,
    jobs,
    ids: { serverId, websiteId, applicationId, bindingId, credentialId },
    appliedJob,
  };
}

test('phpMyAdmin handoff is short-lived, single-use and materializes the DB secret only on consume', async () => {
  const current = fixture();
  const issued = await current.service.issue({
    sessionId: 'owner-session',
    userId: 'owner-user',
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    credentialId: current.ids.credentialId,
  });

  assert.match(issued.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.protocol, 'yunpanel-phpmyadmin-signon-v1');
  assert.equal(issued.expiresAt, 15_000);
  assert.deepEqual(issued.target, {
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    databaseCredentialId: current.ids.credentialId,
    databaseName: 'site_main',
  });
  assert.equal(Object.hasOwn(issued, 'password'), false);
  assert.equal(current.calls.some(([name]) => name === 'materialize'), false);

  const consumed = await current.service.consume(issued.capability);
  assert.equal(consumed.username, 'ydb_0123456789abcdef01234567');
  assert.equal(consumed.password, current.state.password);
  assert.equal(consumed.websiteId, current.ids.websiteId);
  assert.equal(current.calls.filter(([name]) => name === 'materialize').length, 1);
  await assert.rejects(
    current.service.consume(issued.capability),
    (error) => error instanceof PhpMyAdminHandoffError && error.code === 'phpmyadmin_handoff_invalid',
  );
});

test('handoff requires the latest database credential job to be the exact current successful apply', async () => {
  const current = fixture();
  current.jobs.push({
    id: 'later-delete',
    serverId: current.ids.serverId,
    operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    resourceType: 'database',
    resourceId: 'site_main',
    status: 'succeeded',
    createdAt: '2026-09-18T00:01:01.000Z',
    finishedAt: '2026-09-18T00:01:02.000Z',
    result: { deleted: true },
  });

  await assert.rejects(
    current.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId: current.ids.serverId,
      websiteId: current.ids.websiteId,
      credentialId: current.ids.credentialId,
    }),
    (error) => error instanceof PhpMyAdminHandoffError
      && error.code === 'phpmyadmin_handoff_credential_not_applied',
  );

  current.jobs.splice(1, 1, {
    id: 'later-failed-apply',
    serverId: current.ids.serverId,
    operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
    resourceType: 'database',
    resourceId: 'site_main',
    status: 'failed',
    createdAt: '2026-09-18T00:02:01.000Z',
    finishedAt: '2026-09-18T00:02:02.000Z',
    result: null,
  });
  await assert.rejects(
    current.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId: current.ids.serverId,
      websiteId: current.ids.websiteId,
      credentialId: current.ids.credentialId,
    }),
    { code: 'phpmyadmin_handoff_credential_not_applied' },
  );
});

test('credential revision drift after issue consumes and rejects the stale handoff without exposing a secret', async () => {
  const current = fixture();
  const issued = await current.service.issue({
    sessionId: 'owner-session',
    userId: 'owner-user',
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    credentialId: current.ids.credentialId,
  });

  current.state.credentialRevision = 4;
  current.state.desiredStateSha256 = 'b'.repeat(64);
  current.jobs.splice(0, 1, current.appliedJob());

  await assert.rejects(
    current.service.consume(issued.capability),
    (error) => error instanceof PhpMyAdminHandoffError && error.code === 'phpmyadmin_handoff_stale',
  );
  assert.equal(current.calls.some(([name]) => name === 'materialize'), false);
  await assert.rejects(current.service.consume(issued.capability), { code: 'phpmyadmin_handoff_invalid' });
});

test('logout revokes unused handoffs and expiration fails closed', async () => {
  let now = 10_000;
  const liveSessions = createLiveSessionRegistry();
  const revoked = fixture({ liveSessions, now: () => now });
  const issued = await revoked.service.issue({
    sessionId: 'owner-session',
    userId: 'owner-user',
    serverId: revoked.ids.serverId,
    websiteId: revoked.ids.websiteId,
    credentialId: revoked.ids.credentialId,
  });
  assert.equal(revoked.service.size(), 1);
  liveSessions.revokeSession('owner-session');
  assert.equal(revoked.service.size(), 0);
  await assert.rejects(revoked.service.consume(issued.capability), { code: 'phpmyadmin_handoff_invalid' });

  const expired = fixture({ now: () => now });
  const expiring = await expired.service.issue({
    sessionId: 'owner-session',
    userId: 'owner-user',
    serverId: expired.ids.serverId,
    websiteId: expired.ids.websiteId,
    credentialId: expired.ids.credentialId,
  });
  now = expiring.expiresAt;
  await assert.rejects(expired.service.consume(expiring.capability), { code: 'phpmyadmin_handoff_expired' });
  assert.equal(expired.calls.some(([name]) => name === 'materialize'), false);
});
