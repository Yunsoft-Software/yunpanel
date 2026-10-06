import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import {
  createPgAdminHandoffService,
  PgAdminHandoffError,
} from '../src/pgadmin-handoff-service.js';

const SESSION_DIGEST = 'd'.repeat(64);

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
  const service = createPgAdminHandoffService({
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

test('pgAdmin handoff is short-lived, single-use and materializes the DB secret only on consume', async () => {
  const current = fixture();
  const issued = await current.service.issue({
    sessionId: 'owner-session',
    userId: 'owner-user',
    sessionDigest: SESSION_DIGEST,
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    credentialId: current.ids.credentialId,
  });

  assert.match(issued.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.protocol, 'yunpanel-pgadmin-signon-v1');
  assert.equal(issued.expiresAt, 15_000);
  assert.deepEqual(issued.target, {
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    databaseCredentialId: current.ids.credentialId,
    databaseName: 'site_main',
  });
  assert.equal(Object.hasOwn(issued, 'password'), false);
  assert.equal(current.calls.some(([name]) => name === 'materialize'), false);

  const consumed = await current.service.consume(issued.capability, { sessionDigest: SESSION_DIGEST });
  assert.equal(consumed.username, 'ydb_0123456789abcdef01234567');
  assert.equal(consumed.password, current.state.password);
  assert.equal(consumed.websiteId, current.ids.websiteId);
  assert.equal(consumed.protocol, 'yunpanel-pgadmin-signon-v1');
  assert.equal(current.calls.filter(([name]) => name === 'materialize').length, 1);
  await assert.rejects(
    current.service.consume(issued.capability, { sessionDigest: SESSION_DIGEST }),
    (error) => error instanceof PgAdminHandoffError && error.code === 'pgadmin_handoff_invalid',
  );
});

test('pgAdmin handoff consume is bound to the exact panel cookie digest and remains single-use on mismatch', async () => {
  const current = fixture();
  const issued = await current.service.issue({
    sessionId: 'owner-session',
    userId: 'owner-user',
    sessionDigest: SESSION_DIGEST,
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    credentialId: current.ids.credentialId,
  });

  await assert.rejects(
    current.service.consume(issued.capability, { sessionDigest: 'e'.repeat(64) }),
    (error) => error instanceof PgAdminHandoffError
      && error.code === 'pgadmin_handoff_session_mismatch',
  );
  assert.equal(current.calls.some(([name]) => name === 'materialize'), false);
  await assert.rejects(
    current.service.consume(issued.capability, { sessionDigest: SESSION_DIGEST }),
    { code: 'pgadmin_handoff_invalid' },
  );
});

test('pgAdmin gateway session stays bound to panel identity and current Website grant', async () => {
  const current = fixture();
  const issued = await current.service.issue({
    sessionId: 'site-session',
    userId: 'site-user',
    sessionDigest: SESSION_DIGEST,
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    credentialId: current.ids.credentialId,
  });
  const consumed = await current.service.consume(issued.capability, { sessionDigest: SESSION_DIGEST });

  const authorized = await current.service.authorizeGatewaySession(consumed.gatewaySession, {
    sessionId: 'site-session',
    userId: 'site-user',
    role: 'site_manager',
    websiteIds: [current.ids.websiteId],
  });
  assert.deepEqual(authorized, {
    websiteId: current.ids.websiteId,
    databaseCredentialId: current.ids.credentialId,
    expiresAt: consumed.expiresAt,
  });

  // Cross-site attempt immediately revokes gateway session
  assert.equal(
    await current.service.authorizeGatewaySession(consumed.gatewaySession, {
      sessionId: 'site-session',
      userId: 'site-user',
      role: 'site_manager',
      websiteIds: [randomUUID()],
    }),
    null,
  );
  // Subsequent check fails because it was revoked
  assert.equal(
    await current.service.authorizeGatewaySession(consumed.gatewaySession, {
      sessionId: 'site-session',
      userId: 'site-user',
      role: 'site_manager',
      websiteIds: [current.ids.websiteId],
    }),
    null,
  );
});

test('pgAdmin handoff fails closed if credential is not in applied state', async () => {
  const current = fixture();
  current.jobs.length = 0;

  await assert.rejects(
    current.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      sessionDigest: SESSION_DIGEST,
      serverId: current.ids.serverId,
      websiteId: current.ids.websiteId,
      credentialId: current.ids.credentialId,
    }),
    (error) => error instanceof PgAdminHandoffError
      && error.code === 'pgadmin_handoff_credential_not_applied',
  );
});

test('pgAdmin liveSession logout revokes capability and gateway session', async () => {
  const liveSessions = createLiveSessionRegistry();
  const current = fixture({ liveSessions });
  const issued = await current.service.issue({
    sessionId: 'site-session',
    userId: 'site-user',
    sessionDigest: SESSION_DIGEST,
    serverId: current.ids.serverId,
    websiteId: current.ids.websiteId,
    credentialId: current.ids.credentialId,
  });
  const consumed = await current.service.consume(issued.capability, { sessionDigest: SESSION_DIGEST });

  assert.notEqual(
    await current.service.authorizeGatewaySession(consumed.gatewaySession, {
      sessionId: 'site-session',
      userId: 'site-user',
      role: 'site_manager',
      websiteIds: [current.ids.websiteId],
    }),
    null,
  );

  liveSessions.revokeSession('site-session', 'logout');

  assert.equal(
    await current.service.authorizeGatewaySession(consumed.gatewaySession, {
      sessionId: 'site-session',
      userId: 'site-user',
      role: 'site_manager',
      websiteIds: [current.ids.websiteId],
    }),
    null,
  );
});
