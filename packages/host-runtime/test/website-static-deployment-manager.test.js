import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationIdentity } from '../src/application-identity.js';
import {
  createWebsiteStaticDeploymentManager,
  WebsiteStaticDeploymentError,
} from '../src/website-static-deployment-manager.js';

const APP_A = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const APP_B = '7c98cf5c-4aac-4db0-9858-0b3316bc3a7a';
const DEPLOY_A = 'ff830043-9752-4640-83b4-3a1998de78a0';
const DEPLOY_B = '3d44cc12-173e-47fc-9568-2817e0e58cda';
const GETENT = '/usr/bin/getent';
const USERADD = '/usr/sbin/useradd';
const RUNUSER = '/usr/sbin/runuser';

function spec(applicationId = APP_A, deploymentId = DEPLOY_A) {
  return {
    applicationId,
    deploymentId,
    repositoryUrl: 'https://github.com/example/static-app',
    branch: 'main',
    build: {
      mode: 'none',
      outputDir: '.',
      healthFile: 'index.html',
    },
    retention: 5,
  };
}

function canonicalIdentity(applicationId) {
  return createApplicationIdentity(applicationId);
}

function canonicalGetentRun({ wrongHomeFor = null } = {}) {
  return async (file, args, options = {}) => {
    if (file === GETENT && args[0] === 'passwd') {
      const identity = [APP_A, APP_B]
        .map(canonicalIdentity)
        .find((candidate) => candidate.unixUser === args[1]);
      assert.ok(identity);
      const home = identity.applicationId === wrongHomeFor
        ? `/var/lib/yunpanel/build/${identity.applicationId}`
        : identity.paths.workspace.homeDirectory;
      return { stdout: `${identity.unixUser}:x:2101:2101::${home}:/usr/sbin/nologin\n`, stderr: '' };
    }
    if (file === GETENT && args[0] === 'group') {
      return { stdout: `${args[1]}:x:2101:\n`, stderr: '' };
    }
    if (file === RUNUSER) return { stdout: options.env?.HOME ?? '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

test('website static deploy fails closed before creating a deployment manager when the provisioned user is missing', async () => {
  let deploymentManagerCreates = 0;
  const manager = createWebsiteStaticDeploymentManager({
    run: async (file, args) => {
      if (file === GETENT && args[0] === 'passwd') throw Object.assign(new Error('missing'), { code: 2 });
      return { stdout: '', stderr: '' };
    },
    createDeploymentManager: () => {
      deploymentManagerCreates += 1;
      return { deployStatic: async () => ({}) };
    },
  });

  await assert.rejects(
    manager.deployStatic(spec()),
    (error) => error instanceof WebsiteStaticDeploymentError && error.code === 'website_static_identity_missing',
  );
  assert.equal(deploymentManagerCreates, 0);
});

test('website static deploy rejects legacy build-root HOME drift before host deployment starts', async () => {
  let deploymentManagerCreates = 0;
  const manager = createWebsiteStaticDeploymentManager({
    run: canonicalGetentRun({ wrongHomeFor: APP_A }),
    createDeploymentManager: () => {
      deploymentManagerCreates += 1;
      return { deployStatic: async () => ({}) };
    },
  });

  await assert.rejects(
    manager.deployStatic(spec()),
    (error) => error instanceof WebsiteStaticDeploymentError && error.code === 'website_static_identity_drift',
  );
  assert.equal(deploymentManagerCreates, 0);
});

test('website static deploy forces runuser HOME to the canonical persistent data root', async () => {
  const identity = canonicalIdentity(APP_A);
  const manager = createWebsiteStaticDeploymentManager({
    run: canonicalGetentRun(),
    createDeploymentManager: ({ run }) => ({
      deployStatic: async (deploymentSpec) => {
        const result = await run(RUNUSER, ['-u', identity.unixUser, '--', '/bin/true'], {
          env: { HOME: '/legacy/build/home', PATH: '/usr/bin:/bin' },
        });
        return { releaseId: deploymentSpec.deploymentId, observedHome: result.stdout };
      },
    }),
  });

  const result = await manager.deployStatic(spec());
  assert.equal(result.releaseId, DEPLOY_A);
  assert.equal(result.observedHome, identity.paths.workspace.homeDirectory);
});

test('website static deployment engine cannot create Unix identities outside provisioning', async () => {
  const manager = createWebsiteStaticDeploymentManager({
    run: canonicalGetentRun(),
    createDeploymentManager: ({ run }) => ({
      deployStatic: async () => run(USERADD, ['yunapp-forbidden']),
    }),
  });

  await assert.rejects(
    manager.deployStatic(spec()),
    (error) => error instanceof WebsiteStaticDeploymentError
      && error.code === 'website_static_identity_create_forbidden',
  );
});

test('parallel website static deploys keep canonical HOME isolated per application', async () => {
  const manager = createWebsiteStaticDeploymentManager({
    run: canonicalGetentRun(),
    createDeploymentManager: ({ run }) => ({
      deployStatic: async (deploymentSpec) => {
        await new Promise((resolve) => setImmediate(resolve));
        const result = await run(RUNUSER, ['-u', deploymentSpec.applicationId, '--', '/bin/true']);
        return { applicationId: deploymentSpec.applicationId, observedHome: result.stdout };
      },
    }),
  });

  const [first, second] = await Promise.all([
    manager.deployStatic(spec(APP_A, DEPLOY_A)),
    manager.deployStatic(spec(APP_B, DEPLOY_B)),
  ]);

  assert.equal(first.observedHome, canonicalIdentity(APP_A).paths.workspace.homeDirectory);
  assert.equal(second.observedHome, canonicalIdentity(APP_B).paths.workspace.homeDirectory);
  assert.notEqual(first.observedHome, second.observedHome);
});
