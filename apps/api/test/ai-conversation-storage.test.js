import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createAiConversationService } from '../src/ai-conversation-service.js';
import { createAiProviderRegistry } from '../src/ai-provider-registry.js';
import { createAiToolRegistry } from '../src/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore, csrfForSession } from '../src/auth-store.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import {
  computePublicKeyId, ENTITLEMENT_ISSUER, ENTITLEMENT_TOKEN_TYPE, YUNPANEL_PRODUCT_CODE,
} from '../src/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../src/license-entitlement-service.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const CONVERSATIONS = '/api/ai/conversations';

// Local crypto inputs exercise the real signature verifier and activation route;
// they do not claim a vendor-issued entitlement or live model acceptance.
function signedEntitlement(privateKey, kid, instanceId) {
  const now = Math.floor(Date.now() / 1000);
  const domain = 'panel.example.test';
  const header = { alg: 'EdDSA', crv: 'Ed25519', typ: ENTITLEMENT_TOKEN_TYPE, kid };
  const payload = {
    iss: ENTITLEMENT_ISSUER, sub: 'lic_conversations', licenseId: 'lic_conversations',
    jti: randomUUID(), iat: now, nbf: now, exp: now + 30 * 86400,
    productCode: YUNPANEL_PRODUCT_CODE, billingModel: 'monthly_term',
    periodMonths: 1, status: 'active', domain, normalizedDomain: domain,
    allowedHosts: [domain, 'www.' + domain], stagingHosts: ['localhost', '127.0.0.1'],
    startsAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date((now + 30 * 86400) * 1000).toISOString(),
    entitlementVersion: 1, activatedInstanceId: instanceId, edition: 'premium',
    capabilities: {
      singlePanelUser: true, singlePanelUserUnlimitedSites: true,
      webStackManagement: true, sslAndDnsManagement: true, backupsAndMonitoring: true,
      aiOperations: true, resellerAccounts: true, perSiteIsolatedUsers: true,
    },
  };
  const message = Buffer.from(JSON.stringify(header)).toString('base64url') + '.'
    + Buffer.from(JSON.stringify(payload)).toString('base64url');
  return message + '.' + sign(null, Buffer.from(message), privateKey).toString('base64url');
}

function error(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.body.error.code, code);
}

async function withConversationApi(action) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-history-http-'));
  let authStore;
  let server;
  const origin = 'http://127.0.0.1:4173';
  const ownerPassword = randomBytes(24).toString('base64url') + '!9aA';
  try {
    authStore = createAuthStore({
      filePath: path.join(directory, 'auth.sqlite'),
      masterKey: randomBytes(32).toString('hex'),
    });
    const setup = authStore.issueSetupToken();
    const owner = await authStore.completeSetup({
      setupToken: setup.token, username: 'history-owner', password: ownerPassword,
    });
    const registry = createServerRegistry({ filePath: path.join(directory, 'servers.json') });
    const localServer = await registry.createLocalServer({ hostname: 'panel.example.test' });
    const applicationRegistry = createApplicationRegistry({
      filePath: path.join(directory, 'applications.json'),
      serverExists: async (id) => Boolean(await registry.getServer(id)),
    });
    const websiteRegistry = createWebsiteRegistry({
      filePath: path.join(directory, 'websites.json'),
      serverExists: async (id) => Boolean(await registry.getServer(id)),
      getApplication: (id) => applicationRegistry.getApplication(id),
    });
    const domainRegistry = createDomainRegistry({
      filePath: path.join(directory, 'domains.json'),
      serverExists: async (id) => Boolean(await registry.getServer(id)),
      getWebsite: (id) => websiteRegistry.getWebsite(id),
    });
    const websites = [];
    for (const name of ['A', 'B']) {
      const application = await applicationRegistry.createApplication({
        serverId: localServer.id, name: 'Conversation ' + name,
        repositoryUrl: null, branch: null,
        build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
      });
      websites.push(await websiteRegistry.createWebsite({
        serverId: localServer.id, name: 'Conversation ' + name, applicationId: application.id,
      }));
    }
    const keys = generateKeyPairSync('ed25519');
    const kid = computePublicKeyId(keys.publicKey.export({ format: 'der', type: 'spki' }));
    const license = createLicenseEntitlementService({
      filePath: path.join(directory, 'license.json'),
      publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      publicKeyFile: '', publicOrigin: origin, instanceId: localServer.id,
      masterKey: randomBytes(32).toString('hex'), development: true,
    });
    const aiToolRegistry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
    const aiProviderRegistry = createAiProviderRegistry({
      filePath: path.join(directory, 'providers.json'), masterKey: randomBytes(32).toString('hex'),
    });
    const historyPath = path.join(directory, 'history.json');
    let baseUrl;
    async function start() {
      const conversationService = createAiConversationService({
        filePath: historyPath, providerRegistry: aiProviderRegistry, toolRegistry: aiToolRegistry,
        websiteRegistry, domainRegistry, applicationRegistry,
      });
      const handler = createAuthenticatedApi({
        store: authStore, publicOrigin: origin, development: true, ownerMfaRequired: false,
        licenseEntitlementService: license,
        createHandler: () => createApp({
          registry, applicationRegistry, websiteRegistry, domainRegistry,
          localServerId: localServer.id, userAdminStore: authStore.users, authStore,
          aiToolRegistry, aiAudit: authStore.audit, aiProviderRegistry,
          aiConversationService: conversationService, licenseEntitlementService: license,
        }),
      });
      server = http.createServer(handler);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      baseUrl = 'http://127.0.0.1:' + server.address().port;
    }
    async function stop() {
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise((resolve, reject) => closing.close((cause) => cause ? reject(cause) : resolve()));
    }
    async function login(username, password) {
      const response = await fetch(baseUrl + '/api/auth/login', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      await response.json();
      const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0])
        .find((value) => value.startsWith('yunpanel_session='));
      assert.ok(cookie);
      return { cookie, csrf: csrfForSession(cookie.slice(cookie.indexOf('=') + 1)) };
    }
    async function request(session, pathname, { method = 'GET', body, csrf = true, headers: extra = {} } = {}) {
      const headers = { ...extra };
      if (session) headers.Cookie = session.cookie;
      if (!['GET', 'HEAD'].includes(method)) {
        headers.Origin = origin;
        if (csrf && session) headers['x-csrf-token'] = session.csrf;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(baseUrl + pathname, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }
    await start();
    const ownerSession = await login('history-owner', ownerPassword);
    async function activate() {
      const result = await request(ownerSession, '/api/panel/license/activate', {
        method: 'POST', body: { token: signedEntitlement(keys.privateKey, kid, localServer.id) },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.data.valid, true);
      assert.equal(result.body.data.capabilities.aiOperations, true);
    }
    async function createUser(username, role, websiteIds) {
      const password = randomBytes(24).toString('base64url') + '!9aA';
      const result = await request(ownerSession, '/api/panel/users', {
        method: 'POST', body: { username, password, role, ...(websiteIds ? { websiteIds } : {}) },
      });
      assert.equal(result.status, 201);
      return { user: result.body.data.user, session: await login(username, password), username, password };
    }
    await action({
      request, owner, ownerSession, websites, historyPath, directory, activate, createUser, login,
      restart: async () => { await stop(); await start(); },
    });
    await stop();
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    authStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// Scenario matrix: actual file persistence/reopen; V1 parser+backup input; native
// Owner migration/rollback; paging/100-limit; corrupt/conflicting files fail503.
// No provider is configured, replaced or called; inference success is unverified.
test('real HTTP conversation storage preserves migration, paging, limits and failed bytes without a model', { timeout: 15000 }, async () => {
  await withConversationApi(async ({ request, owner, ownerSession, websites, historyPath, activate, createUser, restart }) => {
    await activate();
    const create = async (title) => {
      const result = await request(ownerSession, CONVERSATIONS, { method: 'POST', body: { title, websiteId: websites[0].id } });
      assert.equal(result.status, 201);
      return result.body.data;
    };
    const originalConversation = await create('Preserved history');
    const nativeRecord = JSON.parse(await readFile(historyPath, 'utf8')).conversations[0];
    // A real saved record supplies the format-compatibility input. Removing its
    // ownership field represents V1, not a manufactured server/provider result.
    const legacy = { ...nativeRecord };
    delete legacy.actorId;
    const original = JSON.stringify({ version: 1, conversations: [legacy] });
    await writeFile(historyPath, original);
    let result = await request(ownerSession, CONVERSATIONS + '?limit=10');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.legacyUnassigned, true);
    error(await request(ownerSession, CONVERSATIONS + '/' + originalConversation.id), 404, 'conversation_not_found');
    error(await request(ownerSession, CONVERSATIONS + '/' + originalConversation.id, { method: 'DELETE' }), 404, 'conversation_not_found');
    const created = await create('Owner history');
    assert.equal(created.actorId, undefined);
    assert.equal(await readFile(historyPath + '.v1-backup', 'utf8'), original);
    assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(historyPath + '.v1-backup')).mode & 0o777, 0o600);
    let stored = JSON.parse(await readFile(historyPath, 'utf8'));
    assert.equal(stored.version, 2);
    assert.equal(stored.conversations.find((item) => item.id === created.id).actorId, owner.id);
    assert.deepEqual(stored.conversations.find((item) => item.id === legacy.id).messages, nativeRecord.messages);

    // Assign to a different real authenticated actor: using the requester as
    // the target would violate all three readback/rollback checks below.
    const recipient = await createUser('history-recipient', 'site_manager', [websites[0].id]);
    assert.notEqual(recipient.user.id, owner.id);
    const assignments = [{ conversationId: legacy.id, targetActorId: recipient.user.id }];
    error(await request(ownerSession, CONVERSATIONS + '/unowned/migrate', {
      method: 'POST', body: { assignments: [...assignments, ...assignments] },
    }), 400, 'invalid_migration_assignments');
    result = await request(ownerSession, CONVERSATIONS + '/unowned/migrate', { method: 'POST', body: { assignments } });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.count, 1);
    error(await request(ownerSession, CONVERSATIONS + '/' + legacy.id), 404, 'conversation_not_found');
    result = await request(recipient.session, CONVERSATIONS + '/' + legacy.id);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.id, legacy.id);
    assert.equal(result.body.data.title, nativeRecord.title);
    stored = JSON.parse(await readFile(historyPath, 'utf8'));
    assert.equal(stored.conversations.find((item) => item.id === legacy.id).actorId, recipient.user.id);
    error(await request(ownerSession, CONVERSATIONS + '/unowned/migrate', { method: 'POST', body: { assignments } }), 409, 'conversation_already_owned');
    error(await request(recipient.session, CONVERSATIONS + '/unowned/rollback', {
      method: 'POST', body: { conversationIds: [legacy.id] },
    }), 403, 'forbidden');
    error(await request(ownerSession, CONVERSATIONS + '/unowned/rollback', {
      method: 'POST', body: { conversationIds: [legacy.id, legacy.id] },
    }), 400, 'invalid_rollback_request');
    result = await request(ownerSession, CONVERSATIONS + '/unowned/rollback', {
      method: 'POST', body: { conversationIds: [legacy.id] },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.count, 1);
    error(await request(recipient.session, CONVERSATIONS + '/' + legacy.id), 404, 'conversation_not_found');
    error(await request(ownerSession, CONVERSATIONS + '/' + legacy.id), 404, 'conversation_not_found');
    result = await request(ownerSession, CONVERSATIONS + '/unowned/rollback', { method: 'POST', body: { restoreV1Backup: true } });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.restoredCount, 1);

    // All24 actual HTTP requests overlap against the same file-backed store.
    const parallel = await Promise.all(Array.from({ length: 24 }, (_, i) => create('Concurrent history ' + i)));
    const parallelIds = parallel.map((item) => item.id);
    assert.equal(new Set(parallelIds).size, 24);
    const concurrentStored = JSON.parse(await readFile(historyPath, 'utf8')).conversations;
    const actualOwnerIds = concurrentStored.filter((item) => item.actorId === owner.id).map((item) => item.id);
    assert.deepEqual(actualOwnerIds.sort(), [created.id, ...parallelIds].sort());
    await restart();
    result = await request(ownerSession, CONVERSATIONS);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.map((item) => item.id).sort(), actualOwnerIds);
    const ids = [created.id, ...parallelIds];
    for (let i = 0; i < 75; i++) ids.push((await create('History ' + i)).id);
    assert.equal(new Set(ids).size, 100);
    const beforeLimit = await readFile(historyPath, 'utf8');
    error(await request(ownerSession, CONVERSATIONS, { method: 'POST', body: { title: 'Beyond limit' } }), 409, 'ai_conversation_limit');
    assert.equal(await readFile(historyPath, 'utf8'), beforeLimit);
    error(await request(ownerSession, CONVERSATIONS + '/unowned/migrate', {
      method: 'POST', body: { assignments: [{ conversationId: legacy.id, targetActorId: owner.id }] },
    }), 409, 'ai_conversation_limit');
    await restart();
    let cursor = null;
    const observed = [];
    do {
      result = await request(ownerSession, CONVERSATIONS + '?limit=10' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      assert.equal(result.status, 200);
      observed.push(...result.body.data.items.map((item) => item.id));
      cursor = result.body.data.nextCursor;
    } while (cursor);
    assert.deepEqual(observed.sort(), ids.sort());
    result = await request(ownerSession, CONVERSATIONS + '/' + created.id, { method: 'DELETE' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.success, true);
    await restart();
    error(await request(ownerSession, CONVERSATIONS + '/' + created.id), 404, 'conversation_not_found');

    // Actual malformed input and an actual exclusive-backup conflict must not
    // replace or silently repair either file.
    await writeFile(historyPath, '{broken');
    error(await request(ownerSession, CONVERSATIONS), 503, 'ai_history_store_unavailable');
    error(await request(ownerSession, CONVERSATIONS, { method: 'POST', body: { title: 'No overwrite' } }), 503, 'ai_history_store_unavailable');
    assert.equal(await readFile(historyPath, 'utf8'), '{broken');
    await writeFile(historyPath, original + ' ');
    await restart();
    error(await request(ownerSession, CONVERSATIONS, { method: 'POST', body: { title: 'Conflicting backup' } }), 503, 'ai_history_store_unavailable');
    assert.equal(await readFile(historyPath, 'utf8'), original + ' ');
    assert.equal(await readFile(historyPath + '.v1-backup', 'utf8'), original);
    error(await request(ownerSession, CONVERSATIONS), 503, 'ai_history_store_unavailable');
  });
});

// Scenario matrix: native session/CSRF/license middleware, per-actor and Website
// isolation, Owner-only history administration, live grant/session revocation,
// and real provider-not-configured failure; no provider success is simulated.
test('real HTTP conversations enforce native auth, license and ownership before provider access', { timeout: 15000 }, async () => {
  await withConversationApi(async ({ request, owner, ownerSession, websites, historyPath, activate, createUser, login }) => {
    error(await request(null, CONVERSATIONS), 401, 'unauthorized');
    error(await request(ownerSession, CONVERSATIONS), 403, 'premium_license_required');
    error(await request(ownerSession, CONVERSATIONS, { method: 'POST', body: { title: 'Free denied' } }), 403, 'premium_license_required');
    await assert.rejects(readFile(historyPath), { code: 'ENOENT' });
    await activate();
    const manager = await createUser('history-manager', 'site_manager', [websites[0].id]);
    const auditor = await createUser('history-auditor', 'read_only');
    error(await request(auditor.session, CONVERSATIONS), 403, 'forbidden');
    error(await request(ownerSession, CONVERSATIONS, { method: 'POST', csrf: false, body: { title: 'No CSRF' } }), 403, 'csrf_invalid');

    let result = await request(ownerSession, CONVERSATIONS, { method: 'POST', body: { title: 'Owner only', websiteId: websites[0].id } });
    assert.equal(result.status, 201);
    const conversation = result.body.data;
    result = await request(ownerSession, CONVERSATIONS);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.map((item) => item.id), [conversation.id]);
    result = await request(ownerSession, CONVERSATIONS + '?limit=20');
    assert.equal(result.body.data.scope.actorId, owner.id);
    assert.equal(result.body.data.items.length, 1);
    result = await request(manager.session, CONVERSATIONS + '?limit=20');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.items.length, 0);
    for (const query of ['actorId=' + owner.id, 'limit=20&limit=10', 'limit=51', 'limit=20oops', 'websiteId=x&websiteId=y', 'cursor=invalid']) {
      const invalid = await request(ownerSession, CONVERSATIONS + '?' + query);
      assert.equal(invalid.status, 400);
    }
    error(await request(manager.session, CONVERSATIONS, {
      method: 'POST', body: { title: 'Spoof', actorId: owner.id },
    }), 403, 'forbidden');
    error(await request(manager.session, CONVERSATIONS, {
      headers: { 'x-actor-id': owner.id },
    }), 403, 'forbidden');
    error(await request(ownerSession, CONVERSATIONS, {
      method: 'POST', body: { title: 'Unknown site', websiteId: randomUUID() },
    }), 404, 'conversation_not_found');
    error(await request(manager.session, CONVERSATIONS, {
      method: 'POST', body: { title: 'Other site', websiteId: websites[1].id },
    }), 404, 'conversation_not_found');
    error(await request(manager.session, CONVERSATIONS, {
      method: 'POST', body: { title: 'Global' },
    }), 403, 'forbidden');
    for (const method of ['GET', 'DELETE']) {
      error(await request(manager.session, CONVERSATIONS + '/' + conversation.id, { method }), 404, 'conversation_not_found');
    }
    const beforeMessages = await readFile(historyPath, 'utf8');
    for (const suffix of ['/messages', '/messages/stream']) {
      error(await request(manager.session, CONVERSATIONS + '/' + conversation.id + suffix, {
        method: 'POST', body: { text: 'Foreign actor' },
      }), 404, 'conversation_not_found');
      error(await request(ownerSession, CONVERSATIONS + '/' + conversation.id + suffix, {
        method: 'POST', body: { text: '' },
      }), 400, 'invalid_message_text');
      error(await request(ownerSession, CONVERSATIONS + '/' + conversation.id + suffix, {
        method: 'POST', body: { text: 'No provider configured' },
      }), 503, 'ai_provider_not_configured');
    }
    assert.equal(await readFile(historyPath, 'utf8'), beforeMessages);
    for (const [pathname, method, body] of [
      ['/unowned', 'GET', undefined],
      ['/unowned/migrate', 'POST', { assignments: [] }],
      ['/unowned/rollback', 'POST', { conversationIds: [] }],
    ]) error(await request(manager.session, CONVERSATIONS + pathname, { method, body }), 403, 'forbidden');

    result = await request(manager.session, CONVERSATIONS, {
      method: 'POST', body: { title: 'Manager private', websiteId: websites[0].id },
    });
    assert.equal(result.status, 201);
    const managerConversation = result.body.data;
    error(await request(ownerSession, CONVERSATIONS + '/' + managerConversation.id), 404, 'conversation_not_found');
    result = await request(ownerSession, '/api/panel/users/' + manager.user.id, {
      method: 'PATCH', body: { revision: manager.user.revision, websiteIds: [websites[1].id] },
    });
    assert.equal(result.status, 200);
    error(await request(manager.session, CONVERSATIONS), 401, 'unauthorized');
    const changedSession = await login(manager.username, manager.password);
    error(await request(changedSession, CONVERSATIONS + '/' + managerConversation.id), 404, 'conversation_not_found');
    result = await request(changedSession, CONVERSATIONS + '?limit=20');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.items.length, 0);
    result = await request(changedSession, '/api/auth/logout', { method: 'POST' });
    assert.equal(result.status, 204);
    error(await request(changedSession, CONVERSATIONS), 401, 'unauthorized');
    result = await request(ownerSession, CONVERSATIONS + '/' + conversation.id, { method: 'DELETE' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.success, true);
  });
});
