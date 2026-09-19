import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createDomainRemovalProductionRuntime,
} from '../src/domain-removal-production-runtime.js';
import {
  WebsiteCronImpactError,
} from '../src/website-cron-impact.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'domain-removal-prod-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('domain-removal-production-runtime includes crons in preview impact and fails closed on cron error', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'domain-removal-operations.json');
    const localServerId = 'srv-local';

    const checksum = 'a'.repeat(64);
    const testDomain = {
      id: 'dom-1',
      domainName: 'example.com',
      serverId: localServerId,
      primaryDomain: 'example.com',
      appliedPrimaryDomain: 'example.com',
      websiteId: 'ws-1',
      certificateId: null,
      parentDomainId: null,
      state: 'active',
      desiredRevision: 1,
      stagedRevision: 1,
      appliedRevision: 1,
      stagedChecksum: checksum,
      suspendedChecksum: null,
      suspensionOperationId: null,
    };

    const testWebsite = {
      id: 'ws-1',
      name: 'example-site',
      serverId: localServerId,
      state: 'active',
      suspended: false,
    };

    const registry = {
      getServer: async (id) => (id === localServerId ? { id: localServerId, name: 'Local Server' } : null),
      listServers: async () => [{ id: localServerId, name: 'Local Server' }],
    };

    const applicationRegistry = {
      getApplication: async (id) => (id === 'app-1' ? { id: 'app-1', name: 'App 1', serverId: localServerId } : null),
      listApplications: async () => [{ id: 'app-1', name: 'App 1', serverId: localServerId }],
    };

    const websiteRegistry = {
      getWebsite: async (id) => (id === testWebsite.id ? testWebsite : null),
      listWebsites: async () => [testWebsite],
    };

    const domainRegistry = {
      getDomain: async (id) => (id === testDomain.id ? testDomain : null),
      listDomains: async () => [testDomain],
      listByServer: async () => [testDomain],
      detachWebsiteForRemoval: async () => {},
      detachCertificateForRemoval: async () => {},
      finalizeDomainRemoval: async () => {},
    };

    const certificateRegistry = {
      listCertificates: async () => [],
      getCertificate: async () => null,
      retireForDomainRemoval: async () => {},
    };

    const jobRegistry = {
      listJobs: async () => [],
    };

    const dnsHostingRegistry = {
      listZones: async () => [],
      getZone: async () => null,
      deleteZone: async () => {},
    };

    const mailDomainRegistry = {
      listMailDomains: async () => [],
    };

    const mailboxRegistry = {
      listMailboxes: async () => [],
    };

    const dockerWorkloadRegistry = {
      getWorkload: async () => null,
    };

    const backupOperationRegistry = {
      listOperations: async () => [],
    };

    const databaseBindingRegistry = {
      listBindings: async () => [],
    };

    const roundcubeDomainMappingRegistry = {
      listActiveMappings: async () => [],
      listInFlight: async () => [],
      getRecordForMailDomain: async () => null,
    };

    const roundcubeDomainMappingService = {
      removeMapping: async () => {},
      previewDelete: async () => ({ isReady: true }),
      beginDelete: async () => ({ isReady: true }),
      inspect: async () => ({ isReady: true }),
      continueOperation: async () => ({ isReady: true }),
    };

    const domainSuspensionRuntime = {
      preview: async () => ({ isReady: true }),
      start: async () => {},
      retry: async () => {},
      retrySuspend: async () => {},
      list: async () => [],
      get: async () => null,
      listForDomain: async () => [],
    };

    const mailDomainRemovalRuntime = {
      preview: async () => ({ isReady: true }),
      start: async () => {},
      retry: async () => {},
      list: async () => [],
      listForMailDomain: async () => [],
    };

    // 1. Without websiteCronImpactProvider, crons bucket is unavailable
    const runtimeWithoutCron = createDomainRemovalProductionRuntime({
      filePath,
      registry,
      applicationRegistry,
      websiteRegistry,
      domainRegistry,
      certificateRegistry,
      jobRegistry,
      dnsHostingRegistry,
      mailDomainRegistry,
      mailboxRegistry,
      dockerWorkloadRegistry,
      backupOperationRegistry,
      databaseBindingRegistry,
      domainSuspensionRuntime,
      mailDomainRemovalRuntime,
      roundcubeDomainMappingRegistry,
      roundcubeDomainMappingService,
      localServerId,
    });

    const previewWithoutCron = await runtimeWithoutCron.preview({ domainId: testDomain.id });
    assert.ok(previewWithoutCron.previewDigest);

    // 2. With healthy websiteCronImpactProvider, preview includes cron impact and produces a different digest
    const healthyCronImpactProvider = async ({ websiteId }) => {
      if (websiteId === 'ws-1') {
        return [{ id: 'cron-task-1', state: 'enabled' }];
      }
      return [];
    };

    const runtimeWithCron = createDomainRemovalProductionRuntime({
      filePath: path.join(tempDir, 'domain-removal-operations-cron.json'),
      registry,
      applicationRegistry,
      websiteRegistry,
      domainRegistry,
      certificateRegistry,
      jobRegistry,
      dnsHostingRegistry,
      mailDomainRegistry,
      mailboxRegistry,
      dockerWorkloadRegistry,
      backupOperationRegistry,
      databaseBindingRegistry,
      domainSuspensionRuntime,
      mailDomainRemovalRuntime,
      roundcubeDomainMappingRegistry,
      roundcubeDomainMappingService,
      websiteCronImpactProvider: healthyCronImpactProvider,
      localServerId,
    });

    const previewWithCron = await runtimeWithCron.preview({ domainId: testDomain.id });
    assert.ok(previewWithCron.previewDigest);
    assert.notEqual(previewWithCron.previewDigest, previewWithoutCron.previewDigest);

    // 3. With failing/drifted websiteCronImpactProvider, preview fails closed
    const failingCronImpactProvider = async () => {
      throw new WebsiteCronImpactError(
        'website_cron_inventory_drift',
        'Cron task file has drifted from registry desired state',
        409,
      );
    };

    const runtimeWithFailingCron = createDomainRemovalProductionRuntime({
      filePath: path.join(tempDir, 'domain-removal-operations-fail.json'),
      registry,
      applicationRegistry,
      websiteRegistry,
      domainRegistry,
      certificateRegistry,
      jobRegistry,
      dnsHostingRegistry,
      mailDomainRegistry,
      mailboxRegistry,
      dockerWorkloadRegistry,
      backupOperationRegistry,
      databaseBindingRegistry,
      domainSuspensionRuntime,
      mailDomainRemovalRuntime,
      roundcubeDomainMappingRegistry,
      roundcubeDomainMappingService,
      websiteCronImpactProvider: failingCronImpactProvider,
      localServerId,
    });

    await assert.rejects(
      runtimeWithFailingCron.preview({ domainId: testDomain.id }),
      (err) => err.code === 'cron_impact_unavailable' && err.status === 503,
    );

    // 4. Wires database, sftpKey, runtimeBinding, unixIdentity, and logScope providers into preview impact
    const websiteSftpKeyRegistry = {
      listKeys: async (wsId) => (wsId === 'ws-1' ? [{ id: 'key-1', status: 'authorized' }] : []),
    };
    const runtimeBindingRegistry = {
      getBinding: async (appId) => (appId === 'app-1' ? { id: 'rb-1', state: 'active' } : null),
    };
    const databaseBindingRegistryWithData = {
      listBindings: async ({ websiteId }) => (websiteId === 'ws-1' ? [{ id: 'db-1', databaseName: 'mydb' }] : []),
    };
    const websiteRegistryWithIdentity = {
      getWebsite: async (id) => (id === 'ws-1' ? { ...testWebsite, applicationId: 'app-1', systemUser: 'siteuser1' } : null),
      listWebsites: async () => [{ ...testWebsite, applicationId: 'app-1', systemUser: 'siteuser1' }],
    };

    const runtimeWithAllProviders = createDomainRemovalProductionRuntime({
      filePath: path.join(tempDir, 'domain-removal-operations-all.json'),
      registry,
      applicationRegistry,
      websiteRegistry: websiteRegistryWithIdentity,
      domainRegistry,
      certificateRegistry,
      jobRegistry,
      dnsHostingRegistry,
      mailDomainRegistry,
      mailboxRegistry,
      dockerWorkloadRegistry,
      backupOperationRegistry,
      databaseBindingRegistry: databaseBindingRegistryWithData,
      websiteSftpKeyRegistry,
      runtimeBindingRegistry,
      domainSuspensionRuntime,
      mailDomainRemovalRuntime,
      roundcubeDomainMappingRegistry,
      roundcubeDomainMappingService,
      localServerId,
    });

    const previewWithAll = await runtimeWithAllProviders.preview({ domainId: testDomain.id });
    assert.equal(previewWithAll.plan.additional.databases.status, 'available');
    assert.deepEqual(previewWithAll.plan.additional.databases.ids, ['db-1']);
    assert.equal(previewWithAll.plan.additional.sftpKeys.status, 'available');
    assert.deepEqual(previewWithAll.plan.additional.sftpKeys.ids, ['key-1']);
    assert.equal(previewWithAll.plan.additional.runtimeBindings.status, 'available');
    assert.deepEqual(previewWithAll.plan.additional.runtimeBindings.ids, ['rb-1']);
    assert.equal(previewWithAll.plan.additional.unixIdentities.status, 'available');
    assert.deepEqual(previewWithAll.plan.additional.unixIdentities.ids, ['siteuser1']);
    assert.equal(previewWithAll.plan.additional.logScopes.status, 'available');
    assert.deepEqual(previewWithAll.plan.additional.logScopes.ids, ['ws-1']);
  });
});

