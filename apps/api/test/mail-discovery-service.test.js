import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailDiscoveryService,
  MailDiscoveryServiceError,
} from '../src/mail-discovery-service.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const certificateId = 'dfac9681-84e6-4f95-a011-9942323e52bc';

function fixture({
  mailMode = 'local',
  mailStatus = 'enabled',
  domainState = 'active',
  identityReady = true,
} = {}) {
  const service = createMailDiscoveryService({
    mailDomainRegistry: {
      async listMailDomains() {
        return [{
          id: mailDomainId,
          webDomainId,
          domainName: 'example.com',
          managementMode: mailMode,
          status: mailStatus,
          revision: 2,
        }];
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
          state: domainState,
          httpsMode: 'managed',
          certificateId,
          desiredRevision: 4,
        };
      },
    },
    mailServiceIdentityRegistry: {
      async getForServer(id) {
        assert.equal(id, serverId);
        return {
          serverId,
          webDomainId: '767eb3d9-906f-47a9-ab85-6e70a6cc9a5a',
          hostname: 'mail.host.example.net',
          certificateId: '4d055bff-ab69-44b0-a2ca-dddd15ce84c7',
          revision: 3,
          ready: identityReady,
          blockers: identityReady ? [] : ['mail_service_certificate_not_ready'],
        };
      },
    },
  });
  return service;
}

test('Thunderbird autoconfig advertises the current mail-service identity over STARTTLS', async () => {
  const result = await fixture().autoconfig({
    domainName: 'Example.COM.',
    emailAddress: 'User.Name@example.com',
  });

  assert.equal(result.emailAddress, 'user.name@example.com');
  assert.equal(result.state.serviceHostname, 'mail.host.example.net');
  assert.equal(result.state.mailDomainRevision, 2);
  assert.equal(result.state.domainRevision, 4);
  assert.equal(result.state.serviceIdentityRevision, 3);
  assert.match(result.body, /<clientConfig version="1\.1">/);
  assert.match(result.body, /<domain>example\.com<\/domain>/);
  assert.match(result.body, /<hostname>mail\.host\.example\.net<\/hostname>/);
  assert.match(result.body, /<port>143<\/port>/);
  assert.match(result.body, /<port>587<\/port>/);
  assert.equal(result.body.match(/<socketType>STARTTLS<\/socketType>/g)?.length, 2);
  assert.equal(result.body.match(/<username>user\.name@example\.com<\/username>/g)?.length, 2);
  assert.equal(result.body.includes('993'), false);
  assert.equal(result.body.includes('465'), false);
});

test('Outlook autodiscover advertises only IMAP and submission for the managed stack', async () => {
  const result = await fixture().autodiscover({
    domainName: 'example.com',
    emailAddress: 'user@example.com',
  });

  assert.match(result.body, /<Type>IMAP<\/Type>/);
  assert.match(result.body, /<Type>SMTP<\/Type>/);
  assert.match(result.body, /<Server>mail\.host\.example\.net<\/Server>/);
  assert.match(result.body, /<Port>143<\/Port>/);
  assert.match(result.body, /<Port>587<\/Port>/);
  assert.equal(result.body.includes('<Type>POP3</Type>'), false);
  assert.equal(result.body.match(/<Encryption>TLS<\/Encryption>/g)?.length, 2);
  assert.equal(result.body.match(/<LoginName>user@example\.com<\/LoginName>/g)?.length, 2);
});

test('discovery does not enumerate mailboxes and accepts any canonical address on an enabled local domain', async () => {
  const service = fixture();
  const result = await service.autoconfig({
    domainName: 'example.com',
    emailAddress: 'not-created-yet@example.com',
  });
  assert.match(result.body, /not-created-yet@example\.com/);
});

test('discovery fails closed for external or disabled mail domains', async () => {
  for (const options of [
    { mailMode: 'external' },
    { mailStatus: 'disabled' },
  ]) {
    await assert.rejects(
      fixture(options).autoconfig({
        domainName: 'example.com',
        emailAddress: 'user@example.com',
      }),
      (error) => error instanceof MailDiscoveryServiceError
        && error.code === 'mail_discovery_domain_not_found'
        && error.status === 404,
    );
  }
});

test('discovery fails closed until Website TLS and mail service identity are ready', async () => {
  await assert.rejects(
    fixture({ domainState: 'draft' }).autodiscover({
      domainName: 'example.com',
      emailAddress: 'user@example.com',
    }),
    (error) => error instanceof MailDiscoveryServiceError
      && error.code === 'mail_discovery_web_domain_not_ready',
  );
  await assert.rejects(
    fixture({ identityReady: false }).autodiscover({
      domainName: 'example.com',
      emailAddress: 'user@example.com',
    }),
    (error) => error instanceof MailDiscoveryServiceError
      && error.code === 'mail_discovery_service_identity_not_ready',
  );
});

test('discovery rejects cross-domain email addresses', async () => {
  await assert.rejects(
    fixture().autoconfig({
      domainName: 'example.com',
      emailAddress: 'user@other.example',
    }),
    (error) => error instanceof MailDiscoveryServiceError
      && error.code === 'mail_discovery_address_domain_mismatch'
      && error.status === 404,
  );
});
