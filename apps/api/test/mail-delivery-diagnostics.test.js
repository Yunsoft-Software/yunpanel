import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { createSiteResourceBoundary } from '../src/site-resource-boundary.js';
import { MailDiagnosticsHttpError, mountMailDiagnosticsRoutes } from '../src/mail-diagnostics-http.js';
import { createMailDeliveryDiagnosticsService, MailDeliveryDiagnosticsError } from '../src/mail-delivery-diagnostics-service.js';

const localServerId = randomUUID();
const remoteServerId = randomUUID();

const localWebsite = { id: 'website-local', serverId: localServerId, applicationId: 'app-local' };
const foreignWebsite = { id: 'website-foreign', serverId: localServerId, applicationId: 'app-foreign' };

const localWebDomain = { id: 'domain-local', websiteId: localWebsite.id, serverId: localServerId, primaryDomain: 'example.com' };
const foreignWebDomain = { id: 'domain-foreign', websiteId: foreignWebsite.id, serverId: localServerId, primaryDomain: 'foreign.com' };
const externalWebDomain = { id: 'domain-external', websiteId: localWebsite.id, serverId: localServerId, primaryDomain: 'external.example' };

const localMailDomain = {
  id: 'mail-local',
  webDomainId: localWebDomain.id,
  domainName: 'example.com',
  managementMode: 'local',
  status: 'enabled',
  mailHostname: 'mail.example.com',
  revision: 1,
};

const foreignMailDomain = {
  id: 'mail-foreign',
  webDomainId: foreignWebDomain.id,
  domainName: 'foreign.com',
  managementMode: 'local',
  status: 'enabled',
  mailHostname: 'mail.foreign.com',
  revision: 1,
};

const externalMailDomain = {
  id: 'mail-external',
  webDomainId: externalWebDomain.id,
  domainName: 'external.example',
  managementMode: 'external',
  status: 'ready',
  mailHostname: null,
  revision: 1,
};

const localMailbox = Object.freeze({
  id: 'mailbox-local',
  mailDomainId: localMailDomain.id,
  address: 'user@example.com',
  enabled: true,
  revision: 1,
});

const foreignMailbox = Object.freeze({
  id: 'mailbox-foreign',
  mailDomainId: foreignMailDomain.id,
  address: 'other@foreign.com',
  enabled: true,
  revision: 1,
});

const disabledMailbox = Object.freeze({
  id: 'mailbox-disabled',
  mailDomainId: localMailDomain.id,
  address: 'disabled@example.com',
  enabled: false,
  revision: 1,
});

const ownerAuth = Object.freeze({
  user: { id: 'owner-user', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

const siteManagerAuth = Object.freeze({
  user: { id: 'site-manager-user', role: 'site_manager', websiteIds: [localWebsite.id] },
  access: { mode: 'site_management', permissions: ['mail_domains.read', 'mailboxes.read'] },
  security: { managementAllowed: true },
});

const foreignSiteManagerAuth = Object.freeze({
  user: { id: 'foreign-manager-user', role: 'site_manager', websiteIds: [foreignWebsite.id] },
  access: { mode: 'site_management', permissions: ['mail_domains.read', 'mailboxes.read'] },
  security: { managementAllowed: true },
});

const readOnlyAuth = Object.freeze({
  user: { id: 'ro-user', role: 'read_only' },
  access: { mode: 'read_only', permissions: ['mail_domains.read', 'mailboxes.read', 'servers.read'] },
  security: { managementAllowed: false },
});

const dkimKey = Object.freeze({
  mailDomainId: localMailDomain.id,
  domainName: localMailDomain.domainName,
  selector: 'mail-2026',
  publicKey: Buffer.alloc(128, 7).toString('base64'),
  dnsRecord: Object.freeze({
    type: 'TXT',
    name: 'mail-2026._domainkey.example.com',
    value: `v=DKIM1; k=rsa; p=${Buffer.alloc(128, 7).toString('base64')}`,
  }),
  revision: 1,
});

function createMockApp({
  auth = ownerAuth,
  mailDomains = [localMailDomain, foreignMailDomain, externalMailDomain],
  mailboxes = [localMailbox, foreignMailbox, disabledMailbox],
  transportSuccess = true,
  queueEntries = [],
  logEntries = [],
  dnsMock = {},
  protocolMock = {},
} = {}) {
  const app = express();
  app.use(express.json());

  const mailDomainMap = new Map(mailDomains.map((d) => [d.id, d]));
  const mailboxMap = new Map(mailboxes.map((b) => [b.id, b]));
  const webDomainMap = new Map([
    [localWebDomain.id, localWebDomain],
    [foreignWebDomain.id, foreignWebDomain],
    [externalWebDomain.id, externalWebDomain],
  ]);
  const websiteMap = new Map([
    [localWebsite.id, localWebsite],
    [foreignWebsite.id, foreignWebsite],
  ]);

  const mailDomainRegistry = {
    async getMailDomain(id) { return mailDomainMap.get(id) ?? null; },
    async listMailDomains() { return [...mailDomainMap.values()]; },
  };

  const domainRegistry = {
    async getDomain(id) { return webDomainMap.get(id) ?? null; },
    async listDomains() { return [...webDomainMap.values()]; },
  };

  const websiteRegistry = {
    async getWebsite(id) { return websiteMap.get(id) ?? null; },
  };

  const mailboxRegistry = {
    async getMailbox(id) { return mailboxMap.get(id) ?? null; },
    async listMailboxes(filter) {
      const all = [...mailboxMap.values()];
      if (filter?.mailDomainId) return all.filter((b) => b.mailDomainId === filter.mailDomainId);
      return all;
    },
  };

  const mailboxForwardingRegistry = {
    async materializeEnabledForwardings() { return []; },
  };

  const mailboxQuotaRegistry = {
    async getQuota(id) {
      if (id === localMailbox.id) return { mailboxId: id, quotaBytes: 104857600, revision: 1 };
      return null;
    },
  };

  const mailDkimRegistry = {
    async getKey(id) { return id === localMailDomain.id ? dkimKey : null; },
  };

  const mailDiagnosticsInspector = {
    async inspect(domainName, options) {
      return {
        version: 1,
        domainName,
        mailHostname: `mail.${domainName}`,
        observedAt: new Date().toISOString(),
        diagnostics: {
          mx: dnsMock.mx ?? { status: 'matched', records: [`mail.${domainName}`] },
          spf: dnsMock.spf ?? { status: 'valid', record: 'v=spf1 mx ~all' },
          dkim: dnsMock.dkim ?? { status: 'valid', selector: 'mail-2026' },
          dmarc: dnsMock.dmarc ?? { status: 'valid', policy: 'quarantine', record: 'v=DMARC1; p=quarantine' },
          ptr: dnsMock.ptr ?? { status: 'valid', record: 'mail.example.com' },
        },
        attentionRequired: false,
        issues: [],
      };
    },
  };

  const mailProtocolHealthInspector = {
    async inspect() {
      return {
        version: 1,
        ready: protocolMock.ready ?? true,
        protocols: protocolMock.protocols ?? [
          { id: 'smtp', port: 25, satisfied: true },
          { id: 'submission', port: 587, satisfied: true },
          { id: 'submissions', port: 465, satisfied: true },
          { id: 'imap', port: 143, satisfied: true },
          { id: 'imaps', port: 993, satisfied: true },
        ],
      };
    },
  };

  const mailQueueInspector = {
    async query({ limit, search }) {
      return {
        entries: queueEntries,
        page: { limit: limit ?? 100, count: queueEntries.length, scanned: queueEntries.length, hasMore: false, malformed: 0 },
      };
    },
  };

  const journalLogReader = {
    async query({ unit, limit, search }) {
      return {
        entries: logEntries,
        page: { limit: limit ?? 100, count: logEntries.length, scanned: logEntries.length, hasMore: false, malformed: 0 },
      };
    },
    async readServiceLogs({ service, limit, search }) {
      return {
        service,
        entries: logEntries,
        page: { limit: limit ?? 100, count: logEntries.length, scanned: logEntries.length, hasMore: false, malformed: 0 },
      };
    },
  };

  const transport = {
    async sendMail(opts) {
      if (!transportSuccess) {
        const err = new Error('SMTP connection timed out to destination mail server');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return { messageId: '<test-12345@example.com>', accepted: [opts.to], response: '250 2.0.0 Ok: queued' };
    },
  };

  // Auth middleware
  app.use((req, _res, next) => {
    req.auth = auth;
    next();
  });

  // Site resource boundary
  app.use(createSiteResourceBoundary({
    localServerId,
    websiteRegistry,
    domainRegistry,
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry: { async getAlias() { return null; } },
    jobRegistry: { async getJob() { return null; }, async listJobs() { return []; } },
  }));

  mountMailDiagnosticsRoutes(app, {
    mailDiagnosticsInspector,
    mailDkimRegistry,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailProtocolHealthInspector,
    mailQueueInspector,
    journalLogReader,
    localServerId,
    transport,
  });

  app.use((error, _req, res, _next) => {
    const status = error.status ?? (error.name === 'ScopeError' ? 403 : error instanceof MailDiagnosticsHttpError ? error.status : 500);
    return res.status(status).json({
      error: {
        code: error.code ?? 'internal_error',
        message: error.message ?? 'Internal error',
      },
    });
  });

  return app;
}

async function startServer(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('connection settings expose correct hostnames, SMTP ports 25/587/465, IMAP ports 143/993, and TLS requirements', async (t) => {
  const app = createMockApp({ auth: ownerAuth });
  const base = await startServer(t, app);

  // 1. Mail domain connection settings
  const domainRes = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/connection-settings`);
  assert.equal(domainRes.status, 200);
  const domainBody = await domainRes.json();
  const domainConn = domainBody.data;

  assert.equal(domainConn.hostname, 'mail.example.com');
  assert.deepEqual(domainConn.smtp.ports, [465, 587, 25]);
  assert.equal(domainConn.smtp.tls, 'SSL/TLS (Port 465) / STARTTLS (Port 587, 25)');
  assert.deepEqual(domainConn.imap.ports, [993, 143]);
  assert.equal(domainConn.imap.tls, 'SSL/TLS (Port 993) / STARTTLS (Port 143)');
  assert.equal(domainConn.authentication, 'Password (PLAIN, LOGIN)');

  // 2. Mailbox connection settings
  const mailboxRes = await fetch(`${base}/api/mailboxes/${localMailbox.id}/connection-settings`);
  assert.equal(mailboxRes.status, 200);
  const mailboxBody = await mailboxRes.json();
  const mailboxConn = mailboxBody.data;

  assert.equal(mailboxConn.username, 'user@example.com');
  assert.equal(mailboxConn.smtp.host, 'mail.example.com');
  assert.deepEqual(mailboxConn.smtp.ports, [465, 587, 25]);
  assert.equal(mailboxConn.imap.host, 'mail.example.com');
  assert.deepEqual(mailboxConn.imap.ports, [993, 143]);

  // 3. Server service connection settings (Owner)
  const serverRes = await fetch(`${base}/api/servers/${localServerId}/mail/connection-settings`);
  assert.equal(serverRes.status, 200);
  const serverBody = await serverRes.json();
  const serverConn = serverBody.data.connectionSettings;

  assert.deepEqual(serverConn.smtp.ports, [465, 587, 25]);
  assert.deepEqual(serverConn.imap.ports, [993, 143]);
  assert.ok(serverBody.data.protocols.ready);
  assert.equal(serverBody.data.protocols.protocols.length, 5);
});

test('DNS requirements verify and display SPF, DKIM, DMARC, and MX records with clear status', async (t) => {
  const app = createMockApp({
    auth: ownerAuth,
    dnsMock: {
      mx: { status: 'matched', records: ['mail.example.com'] },
      spf: { status: 'valid', record: 'v=spf1 mx ~all' },
      dkim: { status: 'valid', selector: 'mail-2026' },
      dmarc: { status: 'valid', policy: 'quarantine', record: 'v=DMARC1; p=quarantine' },
      ptr: { status: 'valid', record: 'mail.example.com' },
    },
  });
  const base = await startServer(t, app);

  const res = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/delivery-diagnostics`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const dns = body.data.dnsRequirements;

  assert.equal(dns.mx.status, 'matched');
  assert.deepEqual(dns.mx.records, ['mail.example.com']);
  assert.equal(dns.spf.status, 'valid');
  assert.equal(dns.spf.record, 'v=spf1 mx ~all');
  assert.equal(dns.dkim.status, 'valid');
  assert.equal(dns.dkim.selector, 'mail-2026');
  assert.equal(dns.dmarc.status, 'valid');
  assert.equal(dns.dmarc.policy, 'quarantine');
  assert.equal(dns.ptr.status, 'valid');
  assert.equal(body.data.routing, 'local');
});

test('mail queue status and delivery logs distinguish local from external mail routing with secret masking', async (t) => {
  const secretKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----';
  const secretPass = 'super_secret_password_123';

  const rawQueue = [
    {
      queueId: '4V8xYZ1234',
      queueName: 'active',
      arrivalTime: '2026-10-03T09:00:00.000Z',
      messageSize: 1024,
      sender: 'user@example.com',
      recipients: [{ address: 'inbox@example.com', delayReason: null }],
    },
    {
      queueId: '4V8xYZ5678',
      queueName: 'deferred',
      arrivalTime: '2026-10-03T09:05:00.000Z',
      messageSize: 2048,
      sender: 'user@example.com',
      recipients: [{
        address: 'external-target@gmail.com',
        delayReason: `451 Authentication failed with secret=${secretPass} key=${secretKey}`,
      }],
    },
  ];

  const rawLogs = [
    {
      timestamp: '2026-10-03T09:00:00.000Z',
      level: 'info',
      message: 'postfix/local[1234]: 4V8xYZ1234: to=<inbox@example.com>, relay=local, delay=0.1, status=sent (delivered to mailbox)',
    },
    {
      timestamp: '2026-10-03T09:00:01.000Z',
      level: 'info',
      message: 'dovecot: lda(inbox@example.com): saved mail to INBOX',
    },
    {
      timestamp: '2026-10-03T09:05:00.000Z',
      level: 'info',
      message: `postfix/smtp[5678]: from=<user@example.com>, to=<external-target@gmail.com>, relay=smtp.gmail.com:587, auth password=${secretPass}, status=deferred`,
    },
  ];

  const app = createMockApp({
    auth: ownerAuth,
    queueEntries: rawQueue,
    logEntries: rawLogs,
  });
  const base = await startServer(t, app);

  // 1. Queue endpoint
  const qRes = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/queue`);
  assert.equal(qRes.status, 200);
  const qBody = await qRes.json();
  const qEntries = qBody.data.entries;

  assert.equal(qEntries.length, 2);
  // First entry has recipient inbox@example.com (local domain) -> routing: local
  assert.equal(qEntries[0].routing, 'local');
  // Second entry has recipient external-target@gmail.com (external domain) -> routing: external
  assert.equal(qEntries[1].routing, 'external');

  // Verify secret masking: neither the password nor the private key should appear anywhere in queue response
  const qJson = JSON.stringify(qBody);
  assert.ok(!qJson.includes(secretPass), 'Secret password must never leak in queue output');
  assert.ok(!qJson.includes('BEGIN RSA PRIVATE KEY'), 'Private key must never leak in queue output');
  assert.ok(qEntries[1].recipients[0].delayReason.includes('[REDACTED]'), 'Secret must be masked to [REDACTED]');

  // 2. Logs endpoint
  const logRes = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/delivery-logs`);
  assert.equal(logRes.status, 200);
  const logBody = await logRes.json();
  const logEntriesResult = logBody.data.entries;

  assert.equal(logEntriesResult.length, 3);
  assert.equal(logEntriesResult[0].routing, 'local');
  assert.equal(logEntriesResult[1].routing, 'local');
  assert.equal(logEntriesResult[2].routing, 'external');

  // Verify secret masking in logs
  const logJson = JSON.stringify(logBody);
  assert.ok(!logJson.includes(secretPass), 'Secret password must never leak in delivery logs');
  assert.ok(logEntriesResult[2].message.includes('[REDACTED]'), 'Password must be masked in log string');
});

test('test email send and receive verification reflects genuine delivery results without synthetic success', async (t) => {
  // 1. Successful genuine test delivery
  const appSuccess = createMockApp({ auth: ownerAuth, transportSuccess: true });
  const baseSuccess = await startServer(t, appSuccess);

  const resSuccess = await fetch(`${baseSuccess}/api/mail-domains/${localMailDomain.id}/test-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: 'inbox@example.com', subject: 'Integration Test' }),
  });
  assert.equal(resSuccess.status, 200);
  const bodySuccess = await resSuccess.json();

  assert.equal(bodySuccess.data.delivered, true);
  assert.equal(bodySuccess.data.recipient, 'inbox@example.com');
  assert.equal(bodySuccess.data.routing, 'local');
  assert.ok(bodySuccess.data.messageId);

  // 2. Failed genuine test delivery (never report synthetic success)
  const appFail = createMockApp({ auth: ownerAuth, transportSuccess: false });
  const baseFail = await startServer(t, appFail);

  const resFail = await fetch(`${baseFail}/api/mail-domains/${localMailDomain.id}/test-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: 'remote@external-server.com', subject: 'Failure Test' }),
  });
  assert.equal(resFail.status, 200);
  const bodyFail = await resFail.json();

  // Preserves authentic failure without synthetic success
  assert.equal(bodyFail.data.delivered, false);
  assert.equal(bodyFail.data.routing, 'external');
  assert.ok(bodyFail.data.error.includes('ETIMEDOUT') || bodyFail.data.error.includes('timed out'));

  // 3. Mailbox reception verification reflects authentic account state
  const mRes = await fetch(`${baseSuccess}/api/mailboxes/${localMailbox.id}/delivery-diagnostics`);
  assert.equal(mRes.status, 200);
  const mBody = await mRes.json();
  assert.equal(mBody.data.reception.canReceive, true);
  assert.equal(mBody.data.reception.enabled, true);

  const disabledRes = await fetch(`${baseSuccess}/api/mailboxes/${disabledMailbox.id}/delivery-diagnostics`);
  assert.equal(disabledRes.status, 200);
  const disabledBody = await disabledRes.json();
  assert.equal(disabledBody.data.reception.canReceive, false);
  assert.equal(disabledBody.data.reception.enabled, false);
  assert.equal(disabledBody.data.reception.reason, 'mailbox_disabled');
});

test('tenant isolation and RBAC: site administrators access only authorized mail accounts, owner has system-wide access', async (t) => {
  // Test with site administrator assigned to localWebsite
  const appSiteManager = createMockApp({ auth: siteManagerAuth });
  const baseSiteManager = await startServer(t, appSiteManager);

  // Site manager CAN access authorized local mail domain diagnostics
  const ownDomainRes = await fetch(`${baseSiteManager}/api/mail-domains/${localMailDomain.id}/delivery-diagnostics`);
  assert.equal(ownDomainRes.status, 200);

  // Site manager CAN access authorized local mailbox diagnostics
  const ownBoxRes = await fetch(`${baseSiteManager}/api/mailboxes/${localMailbox.id}/delivery-diagnostics`);
  assert.equal(ownBoxRes.status, 200);

  // Site manager CAN send test delivery on authorized local mail domain
  const ownTestRes = await fetch(`${baseSiteManager}/api/mail-domains/${localMailDomain.id}/test-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: 'user@example.com' }),
  });
  assert.equal(ownTestRes.status, 200);

  // Site manager CANNOT access other tenant's mail domain (403 Forbidden)
  const foreignDomainRes = await fetch(`${baseSiteManager}/api/mail-domains/${foreignMailDomain.id}/delivery-diagnostics`);
  assert.equal(foreignDomainRes.status, 403);

  // Site manager CANNOT access other tenant's mailbox (403 Forbidden)
  const foreignBoxRes = await fetch(`${baseSiteManager}/api/mailboxes/${foreignMailbox.id}/delivery-diagnostics`);
  assert.equal(foreignBoxRes.status, 403);

  // Site manager CANNOT access server-level mail routes (403 Forbidden)
  const serverConnRes = await fetch(`${baseSiteManager}/api/servers/${localServerId}/mail/connection-settings`);
  assert.equal(serverConnRes.status, 403);

  const serverDiagRes = await fetch(`${baseSiteManager}/api/servers/${localServerId}/mail/delivery-diagnostics`);
  assert.equal(serverDiagRes.status, 403);

  const serverTestRes = await fetch(`${baseSiteManager}/api/servers/${localServerId}/mail/test-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: 'admin@example.com' }),
  });
  assert.equal(serverTestRes.status, 403);

  // Read-only user cannot trigger test delivery (403 Forbidden)
  const appReadOnly = createMockApp({ auth: readOnlyAuth });
  const baseReadOnly = await startServer(t, appReadOnly);

  const roReadRes = await fetch(`${baseReadOnly}/api/mail-domains/${localMailDomain.id}/connection-settings`);
  assert.equal(roReadRes.status, 200);

  const roPostRes = await fetch(`${baseReadOnly}/api/mail-domains/${localMailDomain.id}/test-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: 'test@example.com' }),
  });
  assert.equal(roPostRes.status, 403);

  // Unauthenticated requests are rejected (401 Unauthorized)
  const appUnauth = createMockApp({ auth: null });
  const baseUnauth = await startServer(t, appUnauth);

  const unauthRes = await fetch(`${baseUnauth}/api/mail-domains/${localMailDomain.id}/delivery-diagnostics`);
  assert.equal(unauthRes.status, 401);
});

test('local vs external mail routing separation', async (t) => {
  const app = createMockApp({ auth: ownerAuth });
  const base = await startServer(t, app);

  // External mail domain has routing marked as external
  const extRes = await fetch(`${base}/api/mail-domains/${externalMailDomain.id}/delivery-diagnostics`);
  assert.equal(extRes.status, 200);
  const extBody = await extRes.json();
  assert.equal(extBody.data.routing, 'external');
  assert.equal(extBody.data.managementMode, 'external');
  assert.equal(extBody.data.connectionSettings.routing, 'external');
  assert.ok(extBody.data.connectionSettings.note.includes('external'));

  // Local mail domain has routing marked as local
  const localRes = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/delivery-diagnostics`);
  assert.equal(localRes.status, 200);
  const localBody = await localRes.json();
  assert.equal(localBody.data.routing, 'local');
  assert.equal(localBody.data.managementMode, 'local');
  assert.equal(localBody.data.connectionSettings.routing, 'local');
});
