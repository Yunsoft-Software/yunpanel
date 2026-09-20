import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPythonSiteManager,
  PythonSiteManagerError,
} from '../src/index.js';
import {
  pythonApplicationUser,
  pythonServiceName,
  pythonSocketPath,
} from '@yunpanel/config-templates';

const APP_ID = '340344cf-4e57-4f70-946a-3c6e919e951d';
const USER = pythonApplicationUser(APP_ID);
const SERVICE_NAME = pythonServiceName(APP_ID);
const SOCKET_PATH = pythonSocketPath(APP_ID);
const OPERATION_ID = '11111111-2222-4333-8444-555555555555';

function createMockFs() {
  const files = new Map();
  const dirs = new Set();

  return {
    files,
    dirs,
    lstatFn: async (filePath) => {
      if (files.has(filePath) || dirs.has(filePath)) {
        return { isFile: () => files.has(filePath), isDirectory: () => dirs.has(filePath) };
      }
      const err = new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
      err.code = 'ENOENT';
      throw err;
    },
    mkdirFn: async (dirPath) => {
      dirs.add(dirPath);
    },
    readFileFn: async (filePath) => {
      if (files.has(filePath)) return files.get(filePath);
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async (filePath, content) => {
      files.set(filePath, content);
    },
    rmFn: async (filePath) => {
      files.delete(filePath);
    },
  };
}

test('ensurePrerequisites verifies python3 and venv module', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args.includes('--version')) return { stdout: 'Python 3.12.3\n' };
    if (args.includes('venv')) return { stdout: 'usage: venv ...\n' };
    if (args.includes('import ensurepip')) return { stdout: '' };
    return { stdout: '' };
  };

  const fs = createMockFs();
  const manager = createPythonSiteManager({ run, ...fs });
  const result = await manager.ensurePrerequisites();

  assert.equal(result.version, 'Python 3.12.3');
  assert.equal(result.venvAvailable, true);
});

test('ensureVirtualenv creates venv when missing and skips when present', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    return { stdout: '' };
  };

  const fs = createMockFs();
  const manager = createPythonSiteManager({ run, ...fs });

  // First call: venv does not exist
  const first = await manager.ensureVirtualenv({
    applicationId: APP_ID,
    unixUser: USER,
  });
  assert.equal(first.created, true);
  assert.equal(first.venvPath, `/var/lib/yunpanel/data/${APP_ID}/venv`);

  // Now pretend python exists in venv
  fs.files.set(`/var/lib/yunpanel/data/${APP_ID}/venv/bin/python`, '#!/bin/sh');

  // Second call: venv exists
  const second = await manager.ensureVirtualenv({
    applicationId: APP_ID,
    unixUser: USER,
  });
  assert.equal(second.created, false);
});

test('installRequirements installs requirements.txt when present and skips when absent', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    return { stdout: 'Successfully installed...\n' };
  };

  const fs = createMockFs();
  const manager = createPythonSiteManager({ run, ...fs });

  const releasePath = `/var/lib/yunpanel/apps/${APP_ID}/releases/r1`;

  // Absent
  const absent = await manager.installRequirements({
    applicationId: APP_ID,
    releasePath,
    requirementsFile: 'requirements.txt',
    unixUser: USER,
  });
  assert.equal(absent.installed, false);
  assert.equal(absent.reason, 'requirements_file_not_found');

  // Present
  fs.files.set(`${releasePath}/requirements.txt`, 'flask==3.0.0\n');
  const present = await manager.installRequirements({
    applicationId: APP_ID,
    releasePath,
    requirementsFile: 'requirements.txt',
    unixUser: USER,
  });
  assert.equal(present.installed, true);
  assert.ok(calls.some(([bin, action]) => bin.endsWith('/pip') && action === 'install'));
});

test('apply writes systemd unit, manages systemctl, and records receipt', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args.includes('show')) {
      return { stdout: 'MainPID=12345\nActiveState=active\nSubState=running\nLoadState=loaded\n' };
    }
    return { stdout: '' };
  };

  const fs = createMockFs();
  const manager = createPythonSiteManager({ run, ...fs });

  const result = await manager.apply({
    operationId: OPERATION_ID,
    websiteId: '22222222-2222-4222-8222-222222222222',
    applicationId: APP_ID,
    unixUser: USER,
    runtime: {
      appServer: 'gunicorn',
      entryPoint: 'app:app',
      workers: 2,
    },
  });

  assert.equal(result.serviceName, SERVICE_NAME);
  assert.equal(result.socketPath, SOCKET_PATH);
  assert.equal(result.active, true);
  assert.equal(result.pid, 12345);

  // Verify unit file was written
  assert.ok(fs.files.has(`/etc/systemd/system/${SERVICE_NAME}`));
  const unitContent = fs.files.get(`/etc/systemd/system/${SERVICE_NAME}`);
  assert.match(unitContent, /ExecStart=.*gunicorn --workers 2/);

  // Verify receipt was saved in active state
  assert.ok(fs.files.has(`/var/lib/yunpanel/staging/python-sites/${OPERATION_ID}.json`));
  const receipt = JSON.parse(fs.files.get(`/var/lib/yunpanel/staging/python-sites/${OPERATION_ID}.json`));
  assert.equal(receipt.state, 'active');
  assert.equal(receipt.mutated, true);
  assert.equal(receipt.previousUnit, null);
});

test('compensate rolls back fresh service by stopping and deleting unit', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    return { stdout: '' };
  };

  const fs = createMockFs();
  const manager = createPythonSiteManager({ run, ...fs });

  // First apply
  await manager.apply({
    operationId: OPERATION_ID,
    websiteId: '22222222-2222-4222-8222-222222222222',
    applicationId: APP_ID,
    unixUser: USER,
    runtime: {
      appServer: 'uvicorn',
      entryPoint: 'main:app',
    },
  });

  assert.ok(fs.files.has(`/etc/systemd/system/${SERVICE_NAME}`));

  // Compensate
  const compResult = await manager.compensate({
    operationId: OPERATION_ID,
    applicationId: APP_ID,
  });

  assert.equal(compResult.compensated, true);
  assert.equal(fs.files.has(`/etc/systemd/system/${SERVICE_NAME}`), false);

  const receipt = JSON.parse(fs.files.get(`/var/lib/yunpanel/staging/python-sites/${OPERATION_ID}.json`));
  assert.equal(receipt.state, 'compensated');
});

test('inspect checks active status and socket file', async () => {
  const run = async (bin, args) => {
    if (args.includes('show')) {
      return { stdout: 'MainPID=54321\nActiveState=active\nSubState=running\nLoadState=loaded\n' };
    }
    return { stdout: '' };
  };

  const fs = createMockFs();
  fs.files.set(SOCKET_PATH, 'socket-data');

  const manager = createPythonSiteManager({ run, ...fs });
  const status = await manager.inspect({ applicationId: APP_ID });

  assert.equal(status.serviceName, SERVICE_NAME);
  assert.equal(status.active, true);
  assert.equal(status.mainPid, 54321);
  assert.equal(status.socketExists, true);
});
