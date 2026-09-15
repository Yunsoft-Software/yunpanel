import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const primaryDomainId = 'b97cb625-ff73-4d98-b105-f435445b78ce';
const unixUser = 'yunapp-4dc352e64a14';
const documentRoot = `/var/lib/yunpanel/apps/${applicationId}/current/public`;

function phpPreview(overrides = {}) {
  return {
    operationId,
    ids: {
      websiteId,
      applicationId,
      primaryDomainId,
      wwwDomainId: null,
    },
    source: { kind: 'existing_application', applicationId },
    steps: {
      applicationReady: true,
      websiteReady: true,
      primaryDomainReady: true,
      wwwDomainReady: null,
    },
    plan: {
      application: {
        id: applicationId,
        serverId: 'a6dad2a5-4110-4f1c-885c-f03a1cc11e03',
        name: 'PHP Website',
        type: 'php',
        repositoryUrl: null,
        branch: null,
        retention: 2,
        build: null,
        runtime: null,
        runtimeAdapter: null,
        webRoot: documentRoot,
      },
      website: {
        id: websiteId,
        serverId: 'a6dad2a5-4110-4f1c-885c-f03a1cc11e03',
        name: 'PHP Website',
        applicationId,
        dockerWorkloadId: null,
        runtimeType: 'php',
        documentRoot,
        unixUser,
        proxyTarget: null,
        revision: 1,
      },
      primaryDomain: {
        id: primaryDomainId,
        serverId: 'a6dad2a5-4110-4f1c-885c-f03a1cc11e03',
        websiteId,
        primaryDomain: 'example.com',
        parentDomainId: null,
        aliases: ['www.example.com'],
        targetType: 'php',
        target: { applicationId },
        httpsMode: 'off',
      },
      wwwDomain: null,
    },
    ...overrides,
  };
}

test('PHP Website provisioning orders identity, PHP-FPM and Nginx with no raw socket intent', () => {
  const plan = siteCreateProvisioningPlan(phpPreview());
  const ids = plan.steps.map((step) => step.id);

  assert.deepEqual(ids, [
    'application_metadata',
    'website_metadata',
    'primary_domain_metadata',
    'unix_identity',
    'php_runtime',
    'nginx',
    'domain_activation',
  ]);

  const identity = plan.steps.find((step) => step.id === 'unix_identity');
  assert.equal(identity.intent.unixUser, unixUser);
  assert.equal(identity.intent.homeDirectory, `/var/lib/yunpanel/data/${applicationId}`);

  const runtime = plan.steps.find((step) => step.id === 'php_runtime');
  assert.equal(runtime.kind, 'php_runtime');
  assert.deepEqual(runtime.intent, {
    adapter: 'php-fpm',
    websiteId,
    applicationId,
    unixUser,
    documentRoot,
  });
  assert.equal(runtime.compensation.state, 'pending');

  const nginx = plan.steps.find((step) => step.id === 'nginx');
  assert.equal(nginx.intent.targetType, 'php');
  assert.equal(nginx.intent.target.adapter, 'php-fpm');
  assert.equal(Object.hasOwn(nginx.intent.target, 'socketPath'), false);
});

test('PHP Website provisioning rejects document roots outside canonical current release', () => {
  const preview = phpPreview();
  preview.plan.application.webRoot = '/var/www/foreign';
  preview.plan.website.documentRoot = '/var/www/foreign';

  assert.throws(
    () => siteCreateProvisioningPlan(preview),
    /outside the managed current release/,
  );
});

test('PHP Website provisioning rejects Unix identity drift', () => {
  const preview = phpPreview();
  preview.plan.website.unixUser = 'yunapp-aaaaaaaaaaaa';

  assert.throws(
    () => siteCreateProvisioningPlan(preview),
    /Unix user does not match/,
  );
});
