import assert from 'node:assert/strict';
import test from 'node:test';
import { createPythonDeploymentManager, PythonDeploymentError } from '../src/python-deployment-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const DEPLOYMENT_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';

function deploymentSpec(overrides = {}) {
  return {
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    repositoryUrl: 'https://github.com/example/python-app',
    branch: 'main',
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'app:app',
      workers: 2,
      requirementsFile: 'requirements.txt',
      documentRoot: '.',
      healthPath: '/health',
      healthTimeoutSeconds: 10,
      restartPolicy: 'always',
      mode: 'production',
    },
    retention: 3,
    ...overrides,
  };
}

function createHarness({
  gitCommit = 'a'.repeat(40),
  gitFail = false,
  healthResult = true,
  activeState = 'active',
  existingReleases = [],
} = {}) {
  const commands = [];
  const links = [];
  const removals = [];
  const writes = [];
  const siteManagerCalls = [];

  const run = async (file, args, options = {}) => {
    commands.push({ file, args, options });
    if (file === '/usr/bin/git' && args.includes('rev-parse')) {
      if (gitFail) throw new Error('git rev-parse failed');
      return { stdout: `${gitCommit}\n` };
    }
    if (file === '/usr/bin/git' && gitFail) {
      throw new Error('git command failed');
    }
    return { stdout: '' };
  };

  const pythonSiteManager = {
    ensureVirtualenv: async (args) => {
      siteManagerCalls.push({ method: 'ensureVirtualenv', args });
      return { venvPath: `/data/${args.applicationId}/venv`, created: true };
    },
    installRequirements: async (args) => {
      siteManagerCalls.push({ method: 'installRequirements', args });
      return { installed: true };
    },
    apply: async (args) => {
      siteManagerCalls.push({ method: 'apply', args });
      return {
        serviceName: `yunpanel-python-${args.applicationId.slice(0, 8)}.service`,
        socketPath: `/run/yunpanel/python-${args.applicationId}.sock`,
        port: args.runtime?.port ?? null,
        active: activeState === 'active',
        activeState,
        pid: 1234,
      };
    },
    inspect: async (args) => {
      siteManagerCalls.push({ method: 'inspect', args });
      return {
        serviceName: `yunpanel-python-${args.applicationId.slice(0, 8)}.service`,
        socketPath: `/run/yunpanel/python-${args.applicationId}.sock`,
        active: activeState === 'active',
        activeState,
        healthy: activeState === 'active',
      };
    },
    restart: async (args) => {
      siteManagerCalls.push({ method: 'restart', args });
      return {
        serviceName: `yunpanel-python-${args.applicationId.slice(0, 8)}.service`,
        socketPath: `/run/yunpanel/python-${args.applicationId}.sock`,
        active: activeState === 'active',
        healthy: activeState === 'active',
      };
    },
  };

  const manager = createPythonDeploymentManager({
    appRoot: '/apps',
    dataRoot: '/data',
    envRoot: '/env',
    pythonSiteManager,
    run,
    mkdirFn: async () => {},
    lstatFn: async () => ({
      isFile: () => true,
      isDirectory: () => true,
      mtimeMs: 1000,
    }),
    readdirFn: async () => existingReleases.map((name) => ({
      name,
      isDirectory: () => true,
    })),
    renameFn: async () => {},
    rmFn: async (target, opts) => removals.push({ target, opts }),
    symlinkFn: async (target, linkPath) => links.push({ target, linkPath }),
    writeFileFn: async (target, content) => writes.push({ target, content }),
    waitForHealth: async () => healthResult,
  });

  return {
    manager,
    commands,
    links,
    removals,
    writes,
    siteManagerCalls,
  };
}

test('deployPython deploys Python application successfully', async () => {
  const harness = createHarness();
  const spec = deploymentSpec();
  const result = await harness.manager.deployPython(spec);

  assert.equal(result.releaseId, DEPLOYMENT_ID);
  assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(result.active, true);
  assert.equal(result.healthy, true);
  assert.equal(result.applied, true);

  // Verifies virtualenv and requirements were installed
  assert.ok(harness.siteManagerCalls.some((c) => c.method === 'ensureVirtualenv'));
  assert.ok(harness.siteManagerCalls.some((c) => c.method === 'installRequirements'));
  assert.ok(harness.siteManagerCalls.some((c) => c.method === 'apply'));

  // Verifies symlink was created
  assert.ok(harness.links.some((l) => l.target === `releases/${DEPLOYMENT_ID}`));
});

test('deployPython fails when git command fails', async () => {
  const harness = createHarness({ gitFail: true });
  const spec = deploymentSpec();

  await assert.rejects(
    () => harness.manager.deployPython(spec),
    (error) => error instanceof PythonDeploymentError && error.code === 'deployment_command_failed',
  );
});

test('deployPython fails when health check fails in port mode', async () => {
  const harness = createHarness({ healthResult: false });
  const spec = deploymentSpec({
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'app:app',
      workers: 2,
      requirementsFile: 'requirements.txt',
      documentRoot: '.',
      healthPath: '/health',
      healthTimeoutSeconds: 5,
      restartPolicy: 'always',
      mode: 'production',
      port: 8000,
    },
  });

  await assert.rejects(
    () => harness.manager.deployPython(spec),
    (error) => error instanceof PythonDeploymentError && error.code === 'application_health_failed',
  );
});

test('deployPython fails when service is not active in socket mode', async () => {
  const harness = createHarness({ activeState: 'inactive' });
  const spec = deploymentSpec();

  await assert.rejects(
    () => harness.manager.deployPython(spec),
    (error) => error instanceof PythonDeploymentError && error.code === 'application_health_failed',
  );
});

test('deployPython prunes old releases exceeding retention', async () => {
  const oldRelease1 = '11111111-1111-4111-8111-111111111111';
  const oldRelease2 = '22222222-2222-4222-8222-222222222222';
  const oldRelease3 = '33333333-3333-4333-8333-333333333333';
  const oldRelease4 = '44444444-4444-4444-8444-444444444444';

  const harness = createHarness({
    existingReleases: [oldRelease1, oldRelease2, oldRelease3, oldRelease4],
  });
  const spec = deploymentSpec({ retention: 3 });

  await harness.manager.deployPython(spec);

  // Total releases = 4 existing + 1 new = 5. Retention = 3. Excess = 2.
  assert.equal(harness.removals.length, 2);
});
