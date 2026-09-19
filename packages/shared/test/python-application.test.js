import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationValidationError,
  DEFAULT_APP_SERVER,
  DEFAULT_PYTHON_VERSION,
  SUPPORTED_APP_SERVERS,
  SUPPORTED_PYTHON_VERSIONS,
  normalizePythonApplicationSpec,
  normalizePythonRestartSpec,
  normalizePythonRollbackSpec,
  normalizePythonRuntimeConfig,
  normalizePythonStatusSpec,
} from '../src/index.js';

test('normalizePythonRuntimeConfig applies canonical defaults', () => {
  const normalized = normalizePythonRuntimeConfig({});
  assert.equal(normalized.pythonVersion, DEFAULT_PYTHON_VERSION);
  assert.equal(normalized.appServer, DEFAULT_APP_SERVER);
  assert.equal(normalized.entryPoint, 'app:app');
  assert.equal(normalized.workers, 2);
  assert.equal(normalized.requirementsFile, 'requirements.txt');
  assert.equal(normalized.documentRoot, '.');
  assert.equal(normalized.healthPath, '/');
  assert.equal(normalized.healthTimeoutSeconds, 10);
  assert.equal(normalized.restartPolicy, 'always');
  assert.equal(normalized.mode, 'production');
  assert.equal(normalized.port, null);
  assert.ok(Object.isFrozen(normalized));
});

test('normalizePythonRuntimeConfig accepts valid custom options', () => {
  const normalized = normalizePythonRuntimeConfig({
    pythonVersion: '3.11',
    appServer: 'uvicorn',
    entryPoint: 'main:api',
    workers: 4,
    requirementsFile: 'config/requirements.txt',
    documentRoot: 'src',
    healthPath: '/healthz',
    healthTimeoutSeconds: 15,
    restartPolicy: 'on-failure',
    mode: 'development',
    port: 8000,
  });

  assert.equal(normalized.pythonVersion, '3.11');
  assert.equal(normalized.appServer, 'uvicorn');
  assert.equal(normalized.entryPoint, 'main:api');
  assert.equal(normalized.workers, 4);
  assert.equal(normalized.requirementsFile, 'config/requirements.txt');
  assert.equal(normalized.documentRoot, 'src');
  assert.equal(normalized.healthPath, '/healthz');
  assert.equal(normalized.healthTimeoutSeconds, 15);
  assert.equal(normalized.restartPolicy, 'on-failure');
  assert.equal(normalized.mode, 'development');
  assert.equal(normalized.port, 8000);
});

test('normalizePythonRuntimeConfig rejects unsupported versions or app servers', () => {
  assert.throws(
    () => normalizePythonRuntimeConfig({ pythonVersion: '2.7' }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_python_version',
  );

  assert.throws(
    () => normalizePythonRuntimeConfig({ appServer: 'waitress' }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_app_server',
  );
});

test('normalizePythonRuntimeConfig rejects invalid entry points or workers', () => {
  assert.throws(
    () => normalizePythonRuntimeConfig({ entryPoint: 'invalid; rm -rf /' }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_entry_point',
  );

  assert.throws(
    () => normalizePythonRuntimeConfig({ workers: 0 }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_workers',
  );

  assert.throws(
    () => normalizePythonRuntimeConfig({ workers: 32 }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_workers',
  );
});

test('normalizePythonRuntimeConfig enforces port requirements when requested', () => {
  assert.throws(
    () => normalizePythonRuntimeConfig({}, { requirePort: true }),
    (error) => error instanceof ApplicationValidationError && error.code === 'python_port_required',
  );

  assert.throws(
    () => normalizePythonRuntimeConfig({ port: 80 }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_python_port',
  );
});

test('normalizePythonApplicationSpec normalizes complete spec', () => {
  const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
  const spec = normalizePythonApplicationSpec({
    applicationId,
    repositoryUrl: 'https://github.com/example/python-web-app.git',
    branch: 'main',
    runtime: {
      appServer: 'uvicorn',
      entryPoint: 'main:app',
    },
    retention: 7,
  });

  assert.equal(spec.applicationId, applicationId);
  assert.equal(spec.repositoryUrl, 'https://github.com/example/python-web-app.git');
  assert.equal(spec.branch, 'main');
  assert.deepEqual(spec.gitTarget, { kind: 'branch', value: 'main' });
  assert.equal(spec.runtime.appServer, 'uvicorn');
  assert.equal(spec.retention, 7);
  assert.ok(Object.isFrozen(spec));
});

test('normalizePythonApplicationSpec rejects invalid fields', () => {
  assert.throws(
    () => normalizePythonApplicationSpec({ invalid: 'field' }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_application_spec',
  );
});

test('normalizes python rollback, restart, and status specs', () => {
  const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
  const releaseId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
  const currentReleaseId = 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e';

  const rollback = normalizePythonRollbackSpec({
    applicationId,
    releaseId,
    currentReleaseId,
    runtime: { appServer: 'gunicorn', entryPoint: 'app:app' },
  });
  assert.equal(rollback.applicationId, applicationId);
  assert.equal(rollback.releaseId, releaseId);
  assert.equal(rollback.currentReleaseId, currentReleaseId);
  assert.equal(rollback.runtime.appServer, 'gunicorn');

  const restart = normalizePythonRestartSpec({
    applicationId,
    releaseId,
    runtime: { appServer: 'uvicorn', entryPoint: 'main:app' },
  });
  assert.equal(restart.applicationId, applicationId);
  assert.equal(restart.releaseId, releaseId);
  assert.equal(restart.runtime.appServer, 'uvicorn');

  const status = normalizePythonStatusSpec({
    applicationId,
    releaseId,
    runtime: { appServer: 'gunicorn', entryPoint: 'wsgi:application' },
  });
  assert.equal(status.applicationId, applicationId);
  assert.equal(status.releaseId, releaseId);
});
