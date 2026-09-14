import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const unixUser = 'yunapp-4dc352e64a14';

function nodePreview({ metadataReady = false, httpsMode = 'managed' } = {}) {
  return {
    operationId,
    complete: metadataReady,
    source: {
      kind: 'new_node',
      repositoryUrl: 'https://github.com/example/node-app.git',
      branch: 'main',
      retention: 5,
    },
    ids: { websiteId, applicationId, primaryDomainId: domainId, wwwDomainId: null },
    steps: {
      applicationReady: metadataReady,
      websiteReady: metadataReady,
      primaryDomainReady: metadataReady,
      wwwDomainReady: null,
    },
    plan: {
      application: {
        id: applicationId,
        type: 'node',
        runtime: {
          nodeMajor: 24,
          mode: 'production',
          documentRoot: '.',
          start: { mode: 'node', entryFile: 'server.js', script: null },
          healthPath: '/health',
          healthTimeoutSeconds: 30,
        },
      },
      dockerWorkload: null,
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
        httpsMode,
      },
      wwwDomain: null,
    },
  };
}

function staticPreview({ existing = false } = {}) {
  const preview = nodePreview({ metadataReady: false, httpsMode: 'off' });
  preview.source = existing
    ? { kind: 'existing_application', applicationId }
    : {
        kind: 'new_static',
        repositoryUrl: 'https://github.com/example/static-app.git',
        branch: 'main',
        build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
        retention: 5,
      };
  preview.plan.application = {
    id: applicationId,
    type: 'static',
    repositoryUrl: 'https://github.com/example/static-app.git',
    branch: 'main',
    retention: 5,
    build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
    runtime: null,
    webRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
  };
  preview.plan.website.runtimeType = 'static';
  preview.plan.website.documentRoot = `/var/www/yunpanel/apps/${applicationId}/current`;
  return preview;
}

test('legacy metadata completeness never makes a new hosted Website provisioning-ready', () => {
  const plan = siteCreateProvisioningPlan(nodePreview({ metadataReady: true }));

  assert.equal(plan.ready, false);
  assert.equal(plan.status, 'partial');
  assert.equal(plan.steps.find((step) => step.id === 'website_metadata').state, 'succeeded');
  const identity = plan.steps.find((step) => step.id === 'unix_identity');
  assert.equal(identity.state, 'pending');
  assert.equal(identity.compensation.state, 'pending');
  assert.equal(identity.intent.unixUser, unixUser);
  assert.equal(identity.intent.homeDirectory, `/var/lib/yunpanel/data/${applicationId}`);

  const runtime = plan.steps.find((step) => step.id === 'runtime');
  assert.equal(runtime.kind, 'runtime');
  assert.equal(runtime.intent.adapter, 'passenger');
  assert.equal(runtime.intent.nodeMajor, 24);
  assert.deepEqual(runtime.intent.nodeCandidates, [
    '/opt/yunpanel/node-runtimes/v24/bin/node',
    '/usr/bin/node',
  ]);
  assert.equal(runtime.intent.appRoot, `/var/lib/yunpanel/apps/${applicationId}/current`);
  assert.equal(runtime.intent.startupFile, 'server.js');
  assert.equal(runtime.state, 'pending');
  assert.equal(runtime.compensation.state, 'not_required');

  const nginx = plan.steps.find((step) => step.id === 'nginx');
  assert.equal(nginx.intent.targetType, 'passenger');
  assert.equal(nginx.intent.target.startupFile, 'server.js');
  assert.equal(nginx.state, 'pending');
  assert.equal(nginx.compensation.state, 'pending');
  assert.equal(plan.steps.find((step) => step.id === 'certificate').state, 'pending');
});

test('Node provisioning rejects document-root drift from the managed Website path contract', () => {
  const preview = nodePreview({ httpsMode: 'off' });
  preview.plan.website.documentRoot = '/srv/example/current';

  assert.throws(
    () => siteCreateProvisioningPlan(preview),
    /document root does not match the managed Website path contract/,
  );
});

test('hosted Website provisioning rejects Unix-user drift before creating host steps', () => {
  const preview = nodePreview({ httpsMode: 'off' });
  preview.plan.website.unixUser = 'yunapp-0123456789ab';

  assert.throws(
    () => siteCreateProvisioningPlan(preview),
    /Website Unix user does not match the managed Application identity/,
  );
});

test('npm-script Node start is an explicit Passenger blocker instead of an invented command', () => {
  const preview = nodePreview({ httpsMode: 'off' });
  preview.plan.application.runtime.start = { mode: 'npm', entryFile: null, script: 'start' };

  const plan = siteCreateProvisioningPlan(preview);
  const runtime = plan.steps.find((step) => step.id === 'runtime');
  assert.equal(runtime.state, 'blocked');
  assert.equal(runtime.error, 'passenger_start_mode_unsupported');
  assert.equal(runtime.intent.blocker, 'passenger_start_mode_unsupported');
  assert.equal(runtime.compensation.state, 'not_required');
  assert.equal(plan.status, 'blocked');
});

test('new static Website persists deterministic deployment intent with canonical paths', () => {
  const plan = siteCreateProvisioningPlan(staticPreview());
  const identity = plan.steps.find((step) => step.id === 'unix_identity');
  assert.equal(identity.intent.homeDirectory, `/var/lib/yunpanel/data/${applicationId}`);

  const runtime = plan.steps.find((step) => step.id === 'runtime');
  assert.equal(runtime.kind, 'static_runtime');
  assert.equal(runtime.intent.adapter, 'static');
  assert.equal(runtime.intent.mode, 'deploy');
  assert.equal(runtime.intent.deploymentId, operationId);
  assert.equal(runtime.intent.homeDirectory, `/var/lib/yunpanel/data/${applicationId}`);
  assert.equal(runtime.intent.buildRoot, `/var/lib/yunpanel/build/${applicationId}`);
  assert.equal(runtime.intent.publishRoot, `/var/www/yunpanel/apps/${applicationId}`);
  assert.equal(runtime.intent.repositoryUrl, 'https://github.com/example/static-app.git');
  assert.equal(runtime.intent.branch, 'main');
  assert.equal(runtime.intent.retention, 5);
  assert.equal(runtime.intent.build.outputDir, '.');
  assert.equal(runtime.compensation.state, 'pending');
  assert.equal(plan.steps.some((step) => step.id === 'certificate'), false);
});

test('existing static Application binding inspects current release instead of inventing a redeploy', () => {
  const plan = siteCreateProvisioningPlan(staticPreview({ existing: true }));
  const runtime = plan.steps.find((step) => step.id === 'runtime');

  assert.equal(runtime.kind, 'static_runtime');
  assert.equal(runtime.intent.adapter, 'static');
  assert.equal(runtime.intent.mode, 'bind_existing');
  assert.equal(runtime.compensation.state, 'not_required');
  assert.equal(Object.hasOwn(runtime.intent, 'deploymentId'), false);
  assert.equal(Object.hasOwn(runtime.intent, 'repositoryUrl'), false);
});

test('static Website provisioning rejects publish-root drift from the managed Website path contract', () => {
  const preview = staticPreview();
  preview.plan.website.documentRoot = '/srv/static/current';

  assert.throws(
    () => siteCreateProvisioningPlan(preview),
    /Static Website document root does not match the managed Website path contract/,
  );
});

test('external proxy provisioning requires Nginx without inventing a site Unix identity', () => {
  const preview = nodePreview({ metadataReady: true, httpsMode: 'off' });
  preview.source = { kind: 'external_proxy', target: { host: '127.0.0.1', port: 8080, websocket: true } };
  preview.plan.application = null;
  preview.plan.website.runtimeType = 'proxy';
  preview.plan.website.unixUser = null;
  preview.plan.website.documentRoot = null;
  preview.steps.applicationReady = true;

  const plan = siteCreateProvisioningPlan(preview);
  assert.equal(plan.steps.some((step) => step.id === 'unix_identity'), false);
  assert.equal(plan.steps.some((step) => step.id === 'runtime'), false);
  assert.equal(plan.steps.find((step) => step.id === 'nginx').state, 'pending');
  assert.equal(plan.ready, false);
});
