import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailDiscoveryEndpointResolver,
  MailDiscoveryEndpointResolverError,
} from '../src/mail-discovery-endpoint-resolver.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const certificateId = 'dfac9681-84e6-4f95-a011-9942323e52bc';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const checksum = 'a'.repeat(64);

function resources(overrides = {}) {
  const mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'enabled',
    revision: 2,
    ...(overrides.mailDomain ?? {}),
  };
  const domain = {
    id: webDomainId,
    serverId,
    websiteId,
    primaryDomain: 'example.com',
    state: 'active',
    httpsMode: 'managed',
    httpsRedirect: true,
    canonicalRedirect: false,
    certificateId,
    desiredRevision: 4,
    stagedChecksum: checksum,
    ...(overrides.domain ?? {}),
  };
  return { mailDomain, domain };
}

function operation({ discoverySocket = true, tlsState = 'succeeded' } = {}) {
  return {
    operationId,
    websiteId,
    steps: [
      {
        id: 'nginx',
        kind: 'nginx',
        state: 'succeeded',
        intent: {
          websiteId,
          primaryDomain: 'example.com',
          aliases: [],
          ...(discoverySocket ? {
            mailDiscoverySocketPath: '/run/yunpanel-mail-discovery/discovery.sock',
          } : {}),
          targetType: 'static',
          target: { root: '/var/www/site' },
        },
        evidence: {
          satisfied: true,
          configName: 'yunpanel-example.com.conf',
          checksum: 'b'.repeat(64),
          active: true,
        },
      },
      {
        id: 'tls_activation',
        kind: 'tls_activation',
        state: tlsState,
        evidence: tlsState === 'succeeded' ? {
          satisfied: true,
          adapter: 'managed-certificate-nginx',
          certificateId,
          domainId: webDomainId,
          domainRevision: 4,
          nginxChecksum: checksum,
          nginxConfigName: 'yunpanel-example.com.conf',
          httpsRedirect: true,
          canonicalRedirect: false,
        } : null,
      },
    ],
  };
}

function fixture({
  runtimeReady = true,
  operations = [operation()],
  stateOverrides = {},
} = {}) {
  return createMailDiscoveryEndpointResolver({
    mailDiscoveryRuntime: {
      async inspect() {
        return {
          version: 1,
          ready: runtimeReady,
          socketPath: '/run/yunpanel-mail-discovery/discovery.sock',
          blocker: runtimeReady ? null : 'mail_discovery_socket_unavailable',
          sideEffects: false,
        };
      },
    },
    mailDiscoveryService: {
      async resolveState() {
        return {
          domainName: 'example.com',
          websiteId,
          webDomainId,
          mailDomainId,
          mailDomainRevision: 2,
          serverId,
          domainRevision: 4,
          certificateId,
          serviceHostname: 'mail.host.example.net',
          serviceIdentityRevision: 3,
          ...stateOverrides,
        };
      },
    },
    websiteProvisioningRegistry: {
      async listForWebsite(id) {
        assert.equal(id, websiteId);
        return operations;
      },
    },
  });
}

test('resolver proves current socket plus exact TLS Nginx route before advertising apex discovery endpoints', async () => {
  const resolved = await fixture().resolve(resources());
  assert.deepEqual(resolved, {
    version: 1,
    mailDomainId,
    serverId,
    revision: 2,
    autodiscover: {
      ready: true,
      hostname: 'example.com',
      protocol: 'https',
      path: '/autodiscover/autodiscover.xml',
    },
    autoconfig: {
      ready: true,
      hostname: 'example.com',
      protocol: 'https',
      path: '/mail/config-v1.1.xml',
    },
  });
});

test('resolver returns no readiness evidence while the socket or TLS route is unavailable', async () => {
  assert.equal(await fixture({ runtimeReady: false }).resolve(resources()), null);
  assert.equal(await fixture({ operations: [operation({ discoverySocket: false })] }).resolve(resources()), null);
  assert.equal(await fixture({ operations: [operation({ tlsState: 'pending' })] }).resolve(resources()), null);
});

test('resolver fails closed when discovery service identity drifts from requested Domain state', async () => {
  await assert.rejects(
    fixture({ stateOverrides: { certificateId: '47faf670-36f4-4efa-b617-54a40a8bb95a' } }).resolve(resources()),
    (error) => error instanceof MailDiscoveryEndpointResolverError
      && error.code === 'mail_discovery_endpoint_state_drift',
  );
});

test('resolver rejects external mail resource scopes before runtime inspection', async () => {
  const scoped = resources({ mailDomain: { managementMode: 'external', status: 'unverified' } });
  await assert.rejects(
    fixture().resolve(scoped),
    (error) => error instanceof MailDiscoveryEndpointResolverError
      && error.code === 'mail_discovery_endpoint_scope_invalid',
  );
});
