import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePassengerHealthProvisioningHandler } from '../src/website-passenger-health-provisioning-handler.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const checksum = 'a'.repeat(64);

function context() {
  return {
    operationId,
    websiteId,
    intent: {
      adapter: 'passenger-health',
      applicationId,
      primaryDomain: 'api.example.test',
      healthPath: '/healthz',
      timeoutSeconds: 30,
    },
    operation: {
      operationId,
      websiteId,
      resources: {
        application: {
          id: applicationId,
          type: 'node',
          runtimeAdapter: 'passenger',
          runtime: { healthPath: '/healthz', healthTimeoutSeconds: 30 },
        },
        website: { id: websiteId, applicationId, runtimeType: 'node' },
        primaryDomain: { primaryDomain: 'api.example.test' },
      },
      steps: [
        {
          id: 'runtime',
          state: 'succeeded',
          evidence: { satisfied: true, adapter: 'passenger', applicationId },
        },
        {
          id: 'nginx',
          state: 'succeeded',
          evidence: { satisfied: true, checksum, configName: 'yunpanel-api.example.test.conf' },
        },
        {
          id: 'domain_activation',
          state: 'succeeded',
          evidence: { satisfied: true, adapter: 'domain-activation', websiteId, nginxChecksum: checksum },
        },
      ],
    },
  };
}

test('Passenger health handler probes the exact planned Nginx Host route', async () => {
  const calls = [];
  const handler = createWebsitePassengerHealthProvisioningHandler({
    healthInspector: {
      inspect: async (spec) => {
        calls.push(spec);
        return {
          satisfied: true,
          adapter: 'nginx-http-health',
          primaryDomain: spec.primaryDomain,
          healthPath: spec.healthPath,
          statusCode: 200,
          attempts: 1,
          route: '127.0.0.1:80',
        };
      },
    },
  });

  const result = await handler.apply(context());
  assert.equal(result.satisfied, true);
  assert.deepEqual(calls, [{ primaryDomain: 'api.example.test', healthPath: '/healthz', timeoutSeconds: 30 }]);
});

test('Passenger health handler returns blocked evidence for non-healthy route without mutating state', async () => {
  const handler = createWebsitePassengerHealthProvisioningHandler({
    healthInspector: {
      inspect: async () => ({
        satisfied: false,
        reason: 'website_health_status_unhealthy',
        adapter: 'nginx-http-health',
        primaryDomain: 'api.example.test',
        healthPath: '/healthz',
        statusCode: 503,
        attempts: 4,
        route: '127.0.0.1:80',
      }),
    },
  });
  const result = await handler.apply(context());
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'website_health_status_unhealthy');
  assert.equal(result.statusCode, 503);
});

test('Passenger health handler rejects evidence drift before issuing a probe', async () => {
  let called = false;
  const handler = createWebsitePassengerHealthProvisioningHandler({
    healthInspector: { inspect: async () => { called = true; return {}; } },
  });
  const value = context();
  value.operation.steps.find((step) => step.id === 'domain_activation').evidence.nginxChecksum = 'b'.repeat(64);
  await assert.rejects(
    handler.apply(value),
    (error) => error?.code === 'website_passenger_health_evidence_invalid',
  );
  assert.equal(called, false);
});
