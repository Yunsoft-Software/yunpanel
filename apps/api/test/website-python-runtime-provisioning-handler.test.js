import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsitePythonRuntimeProvisioningHandler,
  WebsitePythonRuntimeProvisioningError,
} from '../src/website-python-runtime-provisioning-handler.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-6dcb89083f3e';

function intent() {
  return {
    adapter: 'python-runtime',
    websiteId,
    applicationId,
    unixUser,
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'wsgi:application',
      workers: 2,
    },
  };
}

test('Python runtime handler applies systemd service and returns evidence', async () => {
  let appliedWith = null;
  const pythonSiteManager = {
    apply: async (params) => {
      appliedWith = params;
      return {
        serviceName: 'yunpanel-python-6dcb89083f3e43da.service',
        socketPath: `/run/yunpanel/python-${applicationId}.sock`,
        port: null,
        active: true,
        activeState: 'active',
        pid: 12345,
      };
    },
    inspect: async () => ({ active: true }),
    compensate: async () => ({ compensated: true }),
  };
  const handler = createWebsitePythonRuntimeProvisioningHandler({ pythonSiteManager });
  const result = await handler.apply({ intent: intent(), operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'python-runtime');
  assert.equal(result.applicationId, applicationId);
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.serviceName, 'yunpanel-python-6dcb89083f3e43da.service');
  assert.equal(result.active, true);
  assert.equal(appliedWith.operationId, operationId);
  assert.equal(appliedWith.applicationId, applicationId);
});

test('Python runtime handler inspects active state', async () => {
  const pythonSiteManager = {
    apply: async () => ({ active: true }),
    inspect: async ({ applicationId: id }) => {
      assert.equal(id, applicationId);
      return {
        serviceName: 'yunpanel-python-6dcb89083f3e43da.service',
        socketPath: `/run/yunpanel/python-${applicationId}.sock`,
        active: true,
        activeState: 'active',
        mainPid: 12345,
      };
    },
    compensate: async () => ({ compensated: true }),
  };
  const handler = createWebsitePythonRuntimeProvisioningHandler({ pythonSiteManager });
  const result = await handler.inspect({ intent: intent() });

  assert.equal(result.satisfied, true);
  assert.equal(result.active, true);
  assert.equal(result.pid, 12345);
});

test('Python runtime handler compensation calls manager compensate', async () => {
  let compensatedWith = null;
  const pythonSiteManager = {
    apply: async () => ({ active: true }),
    inspect: async () => ({ active: false }),
    compensate: async (params) => {
      compensatedWith = params;
      return { compensated: true };
    },
  };
  const handler = createWebsitePythonRuntimeProvisioningHandler({ pythonSiteManager });
  const result = await handler.compensate({ intent: intent(), operationId });

  assert.equal(result.compensated, true);
  assert.deepEqual(compensatedWith, { operationId, applicationId });

  const inspection = await handler.inspectCompensation({ intent: intent() });
  assert.equal(inspection.satisfied, true);
  assert.equal(inspection.compensated, true);
});

test('Python runtime handler rejects invalid intent', async () => {
  const handler = createWebsitePythonRuntimeProvisioningHandler({
    pythonSiteManager: {
      apply: async () => ({}),
      inspect: async () => ({}),
      compensate: async () => ({}),
    },
  });

  await assert.rejects(
    handler.apply({ intent: { ...intent(), adapter: 'php-fpm' } }),
    (error) => error instanceof WebsitePythonRuntimeProvisioningError
      && error.code === 'website_python_runtime_intent_invalid',
  );
});
