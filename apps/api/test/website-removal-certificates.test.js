import test from 'node:test';
import assert from 'node:assert/strict';

import { previewResourceImpact } from '../src/resource-impact.js';
import { createWebsiteRemovalPreview } from '../src/website-removal-plan.js';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';

test('website with SSL certificate can generate removal preview and be cleanly removed (T801)', async () => {
  const serverId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222222';
  const domainId = '33333333-3333-4333-8333-333333333333';
  const certId = '44444444-4444-4444-8444-444444444444';

  const website = {
    id: websiteId,
    name: 'cert-site',
    serverId,
    applicationId: null,
    systemUser: 'yunapp-site1',
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
    state: 'active',
  };

  const domain = {
    id: domainId,
    name: 'site-with-cert.test',
    primaryDomain: 'site-with-cert.test',
    serverId,
    websiteId,
    certificateId: certId,
    parentDomainId: null,
    desiredRevision: 1,
    state: 'active',
  };

  let certState = {
    id: certId,
    domainId,
    serverId,
    state: 'active',
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
    validTo: '2027-01-01T00:00:00.000Z',
    updatedAt: '2026-10-26T20:00:00.000Z',
    retirementOperationId: null,
    retiredAt: null,
    retiredFromState: null,
  };

  const registry = {
    async getServer(id) {
      if (id === serverId) return { id: serverId, name: 'Local Server' };
      return null;
    },
  };

  let websitePresent = true;
  const websiteRegistry = {
    async getWebsite(id) {
      if (websitePresent && id === websiteId) return { ...website };
      return null;
    },
    async finalizeWebsiteRemoval(input) {
      assert.equal(input.websiteId, websiteId);
      websitePresent = false;
      return { websiteId: input.websiteId, finalized: true };
    },
  };

  let domainList = [{ ...domain }];
  const domainRegistry = {
    async getDomain(id) {
      return domainList.find((d) => d.id === id) ?? null;
    },
    async listDomains() {
      return [...domainList];
    },
  };

  const certificateRegistry = {
    async listCertificates() {
      return [{ ...certState }];
    },
    async getCertificate(id) {
      if (id === certId) return { ...certState };
      return null;
    },
    async retireForDomainRemoval(id, input) {
      assert.equal(id, certId);
      certState = {
        ...certState,
        state: 'retired',
        retirementOperationId: input.operationId,
        retiredAt: new Date().toISOString(),
      };
      return { changed: true, certificate: { ...certState } };
    },
  };

  const applicationRegistry = {
    async getApplication() { return null; },
  };

  const jobRegistry = {
    async listJobs() { return []; },
  };

  const dnsHostingRegistry = {
    async listZones() { return []; },
  };

  const mailDomainRegistry = {
    async listMailDomains() { return []; },
  };

  const additionalProviders = {
    databases: async () => [],
    sftpKeys: async () => [],
    runtimeBindings: async () => [],
    unixIdentities: async () => [{ id: website.systemUser, state: 'active' }],
    logScopes: async () => [{ id: website.id, state: 'managed' }],
    crons: async () => [],
    backups: async () => [],
    dockerWorkloads: async () => [],
    webmailMappings: async () => [],
    mailboxes: async () => [],
  };

  // 1. Calculate resource impact for deleting the website
  const impact = await previewResourceImpact({
    resourceType: 'website',
    resourceId: websiteId,
    operation: 'delete',
    targetServerId: null,
    registry,
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    additionalProviders,
  });

  // Verify impact detected the SSL certificate and emitted certificates_present blocker
  assert.equal(impact.dependencies.certificates.length, 1);
  assert.equal(impact.dependencies.certificates[0].id, certId);
  const blockerCodes = impact.blockers.map((b) => b.code);
  assert.ok(blockerCodes.includes('certificates_present'), 'certificates_present must be in impact blockers');

  // 2. Generate website removal preview
  const preview = createWebsiteRemovalPreview({
    website,
    impact,
    applicationState: null,
  });

  // T801 FIX VERIFICATION:
  // certificates_present must NOT be a hardBlocker; removal must be readyToStart
  assert.equal(preview.readyToStart, true, 'Removal preview must be readyToStart even when SSL certificate is present');
  assert.deepEqual(preview.hardBlockers, [], 'hardBlockers must be empty');
  assert.ok(typeof preview.confirmation === 'string' && preview.confirmation.startsWith(`start-website-remove:${websiteId}:`));

  // 3. Coordinate website removal execution with domain removal
  const opRegistry = createWebsiteRemovalOperationRegistry();
  await opRegistry.init();

  let domainRemoved = false;
  const domainRemovalRuntime = {
    async listForDomain(id) {
      if (domainRemoved) {
        return [{ id: 'dom-op-1', domainId: id, status: 'removed' }];
      }
      return [];
    },
    async preview({ domainId: id }) {
      assert.equal(id, domainId);
      return {
        readyToStart: true,
        previewDigest: 'a'.repeat(64),
        confirmation: `start-domain-remove:${id}:1:${'a'.repeat(64)}`,
      };
    },
    async start({ domainId: id }) {
      assert.equal(id, domainId);
      // Simulate domain removal retiring certificate and completing
      await certificateRegistry.retireForDomainRemoval(certId, { operationId: 'dom-op-1' });
      domainList = [];
      domainRemoved = true;
      return {
        id: 'dom-op-1',
        domainId: id,
        status: 'removed',
      };
    },
  };

  const runtime = createWebsiteRemovalRuntime({
    domainRegistry,
    registry: opRegistry,
    previewProvider: async () => preview,
    domainRemovalRuntime,
    websiteRegistry,
    applicationRegistry,
    fileCleanupInspector: async () => ({ ready: true }),
    fileCleanupHandler: async (input) => ({
      ...input,
      filesCleaned: true,
      retainedBackups: input.retainedBackups,
      retainedLogScopes: input.retainedLogScopes,
    }),
    unixIdentityCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupHandler: async (input) => ({
      ...input,
      unixIdentityCleaned: true,
    }),
    automaticExecution: false,
  });

  // Start removal
  let op = await runtime.start({
    websiteId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  // Step through remaining steps if any
  let iterations = 0;
  while (op && op.status !== 'removed') {
    iterations += 1;
    assert.ok(iterations < 20, `Removal loop exceeded max iterations; current op: ${JSON.stringify(op)}`);
    const nextStep = op.steps.find((s) => s.status !== 'succeeded');
    if (!nextStep) break;
    assert.notEqual(nextStep.status, 'failed', `Step ${nextStep.id} failed: ${JSON.stringify(nextStep.error)}`);
    assert.notEqual(nextStep.status, 'blocked', `Step ${nextStep.id} blocked: ${JSON.stringify(nextStep.error)}`);
    op = await runtime.continueStep({
      websiteId,
      operationId: op.id,
      stepId: nextStep.id,
      expectedUpdatedAt: op.updatedAt,
      confirmation: op.actions.stepContinuationConfirmation,
    });
  }

  assert.equal(op.status, 'removed', 'Website removal operation must complete with removed status');
  assert.equal(certState.state, 'retired', 'SSL certificate must be retired upon website removal');
});
