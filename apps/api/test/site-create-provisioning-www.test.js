import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning-isolation.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const primaryDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const wwwDomainId = 'c20e9df0-6d02-40bf-a876-dc783ee34c7a';

function stalePreview() {
  return {
    operationId,
    source: { kind: 'existing_application', applicationId },
    ids: { websiteId, applicationId, primaryDomainId, wwwDomainId },
    steps: {
      applicationReady: true,
      websiteReady: true,
      primaryDomainReady: true,
      wwwDomainReady: true,
    },
    plan: {
      application: {
        id: applicationId,
        type: 'node',
        runtimeAdapter: 'passenger',
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
        applicationId,
        runtimeType: 'node',
        unixUser: 'yunapp-4dc352e64a14',
        documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
      },
      primaryDomain: {
        id: primaryDomainId,
        primaryDomain: 'example.com',
        aliases: ['alias.example.com'],
        targetType: 'passenger',
        target: { applicationId },
        httpsMode: 'managed',
      },
      wwwDomain: {
        id: wwwDomainId,
        websiteId,
        primaryDomain: 'www.example.com',
        parentDomainId: primaryDomainId,
        aliases: [],
        targetType: 'passenger',
        target: { applicationId },
        httpsMode: 'managed',
      },
    },
  };
}

test('stale independent www metadata cannot be provisioned on the parent Website identity', () => {
  assert.throws(
    () => siteCreateProvisioningPlan(stalePreview()),
    /Independent www provisioning requires a dedicated Website operation/,
  );
});
