import assert from 'node:assert/strict';
import test from 'node:test';
import { managedServicePolicy } from '@yunpanel/host-runtime';
import { MANAGED_SERVICE_IDS } from '@yunpanel/protocol';
import { managedServiceStatePolicy } from '../src/managed-service-state-policy.js';

test('API service result policy matches the host runtime command catalog exactly', () => {
  assert.deepEqual(managedServicePolicy.services.map((entry) => entry.id), MANAGED_SERVICE_IDS);
  for (const service of managedServicePolicy.services) {
    const policy = managedServiceStatePolicy(service.id);
    assert.deepEqual(policy.packages, service.packages);
    assert.deepEqual(policy.units, service.units);
    assert.equal(policy.checksConfiguration, service.configurationChecks.length > 0);
  }
});
