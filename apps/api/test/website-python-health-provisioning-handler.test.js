import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePythonHealthProvisioningHandler } from '../src/website-python-health-provisioning-handler.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const checksum = 'a'.repeat(64);

function context() {
  return {
    operationId,
    websiteId,
    intent: {
      adapter: 'python-health',
      applicationId,
      primaryDomain: 'pyapp.example.test',
      healthPath: '/healthz',
      timeoutSeconds: 30,
    },
    operation: {
      operationId,
      websiteId,
      resources: {
        application: {
          id: applicationId,
          type: 'python',
          runtime: { healthPath: '/healthz', healthTimeoutSeconds: 30 },
        },
        website: { id: websiteId, applicationId, runtimeType: 'python' },
        primaryDomain: { primaryDomain: 'pyapp.example.test' },
      },
      steps: [
        {
          id: 'python_runtime',
          state: 'succeeded',
          evidence: { satisfied: true, adapter: 'python-runtime', applicationId },
        },
        {
          id: 'nginx',
          state: 'succeeded',
          evidence: { satisfied: true, checksum, configName: 'yunpanel-pyapp.example.test.conf' },
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

test('Python health handler probes the exact planned Nginx Host route', async () => {
  const calls = [];
  const handler = createWebsitePythonHealthProvisioningHandler({
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
  assert.deepEqual(calls, [{ primaryDomain: 'pyapp.example.test', healthPath: '/healthz', timeoutSeconds: 30 }]);
});

test('Python health handler returns blocked evidence for non-healthy route without mutating state', async () => {
  const handler = createWebsitePythonHealthProvisioningHandler({
    healthInspector: {
      inspect: async () => ({
        satisfied: false,
        reason: 'website_health_status_unhealthy',
        adapter: 'nginx-http-health',
        primaryDomain: 'pyapp.example.test',
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

test('Python health handler rejects evidence drift before issuing a probe', async () => {
  let called = false;
  const handler = createWebsitePythonHealthProvisioningHandler({
    healthInspector: { inspect: async () => { called = true; return {}; } },
  });
  const value = context();
  value.operation.steps.find((step) => step.id === 'domain_activation').evidence.nginxChecksum = 'b'.repeat(64);
  await assert.rejects(
    handler.apply(value),
    (error) => error?.code === 'website_python_health_evidence_invalid',
  );
  assert.equal(called, false);
});
