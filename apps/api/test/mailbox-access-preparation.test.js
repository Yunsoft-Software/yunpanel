import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { mountMailboxRoutes } from '../src/mailbox-http.js';
import { MailboxRegistryError } from '../src/mailbox-registry.js';
import { createSiteResourceBoundary, needsSiteResourceJson } from '../src/site-resource-boundary.js';
import { createTenantBoundaryMiddleware } from '../src/tenant-boundary.js';

const localServerId = randomUUID();
const websiteId = randomUUID();
const foreignWebsiteId = randomUUID();
const mailDomainId = randomUUID();
const foreignMailDomainId = randomUUID();
const mailboxId = randomUUID();
const siblingMailboxId = randomUUID();
const foreignMailboxId = randomUUID();

function createFixture() {
  const mailboxes = new Map([
    [mailboxId, {
      id: mailboxId,
      mailDomainId,
      address: 'user@example.com',
      enabled: true,
      revision: 3,
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-04T00:00:00.000Z',
    }],
    [siblingMailboxId, {
      id: siblingMailboxId,
      mailDomainId,
      address: 'sibling@example.com',
      enabled: true,
      revision: 5,
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-04T00:00:00.000Z',
    }],
    [foreignMailboxId, {
      id: foreignMailboxId,
      mailDomainId: foreignMailDomainId,
      address: 'user@foreign.com',
      enabled: true,
      revision: 2,
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-04T00:00:00.000Z',
    }],
  ]);

  const mailDomains = new Map([
    [mailDomainId, {
      id: mailDomainId,
      webDomainId: 'dom-local',
      domainName: 'example.com',
      status: 'enabled',
      managementMode: 'local',
      revision: 4,
    }],
    [foreignMailDomainId, {
      id: foreignMailDomainId,
      webDomainId: 'dom-foreign',
      domainName: 'foreign.com',
      status: 'enabled',
      managementMode: 'local',
      revision: 1,
    }],
  ]);

  const domains = new Map([
    ['dom-local', { id: 'dom-local', websiteId, serverId: localServerId, primaryDomain: 'example.com' }],
    ['dom-foreign', { id: 'dom-foreign', websiteId: foreignWebsiteId, serverId: localServerId, primaryDomain: 'foreign.com' }],
  ]);

  const websites = new Map([
    [websiteId, { id: websiteId, serverId: localServerId }],
    [foreignWebsiteId, { id: foreignWebsiteId, serverId: localServerId }],
  ]);

  const mailboxRegistry = {
    async getMailbox(id) {
      return mailboxes.has(id) ? structuredClone(mailboxes.get(id)) : null;
    },
    async listMailboxes(filter) {
      const list = [...mailboxes.values()];
      return filter?.mailDomainId ? list.filter((m) => m.mailDomainId === filter.mailDomainId) : list;
    },
    async setEnabled(id, { expectedRevision, enabled }) {
      const box = mailboxes.get(id);
      if (!box) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (box.revision !== expectedRevision) {
        throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox state changed before update', 409);
      }
      box.enabled = Boolean(enabled);
      box.revision += 1;
      box.updatedAt = new Date().toISOString();
      return structuredClone(box);
    },
    async createMailbox() {},
    async rotatePassword() {},
    async deleteMailbox() {},
  };

  const mailDomainRegistry = {
    async getMailDomain(id) {
      return mailDomains.has(id) ? structuredClone(mailDomains.get(id)) : null;
    },
  };

  const domainRegistry = {
    async getDomain(id) {
      return domains.has(id) ? structuredClone(domains.get(id)) : null;
    },
  };

  const mockFinalizer = {
    async finalizeMailbox({ mailboxId: id }) {
      return { id, deleted: true };
    },
  };

  return {
    mailboxes,
    mailDomains,
    domains,
    websites,
    mailboxRegistry,
    mailDomainRegistry,
    domainRegistry,
    mockFinalizer,
  };
}

function createServer(fixture, getAuth) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, _res, next) => {
    req.auth = getAuth();
    next();
  });
  const smallJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => {
    if (needsSiteResourceJson(req)) return smallJson(req, res, next);
    return express.json()(req, res, next);
  });
  app.use(createTenantBoundaryMiddleware({
    websiteRegistry: { getWebsite: async (id) => fixture.websites.get(id) || null },
    websiteLookup: async (id) => fixture.websites.get(id) || null,
  }));
  app.use(createSiteResourceBoundary({
    websiteRegistry: { getWebsite: async (id) => fixture.websites.get(id) || null },
    domainRegistry: { getDomain: async (id) => fixture.domains.get(id) || null },
    mailDomainRegistry: { getMailDomain: async (id) => fixture.mailDomains.get(id) || null },
    mailboxRegistry: { getMailbox: async (id) => fixture.mailboxes.get(id) || null },
    localServerId,
  }));

  mountMailboxRoutes(app, {
    mailboxRegistry: fixture.mailboxRegistry,
    mailDomainRegistry: fixture.mailDomainRegistry,
    domainRegistry: fixture.domainRegistry,
    mailDeleteFinalizeService: fixture.mockFinalizer,
    localServerId,
  });

  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    res.status(status).json({
      error: {
        code: error.code || 'internal_error',
        message: error.message,
      },
    });
  });

  return app;
}

const ownerAuth = Object.freeze({
  user: { id: 'owner', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

test('mailbox access preparation disables target mailbox while preserving enabled domain status', async (t) => {
  const fixture = createFixture();
  let currentAuth = ownerAuth;
  const app = createServer(fixture, () => currentAuth);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  // 1. Prepare access: disable target mailbox
  const response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 3, enabled: false }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.id, mailboxId);
  assert.equal(body.data.enabled, false);
  assert.equal(body.data.revision, 4);
  assert.deepEqual(body.sideEffects, { mailConfigurationChanged: false, mailDataChanged: false });

  // 2. Domain status remains enabled and untouched
  const domain = fixture.mailDomains.get(mailDomainId);
  assert.equal(domain.status, 'enabled');
  assert.equal(domain.revision, 4);

  // 3. Sibling mailbox remains enabled and untouched
  const sibling = fixture.mailboxes.get(siblingMailboxId);
  assert.equal(sibling.enabled, true);
  assert.equal(sibling.revision, 5);
});

test('mailbox access preparation rejects stale expectedRevision with 409', async (t) => {
  const fixture = createFixture();
  let currentAuth = ownerAuth;
  const app = createServer(fixture, () => currentAuth);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 99, enabled: false }),
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'stale_mailbox_revision');
});

test('mailbox access preparation rejects mass-assignment and extra fields with 400', async (t) => {
  const fixture = createFixture();
  let currentAuth = ownerAuth;
  const app = createServer(fixture, () => currentAuth);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  for (const payload of [
    { expectedRevision: 3, enabled: false, role: 'owner' },
    { expectedRevision: 3, enabled: false, password: 'new-password-123' },
    { expectedRevision: 3 },
    { enabled: false },
    {},
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'mailbox_update_input_invalid');
  }
});

test('mailbox access preparation rejects query parameters with 400', async (t) => {
  const fixture = createFixture();
  let currentAuth = ownerAuth;
  const app = createServer(fixture, () => currentAuth);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}?force=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 3, enabled: false }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'mailbox_query_invalid');
});

test('mailbox access preparation enforces tenant boundary across customer and site manager accounts', async (t) => {
  const fixture = createFixture();
  let currentAuth = null;
  const app = createServer(fixture, () => currentAuth);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  // 1. Read-only role rejected with 403
  currentAuth = {
    user: { id: 'reader', role: 'read_only' },
    access: { mode: 'read_only', permissions: ['mailboxes.read'] },
    security: { managementAllowed: false },
  };
  let response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 3, enabled: false }),
  });
  assert.equal(response.status, 403);

  // 2. Inactive account rejected with 403
  currentAuth = {
    user: { id: 'sm-inactive', role: 'site_manager', active: false, websiteIds: [websiteId] },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 3, enabled: false }),
  });
  assert.equal(response.status, 403);

  // 3. Foreign customer rejected with 403 when attempting to access local mailbox
  currentAuth = {
    user: { id: 'cust-foreign', role: 'customer', hosting: { kind: 'customer' }, active: true, websiteIds: [foreignWebsiteId] },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 3, enabled: false }),
  });
  assert.equal(response.status, 403);

  // 4. Authorized local customer succeeds
  currentAuth = {
    user: { id: 'cust-local', role: 'customer', hosting: { kind: 'customer' }, active: true, websiteIds: [websiteId] },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  response = await fetch(`http://127.0.0.1:${port}/api/mailboxes/${mailboxId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 3, enabled: false }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data.enabled, false);
});
