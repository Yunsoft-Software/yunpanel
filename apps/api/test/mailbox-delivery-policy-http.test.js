import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createMailboxRegistry } from '../src/mailbox-registry.js';
import { createApp } from '../src/management-app.js';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';
import { createServerRegistry } from '../src/server-registry.js';

test('Owner delivery policy routes enforce auth, CSRF, revision and local mailbox scope', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-mail-delivery-policy-http-'));
  const masterKey = randomBytes(32);
  const store = createAuthStore({ filePath: path.join(directory, 'auth.sqlite'), masterKey });
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const password = randomBytes(24).toString('hex');
  const setup = store.issueSetupToken();
  await store.completeSetup({ setupToken: setup.token, username: 'owner', password });
  const owner = await store.login({ username: 'owner', password });
  const policy = createOwnerMfaPolicy({ store, required: false }).requireManagement;
  await store.users.create(owner.token, policy, {
    username: 'siteuser', password, role: 'site_manager', websiteIds: [randomUUID()],
  });
  await store.users.create(owner.token, policy, { username: 'reader', password, role: 'read_only' });

  const registry = createServerRegistry({ filePath: path.join(directory, 'servers.json') });
  const local = await registry.createLocalServer({ hostname: 'local-policy.example.test' });
  const { token } = await registry.issueEnrollmentToken({ label: 'other-policy' });
  const { server: other } = await registry.enrollServer({ token, hostname: 'other-policy.example.test' });
  const domainRegistry = createDomainRegistry({
    filePath: path.join(directory, 'domains.json'),
    serverExists: async id => Boolean(await registry.getServer(id)),
  });
  const mailDomainRegistry = createMailDomainRegistry({
    filePath: path.join(directory, 'mail-domains.json'),
    getWebDomain: domainRegistry.getDomain,
  });
  const filePath = path.join(directory, 'mailboxes.json');
  const mailboxOptions = { filePath, masterKey, getMailDomain: mailDomainRegistry.getMailDomain };
  const mailboxRegistry = createMailboxRegistry(mailboxOptions);
  async function createManagedDomain(serverId, domainName) {
    const webDomain = await domainRegistry.createDomain({
      serverId, primaryDomain: domainName, targetType: 'proxy', target: { upstreamPort: 8500 },
    });
    return mailDomainRegistry.createMailDomain({
      domainName, webDomainId: webDomain.id, managementMode: 'local',
    });
  }
  const managed = await createManagedDomain(local.id, 'local.example.test');
  const remote = await createManagedDomain(other.id, 'other.example.test');
  const remoteMailbox = await mailboxRegistry.createMailbox({
    mailDomainId: remote.id, address: 'owner@other.example.test', password,
  });

  let handler;
  server = createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createAuthenticatedApi({
    store, publicOrigin: origin, ownerMfaRequired: false, development: true,
    createHandler: () => createApp({ registry, domainRegistry, mailDomainRegistry, mailboxRegistry, localServerId: local.id }),
  });

  function request(endpoint, { method = 'GET', headers = {}, body } = {}) {
    return fetch(`${origin}${endpoint}`, {
      method,
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function signIn(username) {
    const response = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; '),
      'x-csrf-token': (await response.json()).data.csrfToken,
    };
  }
  const ownerHeaders = await signIn('owner');
  const listing = '/api/panel/mailboxes';
  const created = await request(listing, {
    method: 'POST', headers: ownerHeaders,
    body: { mailDomainId: managed.id, address: 'owner@local.example.test', password },
  });
  assert.equal(created.status, 201);
  const { data: mailbox } = await created.json();
  const endpoint = `${listing}/${mailbox.id}/delivery-policy`;
  const read = (headers = ownerHeaders) => request(endpoint, { headers });
  const write = (body, headers = ownerHeaders) => request(endpoint, { method: 'PUT', headers, body });

  const empty = { vacation: null, allow: [], deny: [] };
  const initial = await read();
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await initial.json(), { data: { mailboxId: mailbox.id, revision: 1, ...empty } });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(filePath, 'utf8')).mailboxes.find(row => row.id === mailbox.id), 'deliveryPolicy'), false);

  const marker = randomBytes(16).toString('hex');
  const update = {
    expectedRevision: 1,
    vacation: { subject: 'Ofis dışında', body: `Merhaba,\r\n${marker}` },
    allow: ['FIRST@Sender.example.test', 'first@sender.example.test'],
    deny: ['second@sender.example.test'],
  };
  assert.equal((await read({})).status, 401);
  const missingCsrf = await write(update, { cookie: ownerHeaders.cookie });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, 'csrf_invalid');
  for (const username of ['siteuser', 'reader']) {
    const headers = await signIn(username);
    const forbidden = await read(headers);
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.text()).includes(marker), false);
    assert.equal((await write(update, headers)).status, 403);
  }
  const remoteEndpoint = `${listing}/${remoteMailbox.id}/delivery-policy`;
  assert.equal((await request(remoteEndpoint, { headers: ownerHeaders })).status, 404);
  assert.equal((await request(remoteEndpoint, { headers: ownerHeaders, method: 'PUT', body: update })).status, 404);

  const saved = await write(update);
  assert.equal(saved.status, 200);
  const expected = {
    mailboxId: mailbox.id, revision: 2,
    vacation: { subject: 'Ofis dışında', body: `Merhaba,\n${marker}` },
    allow: ['first@sender.example.test'], deny: ['second@sender.example.test'],
  };
  assert.deepEqual(await saved.json(), { data: expected });
  assert.deepEqual(await (await read()).json(), { data: expected });
  const reopened = createMailboxRegistry(mailboxOptions);
  assert.deepEqual(await reopened.getDeliveryPolicy(mailbox.id), expected);

  const stale = await write(update);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'stale_mailbox_revision');
  for (const invalid of [
    { ...update, expectedRevision: 2, allow: [marker] },
    { ...update, expectedRevision: 2, deny: update.allow },
    { ...update, expectedRevision: 2, vacation: { ...update.vacation, subject: `bad\n${marker}` } },
    { expectedRevision: 2, vacation: null, allow: [] },
  ]) {
    const response = await write(invalid);
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes(marker), false);
  }
  assert.deepEqual(await (await read()).json(), { data: expected });
  const visible = await request(listing, { headers: ownerHeaders });
  assert.equal(visible.status, 200);
  assert.deepEqual((await visible.json()).data, [{ ...mailbox, revision: 2, updatedAt: (await mailboxRegistry.getMailbox(mailbox.id)).updatedAt }]);
  const detail = await request(`${listing}/${mailbox.id}`, { headers: ownerHeaders });
  assert.equal(detail.status, 200);
  assert.equal((await detail.text()).includes(marker), false);

  const cleared = await write({ expectedRevision: 2, ...empty });
  assert.equal(cleared.status, 200);
  const clearedPolicy = { data: { mailboxId: mailbox.id, revision: 3, ...empty } };
  assert.deepEqual(await cleared.json(), clearedPolicy);
  assert.deepEqual(await (await read()).json(), clearedPolicy);
  assert.equal((await readFile(filePath, 'utf8')).includes(marker), false);

  const audit = store.audit.list({ resourceType: 'mailbox', resourceId: mailbox.id, action: 'mailbox.delivery_policy.update' });
  assert.equal(audit.events.filter(event => event.outcome === 'succeeded').length, 2);
  assert.equal(audit.events.some(event => event.outcome === 'denied'), true);
  assert.equal(JSON.stringify(audit).includes(marker), false);
  assert.doesNotMatch(JSON.stringify(audit), /sender\.example|Ofis dışında|\$argon2id\$/u);
});
