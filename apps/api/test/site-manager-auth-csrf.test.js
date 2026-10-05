import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createServerRegistry } from '../src/server-registry.js';

const origin = 'https://panel.example.test';
const CSRF_OWNER = 'csrf-owner-secret-token-123';
const CSRF_SM1 = 'csrf-sm1-secret-token-456';
const CSRF_SM2 = 'csrf-sm2-secret-token-789';
const CSRF_INACTIVE = 'csrf-inactive-token-000';

function createFixtureStore() {
  const sessions = {
    'owner-token': {
      id: 'session-owner-uuid',
      user: { id: 'owner-id', username: 'owner-user', role: 'owner', active: true },
      csrfToken: CSRF_OWNER,
      expiresAt: Date.now() + 60_000,
      idleExpiresAt: Date.now() + 60_000,
    },
    'sm1-token': {
      id: 'session-sm1-uuid',
      user: { id: 'sm1-id', username: 'sm1-user', role: 'site_manager', websiteIds: ['site-1'], active: true },
      csrfToken: CSRF_SM1,
      expiresAt: Date.now() + 60_000,
      idleExpiresAt: Date.now() + 60_000,
    },
    'sm2-token': {
      id: 'session-sm2-uuid',
      user: { id: 'sm2-id', username: 'sm2-user', role: 'site_manager', websiteIds: ['site-2'], active: true },
      csrfToken: CSRF_SM2,
      expiresAt: Date.now() + 60_000,
      idleExpiresAt: Date.now() + 60_000,
    },
    'sm-inactive-token': {
      id: 'session-inactive-uuid',
      user: { id: 'sm-inactive-id', username: 'sm-inactive-user', role: 'site_manager', websiteIds: ['site-1'], active: false },
      csrfToken: CSRF_INACTIVE,
      expiresAt: Date.now() + 60_000,
      idleExpiresAt: Date.now() + 60_000,
    },
  };

  return {
    configured: () => true,
    mfa: {
      enabled: (userId) => userId === 'owner-id',
      status: () => ({ enabled: true }),
    },
    getSession: (token) => sessions[token] ?? null,
    listSessions: () => Object.values(sessions),
    audit: {
      record() { return {}; },
      list() { return { events: [], total: 0, offset: 0, limit: 50 }; },
    },
  };
}

async function createServerFixture(t) {
  const serverRegistry = createServerRegistry();
  const localServerRecord = await serverRegistry.createLocalServer({ hostname: 'local-test-server' });
  const serverId = localServerRecord.id;

  const websites = [
    { id: 'site-1', serverId, applicationId: 'app-1', name: 'Site One', domain: 'site1.example.test' },
    { id: 'site-2', serverId, applicationId: 'app-2', name: 'Site Two', domain: 'site2.example.test' },
  ];
  const domains = [
    { id: 'domain-1', websiteId: 'site-1', serverId, hostname: 'site1.example.test' },
    { id: 'domain-2', websiteId: 'site-2', serverId, hostname: 'site2.example.test' },
  ];
  const bindings = [
    { id: 'binding-1', websiteId: 'site-1', serverId, applicationId: 'app-1', databaseName: 'db_site1', unixUser: 'user_1', revision: 1 },
    { id: 'binding-2', websiteId: 'site-2', serverId, applicationId: 'app-2', databaseName: 'db_site2', unixUser: 'user_2', revision: 1 },
  ];
  const credentials = [
    {
      id: 'cred-1', databaseBindingId: 'binding-1', websiteId: 'site-1', serverId, applicationId: 'app-1',
      databaseName: 'db_site1', siteUnixUser: 'user_1', username: 'user_1', host: 'localhost',
      privileges: ['SELECT'], revision: 1, passwordConfigured: true, passwordUpdatedAt: new Date().toISOString(),
    },
    {
      id: 'cred-2', databaseBindingId: 'binding-2', websiteId: 'site-2', serverId, applicationId: 'app-2',
      databaseName: 'db_site2', siteUnixUser: 'user_2', username: 'user_2', host: 'localhost',
      privileges: ['SELECT'], revision: 1, passwordConfigured: true, passwordUpdatedAt: new Date().toISOString(),
    },
  ];
  const mailDomains = [
    { id: 'mail-1', webDomainId: 'domain-1', serverId, managementMode: 'local' },
    { id: 'mail-2', webDomainId: 'domain-2', serverId, managementMode: 'local' },
  ];
  const mailboxes = [
    { id: 'box-1', mailDomainId: 'mail-1', localPart: 'user1' },
    { id: 'box-2', mailDomainId: 'mail-2', localPart: 'user2' },
  ];
  const mailAliases = [
    { id: 'alias-1', mailDomainId: 'mail-1', source: 'alias1@site1.example.test' },
    { id: 'alias-2', mailDomainId: 'mail-2', source: 'alias2@site2.example.test' },
  ];
  const jobs = [
    { id: 'job-1', serverId, resourceType: 'database', resourceId: 'db_site1', status: 'succeeded' },
  ];

  const lookup = (items) => async (id) => items.find((item) => item.id === id) ?? null;

  const websiteRegistry = {
    getWebsite: lookup(websites),
    listWebsites: async () => websites,
    createWebsite: async (spec) => ({ id: 'new-site', ...spec }),
    previewWebsiteUpdate: async () => ({}),
    updateWebsite: async () => ({}),
    createMigrationWebsite: async () => ({}),
    deleteMigrationWebsite: async () => ({}),
  };
  const domainRegistry = {
    getDomain: lookup(domains),
    listDomains: async () => domains,
    bindWebsite: async () => ({}),
    rollbackWebsiteBinding: async () => ({}),
  };
  const databaseBindingRegistry = {
    getBinding: lookup(bindings),
    listBindings: async (options = {}) => {
      let result = bindings;
      if (options.serverId) result = result.filter((b) => b.serverId === options.serverId);
      if (options.websiteId) result = result.filter((b) => b.websiteId === options.websiteId);
      return result;
    },
    getByDatabase: async (srvId, dbName) => bindings.find((b) => b.serverId === srvId && b.databaseName === dbName) ?? null,
    bindDatabase: async () => ({}),
    unbindDatabase: async () => ({}),
  };
  const databaseCredentialRegistry = {
    getCredential: lookup(credentials),
    getForBinding: async (bindingId) => credentials.find((c) => c.databaseBindingId === bindingId) ?? null,
    listCredentials: async (options = {}) => {
      let result = credentials;
      if (options.serverId) result = result.filter((c) => c.serverId === options.serverId);
      if (options.websiteId) result = result.filter((c) => c.websiteId === options.websiteId);
      return result;
    },
    createCredential: async (spec) => ({ id: 'new-cred', ...spec }),
    setPrivileges: async () => ({}),
    rotatePassword: async () => ({}),
    deleteCredential: async () => ({}),
  };
  const databaseCredentialApplyService = {
    previewApply: async () => ({}),
    queueApply: async () => ({}),
    previewDelete: async () => ({}),
    queueDelete: async () => ({}),
  };
  const mailDomainRegistry = {
    getMailDomain: lookup(mailDomains),
    listMailDomains: async () => mailDomains,
    createMailDomain: async (spec) => ({ id: 'new-mail-domain', ...spec }),
  };
  const mailboxRegistry = {
    getMailbox: lookup(mailboxes),
    listMailboxes: async (options = {}) => {
      if (options.mailDomainId) return mailboxes.filter((m) => m.mailDomainId === options.mailDomainId);
      return mailboxes;
    },
    createMailbox: async (spec) => ({ id: 'new-mailbox', ...spec }),
    rotatePassword: async (id) => ({ id, success: true }),
    setEnabled: async (id, enabled) => ({ id, enabled }),
    deleteMailbox: async (id) => ({ id, deleted: true }),
    materializeEnabledAccounts: async () => [],
  };
  const mailAliasRegistry = {
    getAlias: lookup(mailAliases),
    listAliases: async (options = {}) => {
      if (options.mailDomainId) return mailAliases.filter((a) => a.mailDomainId === options.mailDomainId);
      return mailAliases;
    },
    createAlias: async (spec) => ({ id: 'new-alias', ...spec }),
    updateAlias: async (id, patch) => ({ id, ...patch }),
    deleteAlias: async (id) => ({ id, deleted: true }),
    materializeEnabledAliases: async () => [],
  };
  const jobRegistry = {
    getJob: lookup(jobs),
    listJobs: async () => jobs,
    enqueue: async (job) => ({ id: 'enqueued-job-id', ...job, status: 'queued' }),
  };

  const siteFileManager = {
    execute: async (websiteId, op) => ({ websiteId, operation: op.operation, success: true }),
  };

  const store = createFixtureStore();

  const listener = createAuthenticatedApi({
    store,
    publicOrigin: origin,
    ownerMfaRequired: false,
    createHandler: () => createApp({
      registry: serverRegistry,
      localServerId: serverId,
      websiteRegistry,
      domainRegistry,
      databaseBindingRegistry,
      databaseCredentialRegistry,
      databaseCredentialApplyService,
      mailDomainRegistry,
      mailboxRegistry,
      mailAliasRegistry,
      jobRegistry,
      siteFileManager,
      mailConfigurationService: {
        preview: async () => ({}),
        apply: async () => ({}),
        previewTransition: async () => ({}),
      },
      mailDeleteImpactService: {
        inspectMailbox: async () => ({}),
        inspectMailDomain: async () => ({}),
      },
      mailDeleteFinalizeService: {
        finalizeMailbox: async () => ({}),
        finalizeMailDomain: async () => ({}),
      },
      mailDataOperationsService: {
        previewBackup: async () => ({}),
        queueBackup: async () => ({}),
        previewRestore: async () => ({}),
        queueRestore: async () => ({}),
        previewDelete: async () => ({}),
        queueDelete: async () => ({}),
      },
      environment: 'production',
    }),
  });

  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const request = (path, { method = 'GET', token = null, csrf = null, reqOrigin = null, body = null, headers = {} } = {}) => {
    const finalHeaders = { ...headers };
    if (token) {
      finalHeaders.cookie = `__Host-yunpanel_session=${token}`;
    }
    if (csrf !== undefined && csrf !== null) {
      finalHeaders['x-csrf-token'] = csrf;
    }
    if (reqOrigin) {
      finalHeaders.origin = reqOrigin;
    }
    if (body !== null && typeof body === 'object') {
      finalHeaders['content-type'] = 'application/json';
    }
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  };

  return { request, serverId };
}

test('Express + Auth + CSRF chain: unauthenticated requests are rejected with 401', async (t) => {
  const { request } = await createServerFixture(t);

  const res1 = await request('/api/websites');
  assert.equal(res1.status, 401);
  const data1 = await res1.json();
  assert.equal(data1.error.code, 'unauthorized');

  const res2 = await request('/api/websites/site-1/files', { method: 'GET' });
  assert.equal(res2.status, 401);

  const res3 = await request('/api/websites/site-1/files/file', {
    method: 'POST',
    reqOrigin: origin,
    body: { path: 'test.txt' },
  });
  assert.equal(res3.status, 401);
});

test('Express + Auth + CSRF chain: CSRF and Origin checks protect mutations with 403', async (t) => {
  const { request } = await createServerFixture(t);

  // Missing CSRF token
  const resNoCsrf = await request('/api/websites/site-1/files/file', {
    method: 'POST',
    token: 'owner-token',
    reqOrigin: origin,
    body: { path: 'test.txt' },
  });
  assert.equal(resNoCsrf.status, 403);
  assert.equal((await resNoCsrf.json()).error.code, 'csrf_invalid');

  // Wrong CSRF token
  const resWrongCsrf = await request('/api/websites/site-1/files/file', {
    method: 'POST',
    token: 'owner-token',
    csrf: 'wrong-token',
    reqOrigin: origin,
    body: { path: 'test.txt' },
  });
  assert.equal(resWrongCsrf.status, 403);
  assert.equal((await resWrongCsrf.json()).error.code, 'csrf_invalid');

  // Wrong Origin
  const resWrongOrigin = await request('/api/websites/site-1/files/file', {
    method: 'POST',
    token: 'owner-token',
    csrf: CSRF_OWNER,
    reqOrigin: 'https://attacker.example.evil',
    body: { path: 'test.txt' },
  });
  assert.equal(resWrongOrigin.status, 403);
  assert.equal((await resWrongOrigin.json()).error.code, 'origin_forbidden');

  // Valid session, valid CSRF and valid Origin succeeds
  const resValid = await request('/api/websites/site-1/files/file', {
    method: 'POST',
    token: 'owner-token',
    csrf: CSRF_OWNER,
    reqOrigin: origin,
    body: { path: 'test.txt' },
  });
  assert.equal(resValid.status, 201);
});

test('Express + Auth chain: Owner has global access across all sites and services', async (t) => {
  const { request, serverId } = await createServerFixture(t);

  // Owner lists websites and sees both
  const resWebsites = await request('/api/websites', { token: 'owner-token' });
  assert.equal(resWebsites.status, 200);
  const websitesBody = await resWebsites.json();
  assert.equal(websitesBody.data.length, 2);

  // Owner accesses site-1 and site-2 files
  assert.equal((await request('/api/websites/site-1/files', { token: 'owner-token' })).status, 200);
  assert.equal((await request('/api/websites/site-2/files', { token: 'owner-token' })).status, 200);

  // Owner accesses global databases
  assert.equal((await request(`/api/servers/${serverId}/databases`, { token: 'owner-token' })).status, 200);

  // Owner accesses audit history
  assert.equal((await request('/api/audit', { token: 'owner-token' })).status, 200);
});

test('Express + Auth chain: Site Manager 1 is isolated to site-1 and fail-closed against site-2 and global resources', async (t) => {
  const { request, serverId } = await createServerFixture(t);

  // SM1 allowed on site-1 files
  const sm1Files = await request('/api/websites/site-1/files', { token: 'sm1-token' });
  assert.equal(sm1Files.status, 200);

  // SM1 allowed on site-1 database resources
  const sm1DbRes = await request(`/api/servers/${serverId}/websites/site-1/database-resources`, { token: 'sm1-token' });
  assert.equal(sm1DbRes.status, 200);

  // SM1 allowed on site-1 mailboxes
  const sm1Mailboxes = await request('/api/mailboxes?mailDomainId=mail-1', { token: 'sm1-token' });
  assert.equal(sm1Mailboxes.status, 200);

  // SM1 allowed to mutate own site file with CSRF
  const sm1FileMutation = await request('/api/websites/site-1/files/file', {
    method: 'POST',
    token: 'sm1-token',
    csrf: CSRF_SM1,
    reqOrigin: origin,
    body: { path: 'sm1-test.txt' },
  });
  assert.equal(sm1FileMutation.status, 201);

  // FAIL-CLOSED: SM1 blocked from site-2 files (read & write)
  const sm1CrossFile = await request('/api/websites/site-2/files', { token: 'sm1-token' });
  assert.equal(sm1CrossFile.status, 403);
  const sm1CrossFileMut = await request('/api/websites/site-2/files/file', {
    method: 'POST',
    token: 'sm1-token',
    csrf: CSRF_SM1,
    reqOrigin: origin,
    body: { path: 'attack.txt' },
  });
  assert.equal(sm1CrossFileMut.status, 403);

  // FAIL-CLOSED: SM1 blocked from site-2 database resources
  const sm1CrossDbRes = await request(`/api/servers/${serverId}/websites/site-2/database-resources`, { token: 'sm1-token' });
  assert.equal(sm1CrossDbRes.status, 403);

  // FAIL-CLOSED: SM1 blocked from site-2 database credential actions
  const sm1CrossCred = await request(`/api/servers/${serverId}/database-credentials/cred-2/password/rotate`, {
    method: 'POST',
    token: 'sm1-token',
    csrf: CSRF_SM1,
    reqOrigin: origin,
    body: {},
  });
  assert.equal(sm1CrossCred.status, 403);

  // FAIL-CLOSED: SM1 blocked from site-2 mail domain and mailboxes
  assert.equal((await request('/api/mailboxes?mailDomainId=mail-2', { token: 'sm1-token' })).status, 403);
  assert.equal((await request('/api/mailboxes/box-2', { token: 'sm1-token' })).status, 403);

  // FAIL-CLOSED: SM1 blocked from global / owner-only resources
  assert.equal((await request(`/api/servers/${serverId}/databases`, { token: 'sm1-token' })).status, 403);
  assert.equal((await request(`/api/servers/${serverId}/database-bindings`, { token: 'sm1-token' })).status, 403);
  assert.equal((await request('/api/mail/queue', { token: 'sm1-token' })).status, 403);
  assert.equal((await request('/api/roundcube/config', { token: 'sm1-token' })).status, 403);
  assert.equal((await request(`/api/servers/${serverId}/system/packages`, { token: 'sm1-token' })).status, 403);
  assert.equal((await request('/api/audit', { token: 'sm1-token' })).status, 403);
});

test('Express + Auth chain: Site Manager 2 is isolated to site-2 and fail-closed against site-1', async (t) => {
  const { request, serverId } = await createServerFixture(t);

  // SM2 allowed on site-2 files
  assert.equal((await request('/api/websites/site-2/files', { token: 'sm2-token' })).status, 200);

  // SM2 allowed on site-2 database resources
  assert.equal((await request(`/api/servers/${serverId}/websites/site-2/database-resources`, { token: 'sm2-token' })).status, 200);

  // SM2 allowed on site-2 mailboxes
  assert.equal((await request('/api/mailboxes?mailDomainId=mail-2', { token: 'sm2-token' })).status, 200);

  // FAIL-CLOSED: SM2 blocked from site-1 files
  assert.equal((await request('/api/websites/site-1/files', { token: 'sm2-token' })).status, 403);

  // FAIL-CLOSED: SM2 blocked from site-1 database resources
  assert.equal((await request(`/api/servers/${serverId}/websites/site-1/database-resources`, { token: 'sm2-token' })).status, 403);

  // FAIL-CLOSED: SM2 blocked from site-1 mailboxes
  assert.equal((await request('/api/mailboxes?mailDomainId=mail-1', { token: 'sm2-token' })).status, 403);
});

test('Express + Auth chain: Inactive Site Manager account is blocked with fail-closed 403', async (t) => {
  const { request } = await createServerFixture(t);

  const resInactive = await request('/api/websites/site-1/files', { token: 'sm-inactive-token' });
  assert.equal(resInactive.status, 403);
  const data = await resInactive.json();
  assert.equal(data.error.code, 'site_scope_forbidden');
});
