import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { nodeApplicationUser } from '@yunpanel/config-templates';
import {
  createPassengerSiteManager,
  PassengerSiteManagerError,
} from '../src/passenger-site-manager.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const releaseId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const currentRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
const releaseRoot = `/var/lib/yunpanel/apps/${applicationId}/releases/${releaseId}`;
const managedNode = '/opt/yunpanel/node-runtimes/v24/bin/node';

function intent(overrides = {}) {
  return {
    adapter: 'passenger',
    applicationId,
    websiteId: '3854e385-adfc-42bd-bccf-f655f24cd68f',
    nodeMajor: 24,
    nodeCandidates: [managedNode, '/usr/bin/node'],
    appRoot: currentRoot,
    documentRoot: currentRoot,
    startupFile: 'server.js',
    startMode: 'node',
    appEnv: 'production',
    unixUser: nodeApplicationUser(applicationId),
    healthPath: '/health',
    healthTimeoutSeconds: 30,
    ...overrides,
  };
}

function healthyPassenger() {
  return {
    installed: true,
    installedVersion: '6.0.27-1~noble1',
    healthy: true,
  };
}

function enoent() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

function readyFilesystem({ current = releaseRoot, startupSymlink = false } = {}) {
  return {
    readlinkFn: async (file) => {
      assert.equal(file, currentRoot);
      return `releases/${releaseId}`;
    },
    realpathFn: async (file) => {
      if (file === currentRoot) return current;
      if (file === `${currentRoot}/server.js`) return `${releaseRoot}/server.js`;
      throw new Error(`unexpected realpath ${file}`);
    },
    lstatFn: async (file) => {
      assert.equal(file, `${currentRoot}/server.js`);
      return {
        isFile: () => !startupSymlink,
        isSymbolicLink: () => startupSymlink,
      };
    },
  };
}

test('Passenger Website inspection proves exact Node binary and active managed release', async () => {
  const fs = readyFilesystem();
  const commands = [];
  const manager = createPassengerSiteManager({
    passengerManager: {
      inspect: async () => healthyPassenger(),
      apply: async () => healthyPassenger(),
    },
    run: async (file, args) => {
      commands.push([file, args]);
      if (file === managedNode) return { stdout: 'v24.11.1\n' };
      throw enoent();
    },
    ...fs,
  });

  const result = await manager.inspect(intent());
  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'passenger');
  assert.equal(result.releaseId, releaseId);
  assert.equal(result.nodeBinary, managedNode);
  assert.equal(result.nodeVersion, 'v24.11.1');
  assert.equal(result.unixUser, nodeApplicationUser(applicationId));
  assert.deepEqual(commands, [[managedNode, ['--version']]]);
});

test('Passenger Website inspection blocks cleanly when shared Passenger is unavailable', async () => {
  let nodeCalls = 0;
  const manager = createPassengerSiteManager({
    passengerManager: {
      inspect: async () => ({ installed: false, healthy: false }),
      apply: async () => ({ installed: false, healthy: false }),
    },
    run: async () => { nodeCalls += 1; return { stdout: 'v24.11.1\n' }; },
  });

  const result = await manager.inspect(intent());
  assert.deepEqual(result, {
    satisfied: false,
    reason: 'passenger_runtime_unavailable',
    adapter: 'passenger',
    applicationId,
  });
  assert.equal(nodeCalls, 0);
});

test('Passenger Website inspection requires the requested Node major', async () => {
  const manager = createPassengerSiteManager({
    passengerManager: {
      inspect: async () => healthyPassenger(),
      apply: async () => healthyPassenger(),
    },
    run: async () => ({ stdout: 'v22.19.0\n' }),
  });

  const result = await manager.inspect(intent());
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'passenger_node_unavailable');
  assert.equal(result.nodeMajor, 24);
});

test('Passenger Website inspection keeps missing current release actionable', async () => {
  const manager = createPassengerSiteManager({
    passengerManager: {
      inspect: async () => healthyPassenger(),
      apply: async () => healthyPassenger(),
    },
    run: async (file) => file === managedNode ? { stdout: 'v24.11.1\n' } : Promise.reject(enoent()),
    readlinkFn: async () => { throw enoent(); },
  });

  const result = await manager.inspect(intent());
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'passenger_release_unavailable');
  assert.equal(result.nodeBinary, managedNode);
});

test('Passenger Website inspection rejects release escape outside managed releases', async () => {
  const fs = readyFilesystem({ current: '/tmp/escaped-release' });
  const manager = createPassengerSiteManager({
    passengerManager: {
      inspect: async () => healthyPassenger(),
      apply: async () => healthyPassenger(),
    },
    run: async () => ({ stdout: 'v24.11.1\n' }),
    ...fs,
  });

  await assert.rejects(
    manager.inspect(intent()),
    (error) => error instanceof PassengerSiteManagerError && error.code === 'passenger_site_release_escape',
  );
});

test('Passenger Website inspection rejects a symlink startup file', async () => {
  const fs = readyFilesystem({ startupSymlink: true });
  const manager = createPassengerSiteManager({
    passengerManager: {
      inspect: async () => healthyPassenger(),
      apply: async () => healthyPassenger(),
    },
    run: async () => ({ stdout: 'v24.11.1\n' }),
    ...fs,
  });

  await assert.rejects(
    manager.inspect(intent()),
    (error) => error instanceof PassengerSiteManagerError && error.code === 'passenger_site_startup_invalid',
  );
});

test('Passenger Website apply installs shared Passenger before proving site readiness', async () => {
  const fs = readyFilesystem();
  const events = [];
  const manager = createPassengerSiteManager({
    passengerManager: {
      inspect: async () => { events.push('inspect-passenger'); return healthyPassenger(); },
      apply: async () => { events.push('apply-passenger'); return healthyPassenger(); },
    },
    run: async (file) => {
      events.push(`node:${path.basename(file)}`);
      return { stdout: 'v24.11.1\n' };
    },
    ...fs,
  });

  const result = await manager.apply(intent());
  assert.equal(result.satisfied, true);
  assert.equal(events[0], 'apply-passenger');
  assert.equal(events[1], 'inspect-passenger');
});
