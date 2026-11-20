import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';
import { createAuthStore } from '../src/auth-store.js';
import { createApp } from '../src/management-app.js';
import { createPleskImporter } from '../src/plesk-importer.js';

test('offline Plesk inventory exposes stable, safe metadata through real Owner auth', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-plesk-auth-'));
  const store = createAuthStore({ filePath: path.join(directory, 'auth.sqlite'), masterKey: randomBytes(32) });
  let server;
  try {
    const password = randomBytes(24).toString('hex');
    const setup = store.issueSetupToken();
    await store.completeSetup({ setupToken: setup.token, username: 'owner', password });
    const owner = await store.login({ username: 'owner', password });
    const policy = createOwnerMfaPolicy({ store, required: false }).requireManagement;
    await store.users.create(owner.token, policy, {
      username: 'siteuser',
      password,
      role: 'site_manager',
      websiteIds: [randomUUID()],
    });

    let handler;
    server = createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const localServerId = randomUUID();
    handler = createAuthenticatedApi({
      store,
      publicOrigin: origin,
      ownerMfaRequired: false,
      development: true,
      createHandler: () => createApp({ pleskImporter: createPleskImporter({ localServerId }), localServerId }),
    });

    async function signIn(username) {
      const response = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      return {
        cookie: response.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; '),
        'x-csrf-token': (await response.json()).data.csrfToken,
      };
    }
    async function preview(headers, payload) {
      return fetch(`${origin}/api/panel/importer/plesk/preview`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ exportData: payload }),
      });
    }

    const privateMaterial = randomBytes(24).toString('hex');
    const input = {
      name: 'pilot.test',
      runtimeType: 'php',
      certificates: [{ name: 'Pilot TLS', cert: 'public-certificate', privkey: privateMaterial }],
      crons: [{ name: 'Worker', schedule: '0 2 * * *', command: `php worker.php ${privateMaterial}` }],
      backups: [
        { name: 'old.tar', path: `/old/${privateMaterial}`, sizeBytes: 20 },
        { name: 'previous.tar', size: '17' },
        { name: 'untyped.tar', size: { key: privateMaterial } },
      ],
    };
    const ownerHeaders = await signIn('owner');
    const first = await preview(ownerHeaders, input);
    assert.equal(first.status, 200);
    const text = await first.text();
    assert.equal(text.includes(privateMaterial), false);
    const { preview: inventory } = JSON.parse(text);
    assert.equal(inventory.readOnly, true);
    assert.equal(inventory.serverId, localServerId);
    assert.deepEqual(inventory.websites[0].certificates, [{ name: 'Pilot TLS', domains: ['pilot.test'] }]);
    assert.deepEqual(inventory.websites[0].crons, [{ name: 'Worker', schedule: '0 2 * * *', enabled: true }]);
    assert.deepEqual(inventory.websites[0].backups, [
      { name: 'old.tar', sizeBytes: 20 },
      { name: 'previous.tar', sizeBytes: 17 },
      { name: 'untyped.tar', sizeBytes: 0 },
    ]);
    const second = await preview(ownerHeaders, input);
    assert.equal((await second.json()).preview.previewDigest, inventory.previewDigest);
    const changed = await preview(ownerHeaders, { ...input, name: 'other.test' });
    assert.notEqual((await changed.json()).preview.previewDigest, inventory.previewDigest);
    const malformed = await preview(ownerHeaders, privateMaterial);
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes(privateMaterial), false);
    const forbidden = await preview(await signIn('siteuser'), input);
    assert.equal(forbidden.status, 403);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
