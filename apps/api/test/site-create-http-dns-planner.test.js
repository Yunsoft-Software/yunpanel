import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan as dnsAwareSiteCreateProvisioningPlan } from '../src/site-create-dns-provisioning.js';
import { siteCreateHttpInternals } from '../src/site-create-http.js';
import { siteCreateProvisioningPlan as isolatedSiteCreateProvisioningPlan } from '../src/site-create-provisioning-isolation.js';

test('site-create HTTP uses the DNS-aware provisioning planner on the local panel host', () => {
  assert.equal(
    siteCreateHttpInternals.provisioningPlanner({ localServerId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7' }),
    dnsAwareSiteCreateProvisioningPlan,
  );
});

test('site-create HTTP keeps the isolation-only planner when no local host scope is configured', () => {
  assert.equal(
    siteCreateHttpInternals.provisioningPlanner({ localServerId: null }),
    isolatedSiteCreateProvisioningPlan,
  );
});
