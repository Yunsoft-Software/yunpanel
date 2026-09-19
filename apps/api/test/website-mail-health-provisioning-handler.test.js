import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteMailHealthProvisioningHandler,
  WebsiteMailHealthProvisioningError,
} from '../src/website-mail-health-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const configurationSha256 = 'a'.repeat(64);
const applyReadinessSha256 = 'b'.repeat(64);
const currentReadinessSha256 = 'c'.repeat(64);
const dkimConfigurationSha256 = 'd'.repeat(64);
const roundcubePreviewSha256 = 'e'.repeat(64);
const protocolHealthSha256 = 'f'.repeat(64);

function intent() {
  return {
    adapter: 'local-mail-cross-service-health',
    serverId,
    websiteId,
    webDomainId,
    mailDomainId,
    domainName: 'example.com',
    hostname: 'webmail.example.com',
    expectedMailDomainRevision: 2,
  };
}

function context() {
  return {
    operationId,
    websiteId,
    intent: intent(),
    operation: {
      operationId,
      websiteId,
      steps: [
        {
          id: 'mail_config',
          state: 'succeeded',
          evidence: {
            satisfied: true,
            adapter: 'managed-mail-config',
            mailDomainId,
            resultingRevision: 2,
            desiredStatus: 'enabled',
            configurationSha256,
            readinessSha256: applyReadinessSha256,
          },
        },
        {
          id: 'mail_dkim_config',
          state: 'succeeded',
          evidence: {
            satisfied: true,
            adapter: 'managed-mail-dkim-config',
            mailDomainId,
            expectedKeyRevision: 1,
            configurationSha256: dkimConfigurationSha256,
          },
        },
        {
          id: 'roundcube_mapping',
          state: 'succeeded',
          evidence: {
            satisfied: true,
            adapter: 'shared-roundcube-mapping',
            mappingId: 'mapping-1',
            mappingRevision: 3,
            hostname: 'webmail.example.com',
            roundcubePreviewSha256,
            roundcubeApplyJobId: 'roundcube-job-1',
          },
        },
      ],
    },
  };
}

function fixture({
  mailReady = true,
  protocolReady = true,
  webmailReady = true,
  currentConfigurationSha256 = configurationSha256,
} = {}) {
  let materializeCalls = 0;
  let readinessCalls = 0;
  let protocolCalls = 0;
  let endpointCalls = 0;
  const handler = createWebsiteMailHealthProvisioningHandler({
    mailDomainRegistry: {
      async getMailDomain(id) {
        assert.equal(id, mailDomainId);
        return {
          id: mailDomainId,
          webDomainId,
          domainName: 'example.com',
          managementMode: 'local',
          status: 'enabled',
          revision: 2,
        };
      },
    },
    domainRegistry: {
      async getDomain(id) {
        assert.equal(id, webDomainId);
        return {
          id: webDomainId,
          serverId,
          websiteId,
          primaryDomain: 'example.com',
          state: 'active',
        };
      },
    },
    mailConfigurationService: {
      async materializeCurrent(input, options) {
        materializeCalls += 1;
        assert.deepEqual(input, {
          mailDomainId,
          expectedRevision: 2,
          status: 'enabled',
        });
        assert.deepEqual(options, { expectedConfigurationSha256: configurationSha256 });
        return {
          state: { mailDomainId, revision: 2, status: 'enabled' },
          preview: { sha256: currentConfigurationSha256 },
          sensitiveArtifacts: [],
        };
      },
    },
    mailReadinessInspector: {
      async inspect(preview, options) {
        readinessCalls += 1;
        assert.equal(preview.sha256, configurationSha256);
        assert.deepEqual(options, { phase: 'post' });
        return {
          version: 1,
          sha256: currentReadinessSha256,
          phase: 'post',
          previewSha256: configurationSha256,
          ready: mailReady,
          requirements: [],
          blockers: mailReady ? [] : ['dovecot_2_3'],
          sideEffects: false,
        };
      },
    },
    mailProtocolHealthInspector: {
      async inspect() {
        protocolCalls += 1;
        return {
          version: 1,
          sha256: protocolHealthSha256,
          ready: protocolReady,
          protocols: [
            { id: 'smtp', port: 25, satisfied: true },
            { id: 'submission', port: 587, satisfied: protocolReady },
            { id: 'imap', port: 143, satisfied: protocolReady },
          ],
          blockers: protocolReady ? [] : ['submission', 'imap'],
          sideEffects: false,
        };
      },
    },
    roundcubeWebmailEndpointResolver: {
      async resolve(input) {
        endpointCalls += 1;
        assert.equal(input.mailDomain.id, mailDomainId);
        assert.equal(input.domain.id, webDomainId);
        return webmailReady ? {
          version: 1,
          mailDomainId,
          serverId,
          mappingId: 'mapping-1',
          mappingRevision: 3,
          hostname: 'webmail.example.com',
          protocol: 'https',
          path: '/',
          roundcubePreviewSha256,
          roundcubeApplyJobId: 'roundcube-job-1',
          ready: true,
        } : null;
      },
    },
  });
  return {
    handler,
    calls: () => ({ materializeCalls, readinessCalls, protocolCalls, endpointCalls }),
  };
}

test('local-mail health proves current mail services, protocol listeners and exact Roundcube endpoint', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(context());

  assert.deepEqual(evidence, {
    satisfied: true,
    adapter: 'local-mail-cross-service-health',
    mailDomainId,
    mailDomainRevision: 2,
    configurationSha256,
    dkimConfigurationSha256,
    mailReadinessSha256: currentReadinessSha256,
    protocolHealthSha256,
    hostname: 'webmail.example.com',
    roundcubeMappingId: 'mapping-1',
    roundcubeMappingRevision: 3,
    roundcubePreviewSha256,
    roundcubeApplyJobId: 'roundcube-job-1',
  });
  assert.deepEqual(f.calls(), {
    materializeCalls: 1,
    readinessCalls: 1,
    protocolCalls: 1,
    endpointCalls: 1,
  });
});

test('local-mail health blocks Website readiness while managed mail services are unhealthy', async () => {
  const f = fixture({ mailReady: false });
  const evidence = await f.handler.inspect(context());

  assert.deepEqual(evidence, {
    satisfied: false,
    reason: 'website_mail_service_health_not_ready',
    blockers: ['dovecot_2_3'],
  });
  assert.equal(f.calls().protocolCalls, 0);
  assert.equal(f.calls().endpointCalls, 0);
});

test('local-mail health blocks Website readiness while SMTP submission or IMAP listeners are absent', async () => {
  const f = fixture({ protocolReady: false });
  const evidence = await f.handler.apply(context());

  assert.deepEqual(evidence, {
    satisfied: false,
    reason: 'website_mail_protocol_health_not_ready',
    blockers: ['submission', 'imap'],
  });
  assert.equal(f.calls().endpointCalls, 0);
});

test('local-mail health blocks Website readiness until the exact Roundcube endpoint is healthy', async () => {
  const f = fixture({ webmailReady: false });
  const evidence = await f.handler.apply(context());

  assert.deepEqual(evidence, {
    satisfied: false,
    reason: 'website_webmail_health_not_ready',
    blockers: ['webmail'],
  });
});

test('local-mail health fails closed when current mail configuration drifted from apply evidence', async () => {
  const f = fixture({ currentConfigurationSha256: '9'.repeat(64) });
  await assert.rejects(
    f.handler.apply(context()),
    (error) => error instanceof WebsiteMailHealthProvisioningError
      && error.code === 'website_mail_health_configuration_drift',
  );
});
