import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import express from 'express';
import { mountMailboxRoutes } from '../src/mailbox-http.js';
import { createSiteResourceBoundary, needsSiteResourceJson } from '../src/site-resource-boundary.js';
import { createTenantBoundaryMiddleware } from '../src/tenant-boundary.js';

// Also run client/web removal wiring checks
import '../../web/test/mailbox-removal-wiring.test.js';
import '../../web/test/mailbox-access-preparation.test.js';
import '../../web/test/mailbox-access-guard.test.js';
import '../../web/test/admin-layout.test.js';

const appUrl = new URL('../src/management-app.js', import.meta.url);
const mailboxHttpUrl = new URL('../src/mailbox-http.js', import.meta.url);
const finalizeUrl = new URL('../src/mail-delete-finalize.js', import.meta.url);
const impactUrl = new URL('../src/mail-delete-impact.js', import.meta.url);
const dataOpsUrl = new URL('../src/mail-data-operations.js', import.meta.url);

test('production app wires fresh impact into mail data delete and guarded finalization', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /createMailDeleteFinalizeService/);
  assert.match(source, /mailDeleteImpactService: mailDeleteImpact/);
  assert.match(source, /mailDeleteFinalizeService: mailDeleteFinalize/);
  assert.match(source, /mountMailboxRoutes\(app,\s*\{[\s\S]*?mailDeleteFinalizeService:\s*mailDeleteFinalize[\s\S]*?\}\)/);
  assert.match(source, /mountMailDomainDeleteRoute\(app, \{ mailDeleteFinalizeService: mailDeleteFinalize \}\)/);
  assert.match(source, /mountMailDeleteImpactRoutes\(app, \{ mailDeleteImpactService: mailDeleteImpact \}\)/);
  assert.match(source, /mountMailDataRoutes\(app, \{ mailDataOperationsService: mailDataOperations \}\)/);
});

test('local mailbox DELETE cannot mount without the guarded finalizer', async () => {
  const source = await readFile(mailboxHttpUrl, 'utf8');
  assert.match(source, /Local mailbox deletion requires the guarded mail data finalizer/);
  assert.match(source, /FINALIZE_DELETE_FIELDS/);
  assert.match(source, /deleteJobId/);
  assert.match(source, /finalizeMailbox/);
});

test('mailbox deletion finalizer validates terminal job, impact, and exact confirmation token', async () => {
  const source = await readFile(finalizeUrl, 'utf8');
  assert.match(source, /assertTerminalDeleteJob/);
  assert.match(source, /assertImpact/);
  assert.match(source, /stale_mailbox_revision/);
  assert.match(source, /mail_delete_job_mismatch/);
  assert.match(source, /mail_delete_impact_not_clear/);
});

test('mail delete impact inspects quota, forwarding, aliases, jobs, and mail data', async () => {
  const source = await readFile(impactUrl, 'utf8');
  assert.match(source, /mailboxAliasReferences/);
  assert.match(source, /mailbox_quota_configured/);
  assert.match(source, /mailbox_forwarding_configured/);
  assert.match(source, /mailbox_alias_reference_configured/);
  assert.match(source, /mail_domain_job_active/);
  assert.match(source, /mail_data_backup_required/);
});

test('single mailbox data operations require only target mailbox to be disabled', async () => {
  const source = await readFile(dataOpsUrl, 'utf8');
  assert.match(source, /mail_data_delete_mailbox_disable_required/);
  assert.match(source, /scope === 'mailbox'/);
  assert.match(source, /mailbox\.enabled === false/);
  // Domain disable requirement only applies to domain-scope operations
  assert.match(source, /scope === 'domain'/);
});

test('mailbox DELETE route enforces exact finalize fields and fail-closed tenant boundary', async () => {
  const localServerId = randomUUID();
  const websiteId = randomUUID();
  const foreignWebsiteId = randomUUID();
  const mailDomainId = randomUUID();
  const foreignMailDomainId = randomUUID();
  const mailboxId = randomUUID();
  const foreignMailboxId = randomUUID();

  const mailboxes = new Map([
    [mailboxId, { id: mailboxId, mailDomainId, address: 'user@example.com', revision: 2, enabled: false }],
    [foreignMailboxId, { id: foreignMailboxId, mailDomainId: foreignMailDomainId, address: 'user@other.com', revision: 2, enabled: false }],
  ]);

  const mailDomains = new Map([
    [mailDomainId, { id: mailDomainId, webDomainId: 'dom-1', domainName: 'example.com', managementMode: 'local', status: 'enabled' }],
    [foreignMailDomainId, { id: foreignMailDomainId, webDomainId: 'dom-2', domainName: 'other.com', managementMode: 'local', status: 'enabled' }],
  ]);

  const domains = new Map([
    ['dom-1', { id: 'dom-1', websiteId, serverId: localServerId, primaryDomain: 'example.com' }],
    ['dom-2', { id: 'dom-2', websiteId: foreignWebsiteId, serverId: localServerId, primaryDomain: 'other.com' }],
  ]);

  const websites = new Map([
    [websiteId, { id: websiteId, serverId: localServerId }],
    [foreignWebsiteId, { id: foreignWebsiteId, serverId: localServerId }],
  ]);

  let finalized = null;
  const mockFinalizer = {
    finalizeMailbox: async (args) => {
      finalized = args;
      return { id: args.mailboxId, deleted: true };
    },
  };

  const app = express();
  app.disable('x-powered-by');
  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });
  const smallJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => {
    if (needsSiteResourceJson(req)) return smallJson(req, res, next);
    return express.json()(req, res, next);
  });
  app.use(createTenantBoundaryMiddleware({
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    websiteLookup: async (id) => websites.get(id) || null,
  }));
  app.use(createSiteResourceBoundary({
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    domainRegistry: { getDomain: async (id) => domains.get(id) || null },
    mailDomainRegistry: { getMailDomain: async (id) => mailDomains.get(id) || null },
    mailboxRegistry: { getMailbox: async (id) => mailboxes.get(id) || null },
    localServerId,
  }));

  mountMailboxRoutes(app, {
    mailboxRegistry: {
      getMailbox: async (id) => mailboxes.get(id) || null,
      listMailboxes: async () => [...mailboxes.values()],
      createMailbox: async () => {},
      rotatePassword: async () => {},
      setEnabled: async () => {},
      deleteMailbox: async () => {},
    },
    mailDomainRegistry: { getMailDomain: async (id) => mailDomains.get(id) || null },
    domainRegistry: { getDomain: async (id) => domains.get(id) || null },
    mailDeleteFinalizeService: mockFinalizer,
    localServerId,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Read-only role rejected with 403
    currentAuth = {
      user: { id: 'reader', role: 'read_only' },
      access: { mode: 'read_only', permissions: ['mailboxes.read'] },
      security: { managementAllowed: false },
    };
    let res = await fetch(`${base}/api/mailboxes/${mailboxId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, deleteJobId: 'job-12345678', confirmation: 'delete-mailbox:user@example.com' }),
    });
    assert.equal(res.status, 403);

    // 2. Inactive account rejected with 403
    currentAuth = {
      user: { id: 'sm-1', role: 'site_manager', active: false, websiteIds: [websiteId] },
      access: { mode: 'site_management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    res = await fetch(`${base}/api/mailboxes/${mailboxId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, deleteJobId: 'job-12345678', confirmation: 'delete-mailbox:user@example.com' }),
    });
    assert.equal(res.status, 403);

    // 3. Cross-site deletion rejected with 403
    currentAuth = {
      user: { id: 'sm-1', role: 'site_manager', active: true, websiteIds: [websiteId] },
      access: { mode: 'site_management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    res = await fetch(`${base}/api/mailboxes/${foreignMailboxId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, deleteJobId: 'job-12345678', confirmation: 'delete-mailbox:user@other.com' }),
    });
    assert.equal(res.status, 403);

    // 4. Authorized site_manager can delete mailbox on own site
    res = await fetch(`${base}/api/mailboxes/${mailboxId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, deleteJobId: 'job-12345678', confirmation: 'delete-mailbox:user@example.com' }),
    });
    const resBody = await res.json();
    assert.equal(res.status, 200, JSON.stringify(resBody));
    assert.equal(finalized?.mailboxId, mailboxId);
    assert.equal(finalized?.deleteJobId, 'job-12345678');

    // 5. Authorized customer can delete mailbox on own site
    finalized = null;
    currentAuth = {
      user: { id: 'cust-1', role: 'customer', hosting: { kind: 'customer' }, active: true, websiteIds: [websiteId] },
      access: { mode: 'site_management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    res = await fetch(`${base}/api/mailboxes/${mailboxId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, deleteJobId: 'job-87654321', confirmation: 'delete-mailbox:user@example.com' }),
    });
    assert.equal(res.status, 200);
    assert.equal(finalized?.deleteJobId, 'job-87654321');

    // 6. Owner can delete mailbox
    finalized = null;
    currentAuth = {
      user: { id: 'owner', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true, ownerMfaRequired: false, enrollmentRequired: false },
    };
    res = await fetch(`${base}/api/mailboxes/${mailboxId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, deleteJobId: 'job-owner-123', confirmation: 'delete-mailbox:user@example.com' }),
    });
    assert.equal(res.status, 200);
    assert.equal(finalized?.deleteJobId, 'job-owner-123');

    // 7. Missing fields rejected with 400
    res = await fetch(`${base}/api/mailboxes/${mailboxId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    assert.equal(res.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
