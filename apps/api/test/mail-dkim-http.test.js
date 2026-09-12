import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { MailDkimHttpError, mountMailDkimRoutes } from '../src/mail-dkim-http.js';
import { MailDkimRegistryError } from '../src/mail-dkim-registry.js';

const localServerId = randomUUID();
const remoteServerId = randomUUID();
const localWebDomain = { id: randomUUID(), serverId: localServerId, primaryDomain: 'example.com' };
const remoteWebDomain = { id: randomUUID(), serverId: remoteServerId, primaryDomain: 'remote.example' };
const localMailDomain = {
  id: randomUUID(), webDomainId: localWebDomain.id, domainName: 'example.com', managementMode: 'local', status: 'enabled',
};
const remoteMailDomain = {
  id: randomUUID(), webDomainId: remoteWebDomain.id, domainName: 'remote.example', managementMode: 'local', status: 'enabled',
};
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const readOnly = Object.freeze({
  user: { role: 'read_only' },
  access: { mode: 'read_only', permissions: ['mail.read'] },
  security: { managementAllowed: false },
});
const publicKey = Buffer.alloc(256, 4).toString('base64');

async function listen(t, auth) {
  const calls = [];
  let state = null;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailDkimRoutes(app, {
    localServerId,
    mailDomainRegistry: {
      async getMailDomain(id) {
        if (id === localMailDomain.id) return localMailDomain;
        if (id === remoteMailDomain.id) return remoteMailDomain;
        return null;
      },
    },
    domainRegistry: {
      async getDomain(id) {
        if (id === localWebDomain.id) return localWebDomain;
        if (id === remoteWebDomain.id) return remoteWebDomain;
        return null;
      },
    },
    mailDkimRegistry: {
      async getKey(id) { calls.push(['get', id]); return state; },
      async createKey(id, input) {
        calls.push(['create', id, structuredClone(input)]);
        state = {
          mailDomainId: id,
          domainName: 'example.com',
          selector: input.selector,
          algorithm: 'rsa-sha256',
          publicKey,
          dnsRecord: {
            type: 'TXT',
            name: `${input.selector}._domainkey.example.com`,
            value: `v=DKIM1; k=rsa; p=${publicKey}`,
          },
          revision: 1,
          createdAt: '2026-09-12T19:00:00.000Z',
          updatedAt: '2026-09-12T19:00:00.000Z',
        };
        return state;
      },
      async rotateKey() { throw new Error('not used'); },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailDkimRegistryError || error instanceof MailDkimHttpError;
    return response.status(known ? error.status : 500).json({
      error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Unexpected error' },
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

function post(base, id, body) {
  return fetch(`${base}/api/mail-domains/${id}/dkim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner creates public DKIM metadata without claiming DNS or host side effects', async (t) => {
  const { base, calls } = await listen(t, owner);
  const created = await post(base, localMailDomain.id, { expectedRevision: 0, selector: 'mail-2026' });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.data.selector, 'mail-2026');
  assert.equal(body.data.dnsRecord.name, 'mail-2026._domainkey.example.com');
  assert.deepEqual(body.sideEffects, {
    mailConfigurationChanged: false,
    mailDataChanged: false,
    requiresDnsPublish: true,
    requiresConfigurationApply: true,
  });
  assert.doesNotMatch(JSON.stringify(body), /BEGIN PRIVATE KEY|private\.pem/i);

  const read = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/dkim`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).data.publicKey, publicKey);
  assert.deepEqual(calls.map(([name]) => name), ['create', 'get']);
});

test('Read Only can inspect DKIM metadata but cannot generate keys', async (t) => {
  const { base, calls } = await listen(t, readOnly);
  assert.equal((await fetch(`${base}/api/mail-domains/${localMailDomain.id}/dkim`)).status, 200);
  const denied = await post(base, localMailDomain.id, { expectedRevision: 0, selector: 'mail-2026' });
  assert.equal(denied.status, 403);
  assert.deepEqual(calls.map(([name]) => name), ['get']);
});

test('remote mail domain is hidden before DKIM registry access', async (t) => {
  const { base, calls } = await listen(t, owner);
  const response = await fetch(`${base}/api/mail-domains/${remoteMailDomain.id}/dkim`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'mail_domain_not_found');
  assert.deepEqual(calls, []);
});

test('DKIM API rejects hidden fields and query parameters before key generation', async (t) => {
  const { base, calls } = await listen(t, owner);
  const hidden = await post(base, localMailDomain.id, {
    expectedRevision: 0,
    selector: 'mail-2026',
    privateKey: 'no',
  });
  assert.equal(hidden.status, 400);
  assert.equal((await hidden.json()).error.code, 'mail_dkim_create_input_invalid');

  const query = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/dkim?raw=true`);
  assert.equal(query.status, 400);
  assert.equal((await query.json()).error.code, 'mail_dkim_query_invalid');
  assert.deepEqual(calls, []);
});
