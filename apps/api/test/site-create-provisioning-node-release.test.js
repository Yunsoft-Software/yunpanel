import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const unixUser = 'yunapp-4dc352e64a14';

function preview() {
  return {
    operationId,
    source: {
      kind: 'new_node',
      repositoryUrl: 'https://github.com/example/node-app.git',
      branch: 'main',
      retention: 5,
    },
    ids: { websiteId, applicationId, primaryDomainId: domainId, wwwDomainId: null },
    steps: {
      applicationReady: true,
      websiteReady: true,
      primaryDomainReady: true,
      wwwDomainReady: null,
    },
    plan: {
      application: {
        id: applicationId,
        type: 'node',
        runtime: {
          nodeMajor: 24,
          packageManager: 'npm',
          installMode: 'ci',
          buildScript: 'build',
          mode: 'production',
          documentRoot: '.',
          start: { mode: 'node', entryFile: 'dist/server.js', script: null },
          port: 3100,
          healthPath: '/health',
          healthTimeoutSeconds: 30,
          restartPolicy: 'on-failure',
        },
      },
      website: {
        id: websiteId,
        runtimeType: 'node',
        unixUser,
        documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
      },
      primaryDomain: {
        id: domainId,
        primaryDomain: 'example.com',
        aliases: [],
        targetType: 'proxy',
        target: { upstreamHost: '127.0.0.1', upstreamPort: 3100, websocket: true },
        httpsMode: 'off',
      },
      wwwDomain: null,
    },
  };
}

test('new Node provisioning prepares a portless release before Passenger inspection and Nginx', () => {
  const plan = siteCreateProvisioningPlan(preview());
  const ids = plan.steps.map((step) => step.id);
  const releaseIndex = ids.indexOf('node_release');
  const runtimeIndex = ids.indexOf('runtime');
  const nginxIndex = ids.indexOf('nginx');

  assert.ok(releaseIndex > ids.indexOf('unix_identity'));
  assert.ok(runtimeIndex > releaseIndex);
  assert.ok(nginxIndex > runtimeIndex);

  const release = plan.steps[releaseIndex];
  assert.equal(release.kind, 'node_release');
  assert.equal(release.intent.adapter, 'passenger-release');
  assert.equal(release.intent.applicationId, applicationId);
  assert.equal(release.intent.deploymentId, operationId);
  assert.equal(release.intent.repositoryUrl, 'https://github.com/example/node-app.git');
  assert.equal(release.intent.runtime.port, undefined);
  assert.equal(release.intent.runtime.start.entryFile, 'dist/server.js');
  assert.equal(release.intent.currentRelease, `/var/lib/yunpanel/apps/${applicationId}/current`);
  assert.equal(release.compensation.state, 'pending');

  const runtime = plan.steps[runtimeIndex];
  assert.equal(runtime.intent.adapter, 'passenger');
  assert.equal(runtime.intent.appRoot, `/var/lib/yunpanel/apps/${applicationId}/current`);
  assert.equal(runtime.intent.startupFile, 'dist/server.js');
});

test('existing Node bindings do not invent a new release deployment', () => {
  const value = preview();
  value.source = { kind: 'existing_application', applicationId };
  const plan = siteCreateProvisioningPlan(value);

  assert.equal(plan.steps.some((step) => step.id === 'node_release'), false);
  assert.equal(plan.steps.find((step) => step.id === 'runtime').intent.adapter, 'passenger');
});
