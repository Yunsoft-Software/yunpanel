import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeApplicationUser, nodeServiceName } from '@yunpanel/config-templates';
import { createNodeServiceRemovalManager, NodeServiceRemovalError } from '../src/node-service-removal-manager.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';

function harness({
  deployed = true,
  foreignUnit = false,
  symlinkUnit = false,
  releaseTarget = `releases/${releaseId}`,
  artifacts = true,
  serviceLoaded = true,
} = {}) {
  const serviceName = nodeServiceName(applicationId);
  const account = nodeApplicationUser(applicationId);
  const unitPath = `/systemd/${serviceName}`;
  const environmentPath = `/env/${applicationId}.env`;
  const files = new Map();
  if (artifacts) {
    files.set(unitPath, foreignUnit
      ? '[Unit]\nDescription=foreign service\n'
      : `[Unit]\nDescription=YunPanel Node application ${applicationId}\n[Service]\nUser=${account}\nGroup=${account}\nEnvironmentFile=${environmentPath}\n`);
    files.set(environmentPath, `NODE_ENV="production"\nYUNPANEL_APPLICATION_ID="${applicationId}"\n`);
  }
  const commands = [];
  const removals = [];
  const state = {
    loadState: serviceLoaded ? 'loaded' : 'not-found',
    activeState: serviceLoaded ? 'active' : 'inactive',
    subState: serviceLoaded ? 'running' : 'dead',
    unitFileState: serviceLoaded ? 'enabled' : 'not-found',
    mainPid: serviceLoaded ? 4242 : 0,
  };
  const stdout = () => [
    `LoadState=${state.loadState}`,
    `ActiveState=${state.activeState}`,
    `SubState=${state.subState}`,
    `UnitFileState=${state.unitFileState}`,
    `MainPID=${state.mainPid}`,
    '',
  ].join('\n');

  const manager = createNodeServiceRemovalManager({
    appRoot: '/apps',
    envRoot: '/env',
    systemdRoot: '/systemd',
    systemctlPaths: ['/usr/bin/systemctl'],
    run: async (file, args) => {
      commands.push({ file, args: [...args] });
      if (args[0] === '--version') return { stdout: 'systemd 255\n' };
      if (args[0] === 'show') return { stdout: stdout() };
      if (args[0] === 'stop') {
        state.activeState = 'inactive'; state.subState = 'dead'; state.mainPid = 0;
        return { stdout: '' };
      }
      if (args[0] === 'disable') {
        state.unitFileState = 'disabled';
        return { stdout: '' };
      }
      if (args[0] === 'daemon-reload') {
        if (!files.has(unitPath)) {
          state.loadState = 'not-found';
          state.activeState = 'inactive';
          state.subState = 'dead';
          state.unitFileState = 'not-found';
          state.mainPid = 0;
        }
        return { stdout: '' };
      }
      throw new Error('unexpected systemctl command');
    },
    lstatFn: async (target) => {
      if (!files.has(target)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => symlinkUnit && target === unitPath,
      };
    },
    readFileFn: async (target) => files.get(target),
    readlinkFn: async () => {
      if (!deployed) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return releaseTarget;
    },
    rmFn: async (target) => { removals.push(target); files.delete(target); },
  });
  return { manager, serviceName, unitPath, environmentPath, files, commands, removals, state };
}

test('verified direct-systemd cleanup stops, disables, removes exact artifacts and confirms absence', async () => {
  const h = harness();
  const result = await h.manager.removeService({ applicationId, releaseId, serviceName: h.serviceName });
  assert.equal(result.directSystemdCleaned, true);
  assert.equal(result.serviceStopped, true);
  assert.equal(result.serviceDisabled, true);
  assert.equal(result.unitRemoved, true);
  assert.equal(result.environmentRemoved, true);
  assert.deepEqual(h.removals.sort(), [h.unitPath, h.environmentPath].sort());
  assert.equal(h.commands.some((entry) => entry.args[0] === 'daemon-reload'), true);
  assert.equal(h.state.loadState, 'not-found');
  assert.equal(h.state.mainPid, 0);
});

test('foreign or symlinked unit fails closed before deletion', async () => {
  for (const options of [{ foreignUnit: true }, { symlinkUnit: true }]) {
    const h = harness(options);
    await assert.rejects(
      h.manager.removeService({ applicationId, releaseId, serviceName: h.serviceName }),
      (error) => error instanceof NodeServiceRemovalError
        && ['node_service_cleanup_artifact_ownership_mismatch', 'node_service_cleanup_artifact_unsafe'].includes(error.code),
    );
    assert.deepEqual(h.removals, []);
  }
});

test('cleanup retry is idempotent after unit and environment are already absent', async () => {
  const h = harness({ artifacts: false, serviceLoaded: false });
  const result = await h.manager.removeService({ applicationId, releaseId, serviceName: h.serviceName });
  assert.equal(result.directSystemdCleaned, true);
  assert.equal(result.sideEffects, false);
  assert.deepEqual(h.removals, []);
});

test('undeployed Application accepts only fully absent direct-systemd host state', async () => {
  const clean = harness({ deployed: false, artifacts: false, serviceLoaded: false });
  const result = await clean.manager.removeService({ applicationId, releaseId: null, serviceName: null });
  assert.equal(result.directSystemdCleaned, true);
  assert.equal(result.sideEffects, false);

  const drift = harness({ deployed: false, artifacts: true, serviceLoaded: false });
  await assert.rejects(
    drift.manager.inspectRemoval({ applicationId, releaseId: null, serviceName: null }),
    (error) => error instanceof NodeServiceRemovalError && error.code === 'node_service_cleanup_evidence_unavailable',
  );
});

test('release symlink drift blocks service cleanup', async () => {
  const h = harness({ releaseTarget: 'releases/216e4db8-468b-4e2f-a021-3ab31e0f4123' });
  await assert.rejects(
    h.manager.removeService({ applicationId, releaseId, serviceName: h.serviceName }),
    (error) => error instanceof NodeServiceRemovalError && error.code === 'node_service_cleanup_release_drift',
  );
  assert.deepEqual(h.removals, []);
});
