import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePythonReleaseManager, WebsitePythonReleaseError } from '../src/website-python-release-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const DEPLOYMENT_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const PREVIOUS_RELEASE = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

function releaseSpec(overrides = {}) {
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
    },
    retention: 5,
    ...overrides,
  };
}

function createHarness({ existingLink = null, isDirectory = true } = {}) {
  const commands = [];
  const links = [];
  const removals = [];
  const writes = [];
  const siteManagerCalls = [];

  const run = async (file, args, options = {}) => {
    commands.push({ file, args, options });
    if (file === '/usr/bin/git' && args.includes('rev-parse')) {
      return { stdout: 'b'.repeat(40) + '\n' };
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
  };

  const manager = createWebsitePythonReleaseManager({
    appRoot: '/apps',
    dataRoot: '/data',
    receiptRoot: '/staging',
    pythonSiteManager,
    run,
    mkdirFn: async () => {},
    lstatFn: async () => ({
      isDirectory: () => isDirectory,
      isFile: () => true,
    }),
    readlinkFn: async () => existingLink ?? `releases/${DEPLOYMENT_ID}`,
    readFileFn: async () => JSON.stringify({
      version: 1,
      applicationId: APPLICATION_ID,
      deploymentId: DEPLOYMENT_ID,
      state: 'prepared',
    }),
    renameFn: async () => {},
    rmFn: async (target, opts) => removals.push({ target, opts }),
    symlinkFn: async (target, linkPath) => links.push({ target, linkPath }),
    writeFileFn: async (target, content) => writes.push({ target, content }),
  });

  return { manager, commands, links, removals, writes, siteManagerCalls };
}

test('prepare stages Python release for website provisioning', async () => {
  const harness = createHarness();
  const spec = releaseSpec();
  const result = await harness.manager.prepare(spec);

  assert.equal(result.satisfied, true);
  assert.equal(result.applicationId, APPLICATION_ID);
  assert.equal(result.releaseId, DEPLOYMENT_ID);
  assert.equal(result.commit, 'b'.repeat(40));

  assert.ok(harness.siteManagerCalls.some((c) => c.method === 'ensureVirtualenv'));
  assert.ok(harness.siteManagerCalls.some((c) => c.method === 'installRequirements'));
  assert.ok(harness.links.some((l) => l.target === `releases/${DEPLOYMENT_ID}`));
  assert.ok(harness.writes.some((w) => w.target.includes(DEPLOYMENT_ID)));
});

test('inspectDeployment verifies prepared release', async () => {
  const harness = createHarness({ existingLink: `releases/${DEPLOYMENT_ID}` });
  const spec = releaseSpec();
  const result = await harness.manager.inspectDeployment(spec);

  assert.equal(result.satisfied, true);
  assert.equal(result.releaseId, DEPLOYMENT_ID);
});

test('compensate removes staged release and symlink when no previous release', async () => {
  const harness = createHarness();
  const target = {
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    previousReleaseId: null,
  };
  const result = await harness.manager.compensate(target);

  assert.equal(result.satisfied, true);
  assert.equal(result.compensated, true);
  assert.ok(harness.removals.some((r) => r.target.includes(DEPLOYMENT_ID)));
});

test('compensate restores previous release symlink when previous release exists', async () => {
  const harness = createHarness();
  const target = {
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    previousReleaseId: PREVIOUS_RELEASE,
  };
  const result = await harness.manager.compensate(target);

  assert.equal(result.satisfied, true);
  assert.equal(result.compensated, true);
  assert.ok(harness.links.some((l) => l.target === `releases/${PREVIOUS_RELEASE}`));
});
