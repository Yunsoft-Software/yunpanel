import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations, LOCAL_HOST_OPERATIONS } from '../src/local-host-operations.js';

test('local host operations dispatch managed service inspect install and control', async () => {
  const calls = [];
  const operations = createLocalHostOperations({
    managedServiceManager: {
      inspect: async (serviceId) => { calls.push(['inspect', serviceId]); return serviceId ? { id: serviceId } : []; },
      install: async (serviceId) => { calls.push(['install', serviceId]); return { id: serviceId, installed: true, active: true, changed: true }; },
      control: async (serviceId, action) => { calls.push(['control', serviceId, action]); return { id: serviceId, action }; },
    },
  });

  assert.ok(LOCAL_HOST_OPERATIONS.includes(OPERATIONS.SYSTEM_SERVICES_INSPECT));
  assert.ok(LOCAL_HOST_OPERATIONS.includes(OPERATIONS.SYSTEM_SERVICE_INSTALL));
  assert.ok(LOCAL_HOST_OPERATIONS.includes(OPERATIONS.SYSTEM_SERVICE_CONTROL));
  assert.equal(operations.supports(OPERATIONS.SYSTEM_SERVICES_INSPECT), true);
  assert.equal(operations.supports(OPERATIONS.SYSTEM_SERVICE_INSTALL), true);
  assert.equal(operations.supports(OPERATIONS.SYSTEM_SERVICE_CONTROL), true);

  await operations.executeOperation(OPERATIONS.SYSTEM_SERVICES_INSPECT, {});
  await operations.executeOperation(OPERATIONS.SYSTEM_SERVICES_INSPECT, { serviceId: 'docker' });
  await operations.executeOperation(OPERATIONS.SYSTEM_SERVICE_INSTALL, { serviceId: 'mariadb' });
  await operations.executeOperation(OPERATIONS.SYSTEM_SERVICE_CONTROL, { serviceId: 'nginx', action: 'restart' });

  assert.deepEqual(calls, [
    ['inspect', null],
    ['inspect', 'docker'],
    ['install', 'mariadb'],
    ['control', 'nginx', 'restart'],
  ]);
});
