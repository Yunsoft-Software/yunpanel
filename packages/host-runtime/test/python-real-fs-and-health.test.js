import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pythonApplicationUser, pythonServiceName } from '@yunpanel/config-templates';
import {
  createPythonRollbackManager,
  createPythonSiteManager,
} from '../src/index.js';
import { PythonRollbackError } from '../src/python-rollback-manager.js';
import { PythonSiteManagerError } from '../src/python-site-manager.js';
import { defaultWaitForPythonHealth, requestPythonHealth } from '../src/python-site-manager.js';

const APP_ID = '340344cf-4e57-4f70-946a-3c6e919e951d';
const WEBSITE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_WEBSITE_ID = '99999999-9999-4999-8999-999999999999';
const OPERATION_ID = '11111111-2222-4333-8444-555555555555';
const RELEASE_A = 'aaaa1111-1111-4111-8111-111111111111';
const RELEASE_B = 'bbbb2222-2222-4222-8222-222222222222';
const USER = pythonApplicationUser(APP_ID);
const SERVICE_NAME = pythonServiceName(APP_ID);

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function listenUnixHttp(t, socketPath, statusCode) {
  const server = http.createServer((_req, res) => {
    res.writeHead(statusCode, { 'content-type': 'text/plain' });
    res.end(statusCode === 200 ? 'ok' : 'unhealthy');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test('requestPythonHealth and defaultWaitForPythonHealth probe real Unix domain socket HTTP servers', async (t) => {
  const dir = await makeTempDir(t, 'yp-py-sock-');
  const okSock = path.join(dir, 'ok.sock');
  const badSock = path.join(dir, 'bad.sock');
  const missingSock = path.join(dir, 'missing.sock');

  await listenUnixHttp(t, okSock, 200);
  await listenUnixHttp(t, badSock, 503);

  assert.equal(await requestPythonHealth({ socketPath: okSock, healthPath: '/health' }), true);
  assert.equal(await defaultWaitForPythonHealth({ socketPath: okSock, healthPath: '/health', timeoutSeconds: 1 }), true);
  assert.equal(await requestPythonHealth({ socketPath: badSock, healthPath: '/health' }), false);
  assert.equal(await requestPythonHealth({ socketPath: missingSock, healthPath: '/health' }), false);
});

test('python-site-manager fails closed on real temp filesystem for symlinked shared root and permission errors', async (t) => {
  const dir = await makeTempDir(t, 'yp-py-fs-');
  const targetDir = path.join(dir, 'target');
  const symlinkedDataRoot = path.join(dir, 'data-link');
  await mkdir(targetDir, { recursive: true, mode: 0o750 });
  await symlink(targetDir, symlinkedDataRoot);

  const manager = createPythonSiteManager({
    dataRoot: symlinkedDataRoot,
    python3Paths: ['/usr/bin/python3', 'python3'],
    systemctlPaths: ['/nonexistent-yunpanel-systemctl'],
  });

  await assert.rejects(
    () => manager.ensureVirtualenv({ applicationId: APP_ID, unixUser: USER }),
    (error) => error instanceof PythonSiteManagerError
      && (error.code === 'python_shared_root_invalid' || error.code === 'python_prerequisites_missing'),
  );

  // Real non-ENOENT EACCES on a real 0o000 directory must not be treated as absent (non-root hosts)
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const lockedDir = path.join(dir, 'locked');
    await mkdir(lockedDir, { recursive: true, mode: 0o700 });
    await chmod(lockedDir, 0o000);
    t.after(async () => { await chmod(lockedDir, 0o700).catch(() => {}); });

    const lockedManager = createPythonSiteManager({
      systemdDir: lockedDir,
      runRoot: path.join(dir, 'run'),
      envRoot: path.join(dir, 'env'),
      receiptRoot: path.join(dir, 'staging'),
      systemctlPaths: ['/nonexistent-yunpanel-systemctl'],
    });
    await assert.rejects(
      () => lockedManager.inspectRetirement({
        websiteId: WEBSITE_ID,
        applicationId: APP_ID,
        unixUser: USER,
        runtime: { appServer: 'gunicorn', entryPoint: 'app:app' },
      }),
      (error) => error?.code === 'EACCES',
    );
  }
});

test('python-site-manager retire enforces durable provisioning receipt and checkpoint ownership on real disk before touching systemctl', async (t) => {
  const dir = await makeTempDir(t, 'yp-py-retire-');
  const receiptRoot = path.join(dir, 'staging');
  const systemdDir = path.join(dir, 'systemd');
  const runRoot = path.join(dir, 'run');
  const envRoot = path.join(dir, 'env');
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  await mkdir(systemdDir, { recursive: true, mode: 0o755 });
  await mkdir(runRoot, { recursive: true, mode: 0o755 });
  await mkdir(envRoot, { recursive: true, mode: 0o700 });

  const manager = createPythonSiteManager({
    receiptRoot,
    systemdDir,
    runRoot,
    envRoot,
    systemctlPaths: ['/nonexistent-yunpanel-systemctl'],
  });
  const baseIntent = {
    websiteId: WEBSITE_ID,
    applicationId: APP_ID,
    unixUser: USER,
    runtime: { appServer: 'gunicorn', entryPoint: 'app:app', workers: 1 },
    operationId: OPERATION_ID,
  };

  // 1. Missing receipt -> rejected before systemctl lookup
  await assert.rejects(
    () => manager.retire(baseIntent),
    (error) => error instanceof PythonSiteManagerError && error.code === 'python_retirement_not_owned',
  );

  // 2. Foreign websiteId in receipt -> rejected before systemctl lookup
  const receiptPath = path.join(receiptRoot, `${OPERATION_ID}.json`);
  const unitFilePath = path.join(systemdDir, SERVICE_NAME);
  await writeFile(receiptPath, JSON.stringify({
    version: 1,
    operationId: OPERATION_ID,
    websiteId: OTHER_WEBSITE_ID,
    applicationId: APP_ID,
    unixUser: USER,
    serviceName: SERVICE_NAME,
    unitFilePath,
    mutated: true,
    previousUnit: null,
    unitSha256: 'a'.repeat(64),
    state: 'active',
  }), { mode: 0o600 });

  await assert.rejects(
    () => manager.retire(baseIntent),
    (error) => error instanceof PythonSiteManagerError && error.code === 'python_retirement_not_owned',
  );

  // 3. Valid receipt + mismatched checkpoint -> rejected before systemctl lookup
  await writeFile(receiptPath, JSON.stringify({
    version: 1,
    operationId: OPERATION_ID,
    websiteId: WEBSITE_ID,
    applicationId: APP_ID,
    unixUser: USER,
    serviceName: SERVICE_NAME,
    unitFilePath,
    mutated: true,
    previousUnit: null,
    unitSha256: 'a'.repeat(64),
    state: 'active',
  }), { mode: 0o600 });

  const checkpointPath = path.join(receiptRoot, `${OPERATION_ID}.retirement.json`);
  await writeFile(checkpointPath, JSON.stringify({
    version: 1,
    operationId: OPERATION_ID,
    websiteId: OTHER_WEBSITE_ID,
    applicationId: APP_ID,
    unixUser: USER,
    serviceName: SERVICE_NAME,
    unitFilePath,
    state: 'prepared',
  }), { mode: 0o600 });

  await assert.rejects(
    () => manager.retire(baseIntent),
    (error) => error instanceof PythonSiteManagerError && error.code === 'python_retirement_checkpoint_invalid',
  );

  // 4. Valid receipt + absent checkpoint + unavailable systemctl -> fails closed (never assumes absent)
  await rm(checkpointPath, { force: true });
  await assert.rejects(
    () => manager.retire(baseIntent),
    (error) => error instanceof PythonSiteManagerError && error.code === 'python_systemctl_missing',
  );
  await assert.rejects(
    () => manager.inspectRetirement(baseIntent),
    (error) => error instanceof PythonSiteManagerError && error.code === 'python_systemctl_missing',
  );
});

test('python-rollback-manager enforces real release directory and current symlink invariants on disk', async (t) => {
  const dir = await makeTempDir(t, 'yp-py-rb-real-');
  const appRoot = path.join(dir, 'apps');
  const appDir = path.join(appRoot, APP_ID);
  const releasesDir = path.join(appDir, 'releases');
  await mkdir(path.join(releasesDir, RELEASE_A), { recursive: true, mode: 0o750 });
  await symlink(`releases/${RELEASE_A}`, path.join(appDir, 'current'));

  const manager = createPythonRollbackManager({ appRoot });
  const runtime = { appServer: 'gunicorn', entryPoint: 'app:app', workers: 1 };

  // Target release missing on real disk
  await assert.rejects(
    () => manager.rollbackPython({
      applicationId: APP_ID,
      currentReleaseId: RELEASE_A,
      releaseId: RELEASE_B,
      runtime,
    }),
    (error) => error instanceof PythonRollbackError && error.code === 'target_release_not_found',
  );

  // Same release rejected
  await assert.rejects(
    () => manager.rollbackPython({
      applicationId: APP_ID,
      currentReleaseId: RELEASE_A,
      releaseId: RELEASE_A,
      runtime,
    }),
    (error) => error instanceof PythonRollbackError && error.code === 'rollback_target_current',
  );

  // Current symlink drift rejected
  await mkdir(path.join(releasesDir, RELEASE_B), { recursive: true, mode: 0o750 });
  await assert.rejects(
    () => manager.rollbackPython({
      applicationId: APP_ID,
      currentReleaseId: RELEASE_B,
      releaseId: RELEASE_A,
      runtime,
    }),
    (error) => error instanceof PythonRollbackError && error.code === 'python_rollback_release_drift',
  );

  // Confirm symlink untouched after all rejected attempts
  assert.equal((await lstat(path.join(appDir, 'current'))).isSymbolicLink(), true);
});
