import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const unixUser = 'yunapp-4dc352e64a14';
const documentRoot = `/var/lib/yunpanel/apps/${applicationId}/current/public`;

function phpPreview({ metadataReady = false } = {}) {
  return {
    operationId,
    complete: metadataReady,
    source: { kind: 'new_php' },
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
        type: 'php',
        repositoryUrl: null,
        branch: null,
        retention: 2,
        build: null,
        runtime: null,
        runtimeAdapter: null,
        webRoot: documentRoot,
      },
      dockerWorkload: null,
      website: {
        id: websiteId,
        applicationId,
        runtimeType: 'php',
        unixUser,
        documentRoot,
      },
      primaryDomain: {
        id: domainId,
        primaryDomain: 'php.example.com',
        aliases: ['www.php.example.com'],
        targetType: 'php',
        target: { applicationId },
        httpsMode: 'off',
      },
      wwwDomain: null,
    },
  };
}

test('PHP Website provisioning orders identity, bootstrap, FPM and Nginx before Domain activation', () => {
  const plan = siteCreateProvisioningPlan(phpPreview({ metadataReady: true }));
  const ids = plan.steps.map((step) => step.id);

  assert.equal(plan.ready, false);
  assert.equal(plan.status, 'partial');
  assert.ok(ids.indexOf('unix_identity') < ids.indexOf('php_bootstrap'));
  assert.ok(ids.indexOf('php_bootstrap') < ids.indexOf('php_runtime'));
  assert.ok(ids.indexOf('php_runtime') < ids.indexOf('nginx'));
  assert.ok(ids.indexOf('nginx') < ids.indexOf('domain_activation'));
  assert.equal(ids.includes('runtime'), false);
  assert.equal(ids.includes('node_release'), false);

  const identity = plan.steps.find((step) => step.id === 'unix_identity');
  assert.equal(identity.intent.unixUser, unixUser);
  assert.equal(identity.intent.homeDirectory, `/var/lib/yunpanel/data/${applicationId}`);

  const bootstrap = plan.steps.find((step) => step.id === 'php_bootstrap');
  assert.deepEqual(bootstrap.intent, {
    adapter: 'php-bootstrap',
    websiteId,
    applicationId,
    unixUser,
    documentRoot,
  });
  assert.equal(bootstrap.compensation.state, 'pending');

  const runtime = plan.steps.find((step) => step.id === 'php_runtime');
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
  assert.deepEqual(nginx.intent.target, runtime.intent);
});

test('PHP Website provisioning rejects document-root or Unix-user drift before host mutation', () => {
  const rootDrift = phpPreview();
  rootDrift.plan.website.documentRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
  assert.throws(
    () => siteCreateProvisioningPlan(rootDrift),
    /PHP Website bootstrap document root does not match the managed current\/public path/,
  );

  const userDrift = phpPreview();
  userDrift.plan.website.unixUser = 'yunapp-0123456789ab';
  assert.throws(
    () => siteCreateProvisioningPlan(userDrift),
    /Website Unix user does not match the managed Application identity/,
  );
});
