import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';

const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const applicationId = '11111111-1111-4111-8111-111111111111';
const releaseId = '22222222-2222-4222-8222-222222222222';
const websiteId = '33333333-3333-4333-8333-333333333333';
const domainId = '44444444-4444-4444-8444-444444444444';
const digest = createHash('sha256').update(applicationId).digest('hex');
const serviceName = `yunpanel-node-${digest.slice(0, 16)}.service`;
const applicationUser = `yunapp-${digest.slice(0, 12)}`;
const runtime = Object.freeze({
  nodeMajor: 24,
  port: 3100,
  mode: 'production',
  documentRoot: '.',
  start: Object.freeze({ mode: 'node', entryFile: 'server.js' }),
  healthPath: '/health',
});
const payload = Object.freeze({
  node: Object.freeze({ applicationId, releaseId, runtime }),
  domain: Object.freeze({
    primaryDomain: 'example.com',
    aliases: Object.freeze(['www.example.com']),
    tls: null,
    canonicalRedirect: false,
    httpsRedirect: false,
    nginxSettings: Object.freeze({
      clientMaxBodySizeMb: null,
      proxyTimeoutSeconds: null,
      websocket: true,
      headers: Object.freeze([]),
    }),
  }),
  authority: Object.freeze({
    websiteId,
    websiteRevision: 3,
    domainId,
    domainDesiredRevision: 4,
    domainAppliedRevision: 4,
  }),
});
const passengerTarget = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: applicationUser,
  group: applicationUser,
  appEnv: 'production',
  environmentInclude: `/etc/yunpanel/passenger-env/${applicationId}.conf`,
});

function migratedResult(overrides = {}) {
  return {
    satisfied: true,
    state: 'migrated',
    applicationId,
    releaseId,
    targetHealthy: true,
    resumed: false,
    cleanup: {
      complete: true,
      stopped: true,
      disabled: true,
      serviceName,
    },
    nginx: {
      sourceChecksum: 'a'.repeat(64),
      targetChecksum: 'b'.repeat(64),
    },
    passengerTarget,
    ...overrides,
  };
}

async function enqueueMigration(registry) {
  return registry.enqueue({
    serverId,
    type: 'app.node.passenger-migrate',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload,
    resourceType: 'application',
    resourceId: applicationId,
  });
}

test('Passenger migration can pass through the durable async queue contract', async () => {
  const registry = createJobRegistry();
  const queued = await enqueueMigration(registry);
  assert.equal(queued.operation, OPERATIONS.APP_NODE_PASSENGER_MIGRATE);
  assert.equal(Object.hasOwn(queued, 'payload'), false);

  const claim = await registry.claimNext(serverId);
  assert.equal(claim.job.id, queued.id);
  assert.deepEqual(claim.envelope.payload, payload);
  assert.deepEqual(claim.envelope.payload.authority, payload.authority);

  const completed = await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: { ...migratedResult(), ignored: 'must not survive sanitization' },
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(Object.hasOwn(completed, 'payload'), false);
  assert.equal(Object.hasOwn(completed.result, 'ignored'), false);
  assert.deepEqual(completed.result.passengerTarget, passengerTarget);
  assert.equal(completed.result.cleanup.serviceName, serviceName);
});

test('Passenger migration queue rejects result evidence that drifts from the queued runtime', async () => {
  const registry = createJobRegistry();
  const queued = await enqueueMigration(registry);
  await registry.claimNext(serverId);

  await assert.rejects(
    registry.complete({
      serverId,
      jobId: queued.id,
      status: 'succeeded',
      result: migratedResult({ passengerTarget: { ...passengerTarget, startupFile: 'other.js' } }),
    }),
    (error) => error?.code === 'invalid_job_result',
  );
  assert.equal((await registry.getJob(queued.id)).status, 'running');
});
