import assert from 'node:assert/strict';
import test from 'node:test';
import { MANAGED_SERVICE_IDS, OPERATIONS } from '@yunpanel/protocol';
import { managedServiceHttpInternals } from '../src/managed-service-http.js';

const serverId = 'server-1';
const inspectResult = MANAGED_SERVICE_IDS.map((id) => ({
  id,
  installed: id === 'nginx',
  active: id === 'nginx',
}));

function registry(jobs) {
  return { listJobs: async (filters) => {
    assert.deepEqual(filters, { serverId, resourceType: 'system', resourceId: serverId, status: 'succeeded' });
    return jobs;
  } };
}

test('service snapshot applies newer install/control results over the last full inspection', async () => {
  const inspected = {
    id: 'inspect-job', operation: OPERATIONS.SYSTEM_SERVICES_INSPECT,
    finishedAt: '2026-09-10T00:00:00.000Z', result: inspectResult,
  };
  const controlled = {
    id: 'control-job', operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    finishedAt: '2026-09-10T00:01:00.000Z', result: { id: 'nginx', installed: true, active: false, action: 'stop' },
  };
  const snapshot = await managedServiceHttpInternals.latestServiceSnapshot(registry([controlled, inspected]), serverId);
  assert.equal(snapshot.job.id, 'control-job');
  assert.equal(snapshot.services.find((service) => service.id === 'nginx').active, false);
  assert.equal(snapshot.services.find((service) => service.id === 'mariadb').installed, false);
});

test('newer full inspection supersedes older service mutation state', async () => {
  const controlled = {
    id: 'control-job', operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    finishedAt: '2026-09-10T00:00:00.000Z', result: { id: 'nginx', installed: true, active: false, action: 'stop' },
  };
  const inspected = {
    id: 'inspect-job', operation: OPERATIONS.SYSTEM_SERVICES_INSPECT,
    finishedAt: '2026-09-10T00:02:00.000Z', result: inspectResult,
  };
  const snapshot = await managedServiceHttpInternals.latestServiceSnapshot(registry([inspected, controlled]), serverId);
  assert.equal(snapshot.job.id, 'inspect-job');
  assert.equal(snapshot.services.find((service) => service.id === 'nginx').active, true);
});

test('partial mutation history without a full inspection is not presented as complete inventory', async () => {
  const installed = {
    id: 'install-job', operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    finishedAt: '2026-09-10T00:01:00.000Z', result: { id: 'nginx', installed: true, active: true, changed: true },
  };
  assert.equal(await managedServiceHttpInternals.latestServiceSnapshot(registry([installed]), serverId), null);
});

test('legacy full inspection without the current Roundcube identity is not presented as current inventory', async () => {
  const legacy = {
    id: 'legacy-inspect',
    operation: OPERATIONS.SYSTEM_SERVICES_INSPECT,
    finishedAt: '2026-09-10T00:01:00.000Z',
    result: inspectResult.filter((service) => service.id !== 'roundcube'),
  };
  assert.equal(await managedServiceHttpInternals.latestServiceSnapshot(registry([legacy]), serverId), null);
});
