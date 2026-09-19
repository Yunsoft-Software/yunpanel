import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-mail-provisioning.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const unixUser = 'yunapp-4dc352e64a14';

function preview({ mailMode = 'local', mailReady = true } = {}) {
  const mailDomain = mailMode === 'none' ? null : {
    id: mailDomainId,
    domainName: 'example.com',
    webDomainId: domainId,
    managementMode: mailMode,
    initialStatus: mailMode === 'local' ? 'disabled' : 'unverified',
    desiredStatus: mailMode === 'local' ? 'enabled' : null,
  };
  return {
    operationId,
    complete: false,
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/example/static-app.git',
      branch: 'main',
      build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
      retention: 5,
    },
    ids: {
      websiteId,
      applicationId,
      primaryDomainId: domainId,
      wwwDomainId: null,
      mailDomainId: mailDomain?.id ?? null,
    },
    steps: {
      applicationReady: true,
      websiteReady: true,
      primaryDomainReady: true,
      wwwDomainReady: null,
      mailDomainReady: mailDomain ? mailReady : null,
    },
    plan: {
      application: {
        id: applicationId,
        serverId,
        type: 'static',
        repositoryUrl: 'https://github.com/example/static-app.git',
        branch: 'main',
        retention: 5,
        build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
        runtime: null,
        webRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
      },
      dockerWorkload: null,
      website: {
        id: websiteId,
        serverId,
        applicationId,
        runtimeType: 'static',
        unixUser,
        documentRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
      },
      primaryDomain: {
        id: domainId,
        serverId,
        websiteId,
        primaryDomain: 'example.com',
        parentDomainId: null,
        aliases: [],
        targetType: 'static',
        target: { root: `/var/www/yunpanel/apps/${applicationId}/current`, spaFallback: true },
        httpsMode: mailMode === 'local' ? 'managed' : 'off',
      },
      wwwDomain: null,
      mailDomain,
      webmail: mailMode === 'local'
        ? { hostname: 'webmail.example.com', sharedRoundcube: true, certificateCoverageRequired: true }
        : null,
    },
  };
}

test('local mail config, DKIM key, and signing config become required after certificate issuance', () => {
  const plan = siteCreateProvisioningPlan(preview());
  const metadata = plan.steps.find((step) => step.id === 'mail_domain_metadata');
  const config = plan.steps.find((step) => step.id === 'mail_config');
  const dkim = plan.steps.find((step) => step.id === 'mail_dkim_key');
  const dkimConfig = plan.steps.find((step) => step.id === 'mail_dkim_config');

  assert.equal(metadata.state, 'succeeded');
  assert.equal(metadata.compensation.state, 'not_required');
  assert.deepEqual(metadata.intent, {
    adapter: 'mail-domain-metadata',
    mailDomainId,
    webDomainId: domainId,
    domainName: 'example.com',
    managementMode: 'local',
  });

  assert.equal(config.kind, 'mail_config');
  assert.equal(config.required, true);
  assert.equal(config.state, 'pending');
  assert.equal(config.compensation.state, 'pending');
  assert.deepEqual(config.intent, {
    adapter: 'managed-mail-config',
    serverId,
    websiteId,
    webDomainId: domainId,
    mailDomainId,
    expectedRevision: 1,
    initialStatus: 'disabled',
    desiredStatus: 'enabled',
  });

  assert.equal(dkim.kind, 'mail_dkim_key');
  assert.equal(dkim.required, true);
  assert.equal(dkim.state, 'pending');
  assert.equal(dkim.compensation.state, 'not_required');
  assert.deepEqual(dkim.intent, {
    adapter: 'managed-mail-dkim-key',
    serverId,
    websiteId,
    webDomainId: domainId,
    mailDomainId,
    domainName: 'example.com',
    expectedMailDomainRevision: 2,
    expectedMailDomainStatus: 'enabled',
    expectedKeyRevision: 0,
    selector: 'yp-9ae512c0a7174611943c6ce2',
  });

  assert.equal(dkimConfig.kind, 'mail_dkim_config');
  assert.equal(dkimConfig.required, true);
  assert.equal(dkimConfig.state, 'pending');
  assert.equal(dkimConfig.compensation.state, 'pending');
  assert.deepEqual(dkimConfig.intent, {
    adapter: 'managed-mail-dkim-config',
    serverId,
    websiteId,
    webDomainId: domainId,
    mailDomainId,
    domainName: 'example.com',
    expectedMailDomainRevision: 2,
    expectedMailDomainStatus: 'enabled',
    expectedKeyRevision: 1,
    selector: 'yp-9ae512c0a7174611943c6ce2',
  });

  const order = plan.steps.map((step) => step.id);
  assert.ok(order.indexOf('certificate') >= 0);
  assert.ok(order.indexOf('certificate') < order.indexOf('mail_config'));
  assert.ok(order.indexOf('mail_config') < order.indexOf('mail_dkim_key'));
  assert.ok(order.indexOf('mail_dkim_key') < order.indexOf('mail_dkim_config'));
  assert.equal(plan.ready, false);
});

test('pre-create local mail preview keeps metadata pending without changing immutable intent', () => {
  const before = siteCreateProvisioningPlan(preview({ mailReady: false }));
  const after = siteCreateProvisioningPlan(preview({ mailReady: true }));

  assert.equal(before.steps.find((step) => step.id === 'mail_domain_metadata').state, 'pending');
  assert.equal(after.steps.find((step) => step.id === 'mail_domain_metadata').state, 'succeeded');
  assert.deepEqual(
    before.steps.find((step) => step.id === 'mail_domain_metadata').intent,
    after.steps.find((step) => step.id === 'mail_domain_metadata').intent,
  );
  assert.deepEqual(
    before.steps.find((step) => step.id === 'mail_config').intent,
    after.steps.find((step) => step.id === 'mail_config').intent,
  );
  assert.deepEqual(
    before.steps.find((step) => step.id === 'mail_dkim_key').intent,
    after.steps.find((step) => step.id === 'mail_dkim_key').intent,
  );
  assert.deepEqual(
    before.steps.find((step) => step.id === 'mail_dkim_config').intent,
    after.steps.find((step) => step.id === 'mail_dkim_config').intent,
  );
});

test('external mail tracks metadata but never invokes the local mail stack', () => {
  const plan = siteCreateProvisioningPlan(preview({ mailMode: 'external' }));
  const metadata = plan.steps.find((step) => step.id === 'mail_domain_metadata');

  assert.equal(metadata.intent.managementMode, 'external');
  assert.equal(plan.steps.some((step) => step.id === 'mail_config'), false);
  assert.equal(plan.steps.some((step) => step.id === 'mail_dkim_key'), false);
  assert.equal(plan.steps.some((step) => step.id === 'mail_dkim_config'), false);
  assert.equal(plan.steps.some((step) => step.id === 'certificate'), false);
});

test('mail none preserves the existing Website provisioning step set', () => {
  const plan = siteCreateProvisioningPlan(preview({ mailMode: 'none' }));
  assert.equal(plan.steps.some((step) => step.id === 'mail_domain_metadata'), false);
  assert.equal(plan.steps.some((step) => step.id === 'mail_config'), false);
  assert.equal(plan.steps.some((step) => step.id === 'mail_dkim_key'), false);
  assert.equal(plan.steps.some((step) => step.id === 'mail_dkim_config'), false);
});
