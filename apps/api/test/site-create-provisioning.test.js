import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';

function nodePreview({ metadataReady = false, httpsMode = 'managed' } = {}) {
  return {
    operationId,
    complete: metadataReady,
    ids: { websiteId, applicationId, primaryDomainId: domainId, wwwDomainId: null },
    steps: {
      applicationReady: metadataReady,
      websiteReady: metadataReady,
      primaryDomainReady: metadataReady,
      wwwDomainReady: null,
    },
    plan: {
      application: { id: applicationId, type: 'node' },
      dockerWorkload: null,
      website: {
        id: websiteId,
        runtimeType: 'node',
        unixUser: 'yunapp-0123456789ab',
        documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
      },
      primaryDomain: {
        id: domainId,
        primaryDomain: 'example.com',
        targetType: 'proxy',
        httpsMode,
      },
      wwwDomain: null,
    },
  };
}

test('legacy metadata completeness never makes a new hosted Website provisioning-ready', () => {
  const plan = siteCreateProvisioningPlan(nodePreview({ metadataReady: true }));

  assert.equal(plan.ready, false);
  assert.equal(plan.status, 'partial');
  assert.equal(plan.steps.find((step) => step.id === 'website_metadata').state, 'succeeded');
  const identity = plan.steps.find((step) => step.id === 'unix_identity');
  assert.equal(identity.state, 'pending');
  assert.equal(identity.intent.unixUser, 'yunapp-0123456789ab');
  assert.equal(identity.intent.homeDirectory, `/var/lib/yunpanel/data/${applicationId}`);
  assert.equal(plan.steps.find((step) => step.id === 'runtime').intent.adapter, 'passenger');
  assert.equal(plan.steps.find((step) => step.id === 'nginx').state, 'pending');
  assert.equal(plan.steps.find((step) => step.id === 'certificate').state, 'pending');
});

test('static Website uses the static runtime adapter and HTTP-only plan omits certificate work', () => {
  const preview = nodePreview({ metadataReady: false, httpsMode: 'off' });
  preview.plan.application.type = 'static';
  preview.plan.website.runtimeType = 'static';

  const plan = siteCreateProvisioningPlan(preview);
  assert.equal(plan.steps.find((step) => step.id === 'runtime').intent.adapter, 'static');
  assert.equal(plan.steps.some((step) => step.id === 'certificate'), false);
});

test('external proxy provisioning requires Nginx without inventing a site Unix identity', () => {
  const preview = nodePreview({ metadataReady: true, httpsMode: 'off' });
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
