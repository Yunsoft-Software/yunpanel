import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningRoundcubeConfigRecoveryFromStores } from '../src/job-running-roundcube-config-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';
const previewSha256 = 'a'.repeat(64);

function resourceFactory(label, calls, extra = {}) {
  return ({ filePath }) => ({
    async init() { calls.push([`${label}.init`, filePath]); },
    ...extra,
  });
}

test('Roundcube recovery runtime reconstructs protected desired state, receipt and live web evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeDomainRegistry = {
    async init() { calls.push(['domain.init']); },
    async getDomain(id) { calls.push(['domain.get', id]); return { id, serverId }; },
  };
  const fakeCertificateRegistry = {
    async init() { calls.push(['certificate.init']); },
    async getCertificate(id) { calls.push(['certificate.get', id]); return { id }; },
  };
  const fakeIdentityRegistry = {
    async init() { calls.push(['identity.init']); },
    async getForServer(id) { return { serverId: id, ready: true }; },
    async materializeForServer(id) { calls.push(['identity.materialize', id]); return { serverId: id }; },
  };
  const fakeSecretRegistry = {
    async init() { calls.push(['secret.init']); },
    async getForServer(id) { return { serverId: id, configured: true }; },
    async ensureForServer(id) { return { serverId: id, configured: true }; },
    async materializeForServer(id) { calls.push(['secret.materialize', id]); return { serverId: id, desKey: 'private' }; },
  };

  const result = await runRunningRoundcubeConfigRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_DOMAIN_STORE: '/work/state/domains.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_CERTIFICATE_STORE: '/work/state/certificates.json',
      YUNPANEL_APPLICATION_STORE: '/work/state/applications.json',
      YUNPANEL_MAIL_SERVICE_IDENTITY_STORE: '/work/state/mail-service-identity.json',
      YUNPANEL_ROUNDCUBE_SECRET_STORE: '/work/state/roundcube-secret.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { return { id, hostname }; },
    }),
    domainRegistryFactory: () => fakeDomainRegistry,
    certificateRegistryFactory: () => fakeCertificateRegistry,
    applicationRegistryFactory: resourceFactory('application', calls),
    mailServiceIdentityRegistryFactory: ({ filePath, getWebDomain, getCertificate }) => {
      calls.push(['identity.create', filePath]);
      assert.equal(typeof getWebDomain, 'function');
      assert.equal(typeof getCertificate, 'function');
      return fakeIdentityRegistry;
    },
    roundcubeSecretRegistryFactory: ({ filePath, serverExists }) => {
      calls.push(['secret.create', filePath]);
      assert.equal(typeof serverExists, 'function');
      return fakeSecretRegistry;
    },
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id }; },
    }),
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId };
      },
    }),
    evidenceInspectorFactory: () => ({
      async inspect(preview) { calls.push(['evidence.inspect', preview]); return { satisfied: true, result: {} }; },
    }),
    roundcubeConfigurationServiceFactory: ({ mailServiceIdentityRegistry, roundcubeSecretRegistry }) => {
      assert.equal(mailServiceIdentityRegistry, fakeIdentityRegistry);
      assert.equal(roundcubeSecretRegistry, fakeSecretRegistry);
      return {
        async materializeForServer(id, expected) {
          calls.push(['materialize', id, expected]);
          return { preview: { sha256: previewSha256 } };
        },
      };
    },
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.readOperationReceipt(serverId, jobId), { serverId, jobId });
      assert.deepEqual(
        await input.materializeConfiguration(serverId, { expectedPreviewSha256: previewSha256 }),
        { preview: { sha256: previewSha256 } },
      );
      assert.deepEqual(await input.inspectActiveEvidence({ sha256: previewSha256 }), { satisfied: true, result: {} });
      return {
        serverId,
        jobId,
        operation: 'roundcube.config.apply',
        status: 'succeeded',
        recoveryMethod: 'verified_roundcube_receipt_and_active_host_state',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.mailServiceIdentityStore, '/work/state/mail-service-identity.json');
  assert.equal(result.statePaths.roundcubeSecretStore, '/work/state/roundcube-secret.json');
  assert.ok(calls.some(([name]) => name === 'receipt.read'));
  assert.ok(calls.some(([name]) => name === 'materialize'));
  assert.ok(calls.some(([name]) => name === 'evidence.inspect'));
});

test('Roundcube recovery runtime rejects wrong host before opening private Roundcube state', async () => {
  let protectedState = 0;
  await assert.rejects(
    runRunningRoundcubeConfigRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({
        async init() {},
        async getServer() { return { id: serverId, hostname: 'other-host' }; },
      }),
      domainRegistryFactory: () => ({ async init() {} }),
      certificateRegistryFactory: () => ({ async init() {} }),
      applicationRegistryFactory: () => ({ async init() {} }),
      mailServiceIdentityRegistryFactory: () => { protectedState += 1; return { async init() {} }; },
      roundcubeSecretRegistryFactory: () => { protectedState += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      receiptStoreFactory: () => ({ read: async () => ({}) }),
      evidenceInspectorFactory: () => ({ inspect: async () => ({}) }),
      roundcubeConfigurationServiceFactory: () => ({ materializeForServer: async () => ({}) }),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(protectedState, 0);
});
