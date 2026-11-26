import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLicenseEntitlementService,
  LicenseEntitlementError,
} from '../src/panel/license-entitlement-service.js';
import {
  mountWebsiteSftpKeyRoutes,
  WebsiteSftpKeyHttpError,
} from '../src/websites/website-sftp-key-http.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const keyId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

async function invoke(app, route, request) {
  const handlers = app.routes.get(route);
  assert.equal(handlers.length, 2, `${route} must keep the panel authorization guard`);
  const response = fakeResponse();
  let nextError = null;
  await handlers.at(-1)(request, response, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return response;
}

function service(calls) {
  const key = { id: keyId, label: 'Laptop', fingerprint: 'SHA256:safe', revision: 1 };
  return {
    list: async (id) => { calls.push(['list', id]); return { websiteId: id, keys: [key] }; },
    add: async (input) => { calls.push(['add', input]); return { key }; },
    revoke: async (input) => { calls.push(['revoke', input]); return { key: { ...key, status: 'revoked' } }; },
    rotate: async (input) => { calls.push(['rotate', input]); return { rotation: { created: key } }; },
    reconcile: async (id) => { calls.push(['reconcile', id]); return { satisfied: true, keyCount: 1 }; },
  };
}

test('Website SFTP key HTTP exposes guarded list/add/revoke/rotate/reconcile routes', async () => {
  const calls = [];
  const app = fakeApp();
  mountWebsiteSftpKeyRoutes(app, { sftpKeyService: service(calls) });

  const listed = await invoke(app, 'GET /api/websites/:websiteId/sftp/keys', {
    params: { websiteId },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(JSON.stringify(listed.payload).includes(publicKey), false);

  const added = await invoke(app, 'POST /api/websites/:websiteId/sftp/keys', {
    params: { websiteId }, body: { label: 'Laptop', publicKey },
  });
  assert.equal(added.statusCode, 201);

  await invoke(app, 'POST /api/websites/:websiteId/sftp/keys/:keyId/revoke', {
    params: { websiteId, keyId }, body: { expectedRevision: 1 },
  });
  await invoke(app, 'POST /api/websites/:websiteId/sftp/keys/:keyId/rotate', {
    params: { websiteId, keyId }, body: { expectedRevision: 1, label: 'Replacement', publicKey },
  });
  await invoke(app, 'POST /api/websites/:websiteId/sftp/keys/reconcile', {
    params: { websiteId }, body: {},
  });

  assert.deepEqual(calls, [
    ['list', websiteId],
    ['add', { websiteId, label: 'Laptop', publicKey }],
    ['revoke', { websiteId, keyId, expectedRevision: 1 }],
    ['rotate', { websiteId, keyId, expectedRevision: 1, label: 'Replacement', publicKey }],
    ['reconcile', websiteId],
  ]);
});

test('Website SFTP key HTTP rejects extra fields before service mutation', async () => {
  let called = false;
  const app = fakeApp();
  const sftpKeyService = service([]);
  sftpKeyService.add = async () => { called = true; return {}; };
  mountWebsiteSftpKeyRoutes(app, { sftpKeyService });

  await assert.rejects(
    invoke(app, 'POST /api/websites/:websiteId/sftp/keys', {
      params: { websiteId },
      body: { label: 'Laptop', publicKey, privateKey: 'must-not-enter-the-service' },
    }),
    (error) => error instanceof WebsiteSftpKeyHttpError
      && error.code === 'sftp_key_add_input_invalid',
  );
  assert.equal(called, false);

  await assert.rejects(
    invoke(app, 'POST /api/websites/:websiteId/sftp/keys/reconcile', {
      params: { websiteId }, body: { force: true },
    }),
    (error) => error instanceof WebsiteSftpKeyHttpError
      && error.code === 'sftp_key_reconcile_input_invalid',
  );
});

test('Website SFTP key HTTP allows Free Owner full SFTP maintenance while gating separate customer/reseller logins', async () => {
  const calls = [];
  const app = fakeApp();
  const freeLicenseService = createLicenseEntitlementService({
    filePath: ':memory:',
    publicKeyPem: '',
    publicKeyFile: '',
    publicOrigin: 'https://panel.example.test',
    development: false,
  });
  mountWebsiteSftpKeyRoutes(app, {
    sftpKeyService: service(calls),
    licenseEntitlementService: freeLicenseService,
  });

  const ownerAuth = { user: { id: 'owner-1', role: 'owner' } };
  const ownerAdd = await invoke(app, 'POST /api/websites/:websiteId/sftp/keys', {
    auth: ownerAuth,
    params: { websiteId },
    body: { label: 'OwnerKey', publicKey },
  });
  assert.equal(ownerAdd.statusCode, 201);

  const ownerRotate = await invoke(app, 'POST /api/websites/:websiteId/sftp/keys/:keyId/rotate', {
    auth: ownerAuth,
    params: { websiteId, keyId },
    body: { expectedRevision: 1, label: 'OwnerRotated', publicKey },
  });
  assert.equal(ownerRotate.statusCode, 200);

  const ownerReconcile = await invoke(app, 'POST /api/websites/:websiteId/sftp/keys/reconcile', {
    auth: ownerAuth,
    params: { websiteId },
    body: {},
  });
  assert.equal(ownerReconcile.statusCode, 200);

  // Separate site_manager / customer panel account requires perSiteIsolatedUsers
  const siteUserAuth = { user: { id: 'cust-1', role: 'site_manager', websiteIds: [websiteId] } };
  await assert.rejects(
    invoke(app, 'POST /api/websites/:websiteId/sftp/keys', {
      auth: siteUserAuth,
      params: { websiteId },
      body: { label: 'CustKey', publicKey },
    }),
    (error) => error instanceof LicenseEntitlementError
      && error.code === 'premium_license_required'
      && error.capability === 'perSiteIsolatedUsers',
  );

  // Separate reseller panel account requires resellerAccounts
  const resellerAuth = {
    user: { id: 'res-1', role: 'site_manager', hosting: { kind: 'reseller', resellerId: null }, websiteIds: [websiteId] },
  };
  await assert.rejects(
    invoke(app, 'POST /api/websites/:websiteId/sftp/keys/:keyId/rotate', {
      auth: resellerAuth,
      params: { websiteId, keyId },
      body: { expectedRevision: 1, label: 'ResKey', publicKey },
    }),
    (error) => error instanceof LicenseEntitlementError
      && error.code === 'premium_license_required'
      && error.capability === 'resellerAccounts',
  );
});
