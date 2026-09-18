import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDomainSuspensionService,
  DomainSuspensionError,
  domainSuspensionInternals,
} from '../src/domain-suspension.js';

const domainId = '12345678-1234-4234-8234-123456789012';
const operationId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);

function activeDomain(overrides = {}) {
  return {
    id: domainId,
    serverId,
    websiteId: null,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    parentDomainId: null,
    certificateId: null,
    desiredRevision: 4,
    stagedRevision: 4,
    appliedRevision: 4,
    stagedChecksum: checksum,
    stagedConfigName: 'yunpanel-example.com.conf',
    appliedPrimaryDomain: 'example.com',
    state: 'active',
    lastError: null,
    suspensionOperationId: null,
    suspendedAt: null,
    suspendedChecksum: null,
    lastSuspensionOperationId: null,
    lastResumedAt: null,
    ...overrides,
  };
}

function fixture({
  domain = activeDomain(),
  jobs = [],
  suspendInspection = null,
  resumeInspection = null,
} = {}) {
  let current = structuredClone(domain);
  const calls = [];
  const nginxManager = {
    async inspectDomainDeactivation(input) {
      calls.push(['inspectSuspend', input]);
      return suspendInspection ?? {
        satisfied: false,
        deactivationCandidate: true,
        restorable: false,
        reason: null,
        configName: 'yunpanel-example.com.conf',
        checksum,
        receiptVersion: null,
      };
    },
    async deactivateDomain(input) {
      calls.push(['deactivate', input]);
      return {
        satisfied: true,
        deactivated: true,
        deactivationCandidate: false,
        restorable: true,
        configName: 'yunpanel-example.com.conf',
        checksum,
        receiptVersion: 1,
        changed: true,
      };
    },
    async inspectDomainDeactivationRollback(input) {
      calls.push(['inspectResume', input]);
      return resumeInspection ?? {
        satisfied: false,
        reason: 'nginx_deactivation_rollback_pending',
        configName: 'yunpanel-example.com.conf',
        checksum,
      };
    },
    async rollbackDomainDeactivation(input) {
      calls.push(['restore', input]);
      return {
        satisfied: true,
        restored: true,
        configName: 'yunpanel-example.com.conf',
        checksum,
        receiptVersion: 1,
        changed: true,
      };
    },
  };
  const domainRegistry = {
    async getDomain(id) {
      return id === domainId ? structuredClone(current) : null;
    },
    async markSuspended(id, input) {
      calls.push(['markSuspended', id, structuredClone(input)]);
      assert.equal(id, domainId);
      if (current.state !== 'active') {
        const error = new Error('not active');
        error.code = 'domain_suspension_state_drift';
        error.status = 409;
        throw error;
      }
      current = {
        ...current,
        state: 'suspended',
        suspensionOperationId: input.operationId,
        suspendedAt: '2026-09-18T16:00:00.000Z',
        suspendedChecksum: input.checksum,
      };
      return structuredClone(current);
    },
    async markResumed(id, input) {
      calls.push(['markResumed', id, structuredClone(input)]);
      assert.equal(id, domainId);
      current = {
        ...current,
        state: 'active',
        suspensionOperationId: null,
        suspendedAt: null,
        suspendedChecksum: null,
        lastSuspensionOperationId: input.operationId,
        lastResumedAt: '2026-09-18T16:01:00.000Z',
      };
      return structuredClone(current);
    },
  };
  const service = createDomainSuspensionService({
    domainRegistry,
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['jobs', filter]);
        return jobs;
      },
    },
    nginxManager,
    localServerId: serverId,
  });
  return {
    service,
    calls,
    current: () => structuredClone(current),
    setDomain(value) { current = structuredClone(value); },
  };
}

test('suspension preview binds exact active revision/checksum, Nginx evidence and active jobs', async () => {
  const fx = fixture();
  const preview = await fx.service.preview({ domainId });

  assert.equal(preview.operation, 'domain_suspend');
  assert.equal(preview.domain.id, domainId);
  assert.equal(preview.domain.desiredRevision, 4);
  assert.equal(preview.domain.stagedChecksum, checksum);
  assert.equal(preview.nginx.deactivationCandidate, true);
  assert.deepEqual(preview.activeJobs, []);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.readyToSuspend, true);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    preview.confirmation,
    `suspend-domain:${domainId}:4:${checksum}:${preview.previewDigest}`,
  );
  assert.equal(preview.sideEffects, false);
});

test('preview blocks non-active routing, unowned Nginx absence and active Domain jobs', async () => {
  const fx = fixture({
    domain: activeDomain({ state: 'draft', appliedRevision: 0, appliedPrimaryDomain: null }),
    jobs: [{ id: 'job-1', operation: 'domain.stage', status: 'running' }],
    suspendInspection: {
      satisfied: false,
      deactivationCandidate: false,
      restorable: false,
      reason: 'nginx_deactivation_unowned_absence',
      configName: 'yunpanel-example.com.conf',
      checksum,
      receiptVersion: null,
    },
  });
  const preview = await fx.service.preview({ domainId });

  assert.deepEqual(preview.blockers, [
    'domain_active_state_required',
    'domain_routing_evidence_invalid',
    'domain_nginx_deactivation_unavailable',
    'domain_job_active',
  ]);
  assert.equal(preview.readyToSuspend, false);
  assert.equal(preview.confirmation, null);
});

test('preview treats Nginx checksum drift as explicit blocker without mutation', async () => {
  const error = new Error('drift');
  error.code = 'nginx_deactivation_drift';
  const fx = fixture();
  fx.service;
  const service = createDomainSuspensionService({
    domainRegistry: {
      getDomain: async () => activeDomain(),
      markSuspended: async () => ({}),
      markResumed: async () => ({}),
    },
    jobRegistry: { listJobs: async () => [] },
    nginxManager: {
      inspectDomainDeactivation: async () => { throw error; },
      deactivateDomain: async () => ({}),
      inspectDomainDeactivationRollback: async () => ({}),
      rollbackDomainDeactivation: async () => ({}),
    },
    localServerId: serverId,
  });
  const preview = await service.preview({ domainId });
  assert.deepEqual(preview.blockers, [
    'domain_nginx_active_state_drift',
    'domain_nginx_deactivation_unavailable',
  ]);
});

test('inspectSuspend distinguishes active, suspended, resumed and drifted control-plane ownership', async () => {
  const fx = fixture();
  let inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'active');

  fx.setDomain(activeDomain({
    state: 'suspended',
    suspensionOperationId: operationId,
    suspendedAt: '2026-09-18T16:00:00.000Z',
    suspendedChecksum: checksum,
  }));
  inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'suspended');

  fx.setDomain(activeDomain({
    lastSuspensionOperationId: operationId,
    lastResumedAt: '2026-09-18T16:01:00.000Z',
  }));
  inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'resumed');

  fx.setDomain(activeDomain({ desiredRevision: 5 }));
  inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'drift');
});

test('host mutation and Domain state commit are separate suspension boundaries', async () => {
  const fx = fixture();

  const host = await fx.service.deactivateHost({
    primaryDomain: 'example.com',
    checksum,
  });
  assert.equal(host.satisfied, true);
  assert.equal(fx.current().state, 'active');

  const committed = await fx.service.commitSuspended({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(committed.state, 'suspended');
  assert.equal(committed.suspensionOperationId, operationId);
});

test('resume inspection and host restore stay separate from Domain resume commit', async () => {
  const fx = fixture({
    domain: activeDomain({
      state: 'suspended',
      suspensionOperationId: operationId,
      suspendedAt: '2026-09-18T16:00:00.000Z',
      suspendedChecksum: checksum,
    }),
  });

  const before = await fx.service.inspectResume({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(before.controlPlane, 'suspended');
  assert.equal(before.host.satisfied, false);
  assert.equal(before.host.reason, 'nginx_deactivation_rollback_pending');

  const restored = await fx.service.restoreHost({
    primaryDomain: 'example.com',
    checksum,
  });
  assert.equal(restored.satisfied, true);
  assert.equal(fx.current().state, 'suspended');

  const committed = await fx.service.commitResumed({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(committed.state, 'active');
  assert.equal(committed.lastSuspensionOperationId, operationId);
});

test('job inventory failure and malformed host inspection fail closed', async () => {
  const jobFailure = createDomainSuspensionService({
    domainRegistry: {
      getDomain: async () => activeDomain(),
      markSuspended: async () => ({}),
      markResumed: async () => ({}),
    },
    jobRegistry: { listJobs: async () => { throw new Error('offline'); } },
    nginxManager: {
      inspectDomainDeactivation: async () => ({}),
      deactivateDomain: async () => ({}),
      inspectDomainDeactivationRollback: async () => ({}),
      rollbackDomainDeactivation: async () => ({}),
    },
    localServerId: serverId,
  });
  await assert.rejects(
    jobFailure.preview({ domainId }),
    (error) => error instanceof DomainSuspensionError
      && error.code === 'domain_suspension_job_inventory_unavailable',
  );

  const hostFailure = createDomainSuspensionService({
    domainRegistry: {
      getDomain: async () => activeDomain(),
      markSuspended: async () => ({}),
      markResumed: async () => ({}),
    },
    jobRegistry: { listJobs: async () => [] },
    nginxManager: {
      inspectDomainDeactivation: async () => ({ satisfied: false }),
      deactivateDomain: async () => ({}),
      inspectDomainDeactivationRollback: async () => ({}),
      rollbackDomainDeactivation: async () => ({}),
    },
    localServerId: serverId,
  });
  await assert.rejects(
    hostFailure.preview({ domainId }),
    (error) => error instanceof DomainSuspensionError
      && error.code === 'domain_suspension_host_inspection_invalid',
  );
});

test('suspension helper digest is deterministic', () => {
  const value = { domainId, revision: 4, checksum };
  assert.equal(
    domainSuspensionInternals.digest(value),
    domainSuspensionInternals.digest(structuredClone(value)),
  );
});
