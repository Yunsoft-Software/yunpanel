import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPowerDnsAuthoritativeService,
  PowerDnsAuthoritativeServiceError,
} from '../src/powerdns-authoritative-service.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'A'.repeat(43);

function identity(revision = 3) {
  return Object.freeze({
    serverId,
    revision,
    settings: Object.freeze({
      publicIpv4: '203.0.113.10',
      publicIpv6: null,
      ns1: Object.freeze({ hostname: 'ns1.example.test', ipv4: '203.0.113.10', ipv6: null, local: true }),
      ns2: Object.freeze({ hostname: 'ns2.example.test', ipv4: '203.0.113.20', ipv6: null, local: false }),
      soa: Object.freeze({ primaryNs: 'ns1.example.test', rname: 'hostmaster.example.test', refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 }),
      dnssecDefault: true,
      secondaryDns: Object.freeze(['203.0.113.20']),
    }),
    warnings: Object.freeze([]),
  });
}

function fixture({ hostError = null, publicReachability = null, hostOperation = null } = {}) {
  let secret = null;
  let currentIdentity = identity();
  let currentHostOperation = hostOperation;
  const managerCalls = [];
  const publicCalls = [];
  function completeHostOperation() {
    if (currentHostOperation?.status !== 'applying') return;
    currentHostOperation = Object.freeze({
      ...currentHostOperation,
      status: 'succeeded',
      evidence: Object.freeze({ satisfied: true }),
      failure: null,
      recovery: Object.freeze({ required: false, automaticReplayBlocked: false, reason: null }),
    });
  }
  function completeRollbackOperation() {
    if (!currentHostOperation?.rollback?.available) return;
    currentHostOperation = Object.freeze({
      ...currentHostOperation,
      status: 'rolled_back',
      recovery: Object.freeze({ required: false, automaticReplayBlocked: false, reason: null }),
      rollback: Object.freeze({
        ...currentHostOperation.rollback,
        status: 'succeeded',
        available: false,
        reason: 'powerdns_rollback_already_completed',
        automaticReplayBlocked: false,
      }),
    });
  }
  const service = createPowerDnsAuthoritativeService({
    localServerId: serverId,
    serverRegistry: { async getServer(id) { return id === serverId ? { id, executionMode: 'local' } : null; } },
    dnsIdentityRegistry: { async getForServer(id) { return id === serverId ? currentIdentity : null; } },
    secretRegistry: {
      async getForServer(id) {
        return id === serverId && secret ? { serverId, revision: secret.revision, configured: true } : null;
      },
      async ensureForServer(id) {
        if (id !== serverId) throw new Error('wrong server');
        if (!secret) secret = { revision: 1, apiKey };
        return { serverId, revision: secret.revision, configured: true };
      },
      async materializeForServer(id) {
        if (id !== serverId || !secret) throw new Error('secret missing');
        return { serverId, revision: secret.revision, apiKey: secret.apiKey };
      },
    },
    manager: {
      async inspect(intent) {
        managerCalls.push(['inspect', intent]);
        if (hostError) throw hostError;
        return { satisfied: true, adapter: 'powerdns-authoritative-gsqlite3', apiKey: 'must-not-leak' };
      },
      async apply(intent) {
        managerCalls.push(['apply', intent]);
        if (hostError) throw hostError;
        return { satisfied: true, adapter: 'powerdns-authoritative-gsqlite3', apiKey: 'must-not-leak' };
      },
      async resolve(intent, recovery) {
        managerCalls.push(['resolve', intent, recovery]);
        if (hostError) throw hostError;
        completeHostOperation();
        return { satisfied: true, adapter: 'powerdns-authoritative-gsqlite3', apiKey: 'must-not-leak' };
      },
      async retry(intent, recovery) {
        managerCalls.push(['retry', intent, recovery]);
        if (hostError) throw hostError;
        completeHostOperation();
        return { satisfied: true, adapter: 'powerdns-authoritative-gsqlite3', apiKey: 'must-not-leak' };
      },
      async rollback(intent, recovery) {
        managerCalls.push(['rollback', intent, recovery]);
        if (hostError) throw hostError;
        completeRollbackOperation();
        return { satisfied: true, adapter: 'powerdns-authoritative-gsqlite3', apiKey: 'must-not-leak' };
      },
      async operation() { return currentHostOperation; },
    },
    publicReachabilityInspector: publicReachability ? {
      async inspect(input) { publicCalls.push(input); return publicReachability; },
    } : undefined,
  });
  return {
    service,
    managerCalls,
    publicCalls,
    setIdentity(value) { currentIdentity = value; },
    rotateSecret() { secret = { revision: (secret?.revision ?? 0) + 1, apiKey: 'B'.repeat(43) }; },
  };
}

test('PowerDNS preview is secret-free and apply materializes the API key only for the host manager', async () => {
  const fx = fixture();
  const preview = await fx.service.preview(serverId);
  assert.equal(preview.secretRevision, 0);
  assert.equal(preview.impact.createApiSecret, true);
  assert.equal(preview.readiness.publicUdp53, 'external-vantage-required');
  assert.equal(preview.readiness.publicTcp53, 'external-vantage-required');
  assert.equal(Object.hasOwn(preview, 'apiKey'), false);
  assert.match(preview.confirmation, new RegExp(`^apply-powerdns-authoritative:${serverId}:3:[a-f0-9]{64}$`));

  const applied = await fx.service.apply(serverId, {
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(applied.ready, true);
  assert.equal(applied.localReady, true);
  assert.equal(applied.publicReady, false);
  assert.equal(applied.overallReady, false);
  assert.equal(applied.publicReachability.status, 'unverified');
  assert.equal(applied.publicReachability.reason, 'external_vantage_probe_unconfigured');
  assert.equal(applied.secretRevision, 1);
  assert.equal(Object.hasOwn(applied.host, 'apiKey'), false);
  assert.equal(fx.managerCalls.length, 1);
  assert.equal(fx.managerCalls[0][0], 'apply');
  assert.equal(fx.managerCalls[0][1].apiKey, apiKey);
  assert.deepEqual(fx.managerCalls[0][1].secondaryDns, ['203.0.113.20']);
});

test('PowerDNS status promotes public readiness only from external inspector evidence', async () => {
  const fx = fixture({
    publicReachability: Object.freeze({
      version: 1,
      status: 'ready',
      ready: true,
      udp53: true,
      tcp53: true,
      reason: null,
      vantage: 'external-probe-1',
      targets: Object.freeze({ ipv4: '203.0.113.10', ipv6: null }),
      checkedAt: '2026-09-16T01:45:00.000Z',
    }),
  });
  const preview = await fx.service.preview(serverId);
  await fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation });
  const status = await fx.service.status(serverId);
  assert.equal(status.localReady, true);
  assert.equal(status.publicReady, true);
  assert.equal(status.overallReady, true);
  assert.equal(status.publicReachability.vantage, 'external-probe-1');
  assert.equal(fx.publicCalls.length, 2);
  assert.equal(fx.publicCalls[0].serverId, serverId);
});

test('PowerDNS status exposes secret-safe durable operation and recovery evidence', async () => {
  const operation = Object.freeze({
    version: 1,
    id: 'operation-1',
    serverId,
    credentialRevision: 1,
    secondaryDns: Object.freeze(['203.0.113.20']),
    status: 'applying',
    evidence: null,
    failure: Object.freeze({ code: 'powerdns_service_activation_failed' }),
    recovery: Object.freeze({ required: true, automaticReplayBlocked: true, reason: 'powerdns_service_activation_failed' }),
    createdAt: '2026-09-17T12:00:00.000Z',
    updatedAt: '2026-09-17T12:01:00.000Z',
  });
  const fx = fixture({ hostOperation: operation });
  const preview = await fx.service.preview(serverId);
  await fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation });

  const status = await fx.service.status(serverId);
  assert.notEqual(status.operation, operation);
  assert.equal(status.operation.id, operation.id);
  assert.equal(status.operation.recovery.automaticReplayBlocked, true);
  assert.equal(status.operation.recovery.confirmation, `inspect-powerdns-recovery:${serverId}:operation-1:2026-09-17T12:01:00.000Z`);
  assert.equal(status.operation.recovery.retryConfirmation, `retry-powerdns-recovery:${serverId}:operation-1:2026-09-17T12:01:00.000Z`);
  assert.equal(JSON.stringify(status.operation).includes('must-not-leak'), false);
});

test('PowerDNS recovery resolution is exact, credential-bound and does not replay apply', async () => {
  const currentOperation = Object.freeze({
    version: 1,
    id: 'operation-recovery',
    serverId,
    credentialRevision: 1,
    secondaryDns: Object.freeze(['203.0.113.20']),
    status: 'applying',
    evidence: null,
    failure: Object.freeze({ code: 'powerdns_service_activation_failed' }),
    recovery: Object.freeze({ required: true, automaticReplayBlocked: true, reason: 'powerdns_service_activation_failed' }),
    createdAt: '2026-09-17T12:00:00.000Z',
    updatedAt: '2026-09-17T12:01:00.000Z',
  });
  const fx = fixture({ hostOperation: currentOperation });
  const preview = await fx.service.preview(serverId);
  await fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation });
  const status = await fx.service.status(serverId);

  await assert.rejects(
    fx.service.resolve(serverId, {
      operationId: status.operation.id,
      expectedUpdatedAt: status.operation.updatedAt,
      confirmation: 'stale-confirmation',
    }),
    (error) => error.code === 'powerdns_recovery_stale' && error.status === 409,
  );
  assert.equal(fx.managerCalls.filter(([action]) => action === 'resolve').length, 0);

  const result = await fx.service.resolve(serverId, {
    operationId: status.operation.id,
    expectedUpdatedAt: status.operation.updatedAt,
    confirmation: status.operation.recovery.confirmation,
  });
  assert.equal(result.resolved, true);
  assert.equal(result.operation.status, 'succeeded');
  assert.deepEqual(fx.managerCalls.at(-1).slice(0, 1), ['resolve']);
  assert.deepEqual(fx.managerCalls.at(-1)[2], {
    operationId: 'operation-recovery',
    expectedUpdatedAt: '2026-09-17T12:01:00.000Z',
  });
  assert.equal(fx.managerCalls.filter(([action]) => action === 'apply').length, 1);
});

test('PowerDNS recovery resolution rejects credential rotation before host inspection', async () => {
  const fx = fixture({
    hostOperation: Object.freeze({
      version: 1,
      id: 'operation-old-credential',
      serverId,
      credentialRevision: 1,
      secondaryDns: Object.freeze(['203.0.113.20']),
      status: 'applying',
      evidence: null,
      failure: Object.freeze({ code: 'powerdns_service_activation_failed' }),
      recovery: Object.freeze({ required: true, automaticReplayBlocked: true, reason: 'powerdns_service_activation_failed' }),
      createdAt: '2026-09-17T12:00:00.000Z',
      updatedAt: '2026-09-17T12:01:00.000Z',
    }),
  });
  const preview = await fx.service.preview(serverId);
  await fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation });
  const status = await fx.service.status(serverId);
  fx.rotateSecret();

  await assert.rejects(
    fx.service.resolve(serverId, {
      operationId: status.operation.id,
      expectedUpdatedAt: status.operation.updatedAt,
      confirmation: status.operation.recovery.confirmation,
    }),
    (error) => error.code === 'powerdns_recovery_credential_changed' && error.status === 409,
  );
  assert.equal(fx.managerCalls.filter(([action]) => action === 'resolve').length, 0);
});

test('PowerDNS explicit retry requires its separate typed confirmation and recovery fence', async () => {
  const operation = Object.freeze({
    version: 1,
    id: 'operation-explicit-retry',
    serverId,
    credentialRevision: 1,
    secondaryDns: Object.freeze(['203.0.113.20']),
    status: 'applying',
    evidence: null,
    failure: Object.freeze({ code: 'powerdns_service_activation_failed' }),
    recovery: Object.freeze({ required: true, automaticReplayBlocked: true, reason: 'powerdns_service_activation_failed' }),
    createdAt: '2026-09-17T12:00:00.000Z',
    updatedAt: '2026-09-17T12:01:00.000Z',
  });
  const fx = fixture({ hostOperation: operation });
  const preview = await fx.service.preview(serverId);
  await fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation });
  const status = await fx.service.status(serverId);

  await assert.rejects(
    fx.service.retry(serverId, {
      operationId: status.operation.id,
      expectedUpdatedAt: status.operation.updatedAt,
      confirmation: status.operation.recovery.confirmation,
    }),
    (error) => error.code === 'powerdns_recovery_stale' && error.status === 409,
  );
  const result = await fx.service.retry(serverId, {
    operationId: status.operation.id,
    expectedUpdatedAt: status.operation.updatedAt,
    confirmation: status.operation.recovery.retryConfirmation,
  });
  assert.equal(result.retried, true);
  assert.equal(result.operation.status, 'succeeded');
  assert.deepEqual(fx.managerCalls.at(-1)[2], {
    operationId: 'operation-explicit-retry',
    expectedUpdatedAt: '2026-09-17T12:01:00.000Z',
  });
  assert.equal(fx.managerCalls.filter(([action]) => action === 'retry').length, 1);
});

test('PowerDNS explicit rollback requires operation snapshot and typed confirmation fences', async () => {
  const operation = Object.freeze({
    version: 2,
    id: 'operation-explicit-rollback',
    serverId,
    credentialRevision: 1,
    secondaryDns: Object.freeze(['203.0.113.20']),
    status: 'succeeded',
    evidence: Object.freeze({ satisfied: true }),
    failure: null,
    recovery: Object.freeze({ required: false, automaticReplayBlocked: false, reason: null }),
    rollback: Object.freeze({
      status: 'idle',
      available: true,
      reason: null,
      snapshotDigest: 'c'.repeat(64),
      previousSecondaryDns: Object.freeze(['198.51.100.53']),
      snapshotCreatedAt: '2026-09-17T11:59:00.000Z',
      automaticReplayBlocked: false,
    }),
    createdAt: '2026-09-17T12:00:00.000Z',
    updatedAt: '2026-09-17T12:01:00.000Z',
  });
  const fx = fixture({ hostOperation: operation });
  const preview = await fx.service.preview(serverId);
  await fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation });
  const status = await fx.service.status(serverId);
  const expectedConfirmation = `rollback-powerdns:${serverId}:${operation.id}:${operation.updatedAt}:${operation.rollback.snapshotDigest}`;
  assert.equal(status.operation.rollback.confirmation, expectedConfirmation);

  await assert.rejects(
    fx.service.rollback(serverId, {
      operationId: operation.id,
      expectedUpdatedAt: operation.updatedAt,
      snapshotDigest: operation.rollback.snapshotDigest,
      confirmation: 'stale-confirmation',
    }),
    (error) => error.code === 'powerdns_rollback_stale' && error.status === 409,
  );
  assert.equal(fx.managerCalls.filter(([action]) => action === 'rollback').length, 0);

  const result = await fx.service.rollback(serverId, {
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    snapshotDigest: operation.rollback.snapshotDigest,
    confirmation: expectedConfirmation,
  });
  assert.equal(result.rolledBack, true);
  assert.equal(result.operation.status, 'rolled_back');
  assert.equal(Object.hasOwn(result.host, 'apiKey'), false);
  assert.deepEqual(fx.managerCalls.at(-1)[2], {
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    snapshotDigest: operation.rollback.snapshotDigest,
  });
});

test('PowerDNS apply rejects DNS identity drift after preview', async () => {
  const fx = fixture();
  const preview = await fx.service.preview(serverId);
  fx.setIdentity(identity(4));

  await assert.rejects(
    fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation }),
    (error) => error instanceof PowerDnsAuthoritativeServiceError
      && error.code === 'powerdns_preview_stale'
      && error.status === 409,
  );
  assert.equal(fx.managerCalls.length, 0);
});

test('PowerDNS host failures retain actionable code but are normalized to 503', async () => {
  const hostError = new Error('pdns recursor conflict');
  hostError.code = 'powerdns_recursor_conflict';
  const fx = fixture({ hostError });
  const preview = await fx.service.preview(serverId);

  await assert.rejects(
    fx.service.apply(serverId, { previewDigest: preview.previewDigest, confirmation: preview.confirmation }),
    (error) => error instanceof PowerDnsAuthoritativeServiceError
      && error.code === 'powerdns_recursor_conflict'
      && error.status === 503,
  );
});

test('PowerDNS service rejects remote server ids and missing DNS identity', async () => {
  const fx = fixture();
  await assert.rejects(
    fx.service.preview('11111111-1111-4111-8111-111111111111'),
    (error) => error instanceof PowerDnsAuthoritativeServiceError
      && error.code === 'powerdns_local_server_required'
      && error.status === 404,
  );
});
