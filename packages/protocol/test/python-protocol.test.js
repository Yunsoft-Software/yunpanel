import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  isKnownOperation,
  isReadOnlyOperation,
  OPERATIONS,
  validateOperationEnvelope,
} from '../src/index-node-passenger.js';

const APP_ID = '340344cf-4e57-4f70-946a-3c6e919e951d';
const RELEASE_ID = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
const CURRENT_RELEASE_ID = 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e';
const DEPLOYMENT_ID = 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f';

test('python operations are known and APP_PYTHON_STATUS is read-only', () => {
  assert.equal(isKnownOperation(OPERATIONS.APP_PYTHON_DEPLOY), true);
  assert.equal(isKnownOperation(OPERATIONS.APP_PYTHON_ROLLBACK), true);
  assert.equal(isKnownOperation(OPERATIONS.APP_PYTHON_RESTART), true);
  assert.equal(isKnownOperation(OPERATIONS.APP_PYTHON_STATUS), true);

  assert.equal(isReadOnlyOperation(OPERATIONS.APP_PYTHON_STATUS), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.APP_PYTHON_DEPLOY), false);
  assert.equal(isReadOnlyOperation(OPERATIONS.APP_PYTHON_ROLLBACK), false);
  assert.equal(isReadOnlyOperation(OPERATIONS.APP_PYTHON_RESTART), false);
});

test('validates APP_PYTHON_DEPLOY envelope and payload', () => {
  const validEnvelope = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'job-python-deploy-1',
    operation: OPERATIONS.APP_PYTHON_DEPLOY,
    payload: {
      applicationId: APP_ID,
      deploymentId: DEPLOYMENT_ID,
      repositoryUrl: 'https://github.com/yunsoft/fastapi-app.git',
      branch: 'main',
      runtime: {
        appServer: 'uvicorn',
        entryPoint: 'main:app',
        workers: 4,
      },
      retention: 5,
    },
  };

  const validation = validateOperationEnvelope(validEnvelope);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.errors, []);

  const invalidEnvelope = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'job-python-deploy-2',
    operation: OPERATIONS.APP_PYTHON_DEPLOY,
    payload: {
      applicationId: 'not-a-uuid',
      repositoryUrl: 'ftp://bad.url',
    },
  };
  const failed = validateOperationEnvelope(invalidEnvelope);
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.length > 0);
});

test('validates APP_PYTHON_ROLLBACK envelope and payload', () => {
  const validEnvelope = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'job-python-rollback-1',
    operation: OPERATIONS.APP_PYTHON_ROLLBACK,
    payload: {
      applicationId: APP_ID,
      releaseId: RELEASE_ID,
      currentReleaseId: CURRENT_RELEASE_ID,
      runtime: {
        appServer: 'gunicorn',
        entryPoint: 'wsgi:application',
      },
    },
  };

  const validation = validateOperationEnvelope(validEnvelope);
  assert.equal(validation.ok, true);
});

test('validates APP_PYTHON_RESTART and APP_PYTHON_STATUS envelopes', () => {
  const restart = validateOperationEnvelope({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'job-python-restart-1',
    operation: OPERATIONS.APP_PYTHON_RESTART,
    payload: {
      applicationId: APP_ID,
      releaseId: RELEASE_ID,
      runtime: {
        appServer: 'gunicorn',
        entryPoint: 'app:app',
      },
    },
  });
  assert.equal(restart.ok, true);

  const status = validateOperationEnvelope({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'job-python-status-1',
    operation: OPERATIONS.APP_PYTHON_STATUS,
    payload: {
      applicationId: APP_ID,
      releaseId: RELEASE_ID,
      runtime: {
        appServer: 'gunicorn',
        entryPoint: 'app:app',
      },
    },
  });
  assert.equal(status.ok, true);
});

test('validates DOMAIN_STAGE envelope with python targetType', () => {
  const domainStage = validateOperationEnvelope({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'job-domain-stage-python',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'py.example.com',
      aliases: ['www.py.example.com'],
      targetType: 'python',
      target: {
        socketPath: `/run/yunpanel/python-${APP_ID}.sock`,
      },
      nginxSettings: {
        clientMaxBodySizeMb: 100,
        proxyTimeoutSeconds: 120,
        websocket: true,
        headers: [],
      },
      canonicalRedirect: false,
      httpsRedirect: false,
    },
  });
  assert.equal(domainStage.ok, true);
});
