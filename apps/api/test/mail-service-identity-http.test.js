import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { JobRegistryError } from '../src/job-registry.js';
import { mountMailServiceIdentityRoutes } from '../src/mail-service-identity-http.js';
import {
  createMailServiceIdentityRegistry,
  MailServiceIdentityRegistryError,
} from '../src/mail-service-identity-registry.js';

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

async function listen(t, auth, { runningMailJob = false } = {}) {
  const localServerId = randomUUID();
  const remoteServerId = randomUUID();
  const localWebDomain = {
    id: randomUUID(),
    serverId: localServerId,
    primaryDomain: 'mail.example.test',
    certificateId: randomUUID(),
  };
  const remoteWebDomain = {
    id: randomUUID(),
    serverId: remoteServerId,
    primaryDomain: 'mail.remote.test',
    certificateId: randomUUID(),
  };
  const certificates = new Map([
    [localWebDomain.certificateId, {
      id: localWebDomain.certificateId,
      domainId: localWebDomain.id,
      serverId: localServerId,
      state: 'active',
      staging: false,
      validTo: '2030-01-01T00:00:00.000Z',
      certificateNames: ['mail.example.test'],
      fullchainPath: '/etc/letsencrypt/live/mail.example.test/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/mail.example.test/privkey.pem',
      fingerprint256: 'AA:BB',
    }],
    [remoteWebDomain.certificateId, {
      id: remoteWebDomain.certificateId,
      domainId: remoteWebDomain.id,
      serverId: remoteServerId,
      state: 'active',
      staging: false,
      validTo: '2030-01-01T00:00:00.000Z',
      certificateNames: ['mail.remote.test'],
      fullchainPath: '/etc/letsencrypt/live/mail.remote.test/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/mail.remote.test/privkey.pem',
      fingerprint256: 'CC:DD',
    }],
  ]);
  const domains = new Map([
    [localWebDomain.id, localWebDomain],
    [remoteWebDomain.id, remoteWebDomain],
  ]);
  let mailStatus = 'enabled';
  const mailDomain = {
    id: randomUUID(),
    webDomainId: localWebDomain.id,
    managementMode: 'local',
    status: mailStatus,
  };
  const identityRegistry = createMailServiceIdentityRegistry({
    now: () => Date.parse('2026-09-13T00:00:00.000Z'),
    getWebDomain: async (id) => domains.get(id) ?? null,
    getCertificate: async (id) => certificates.get(id) ?? null,
  });
  await identityRegistry.init();

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailServiceIdentityRoutes(app, {
    localServerId,
    mailServiceIdentityRegistry: identityRegistry,
    mailDomainRegistry: {
      async listMailDomains() { return [{ ...mailDomain, status: mailStatus }]; },
    },
    domainRegistry: {
      async getDomain(id) { return domains.get(id) ?? null; },
    },
    jobRegistry: {
      async listJobs() {
        return runningMailJob
          ? [{ operation: OPERATIONS.MAIL_CONFIG_APPLY, status: 'running' }]
          : [];
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailServiceIdentityRegistryError || error instanceof JobRegistryError;
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
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    localServerId,
    localWebDomain,
    remoteWebDomain,
    setMailStatus(value) { mailStatus = value; },
  };
}

function mutation(base, method, body) {
  return fetch(`${base}/api/mail-service-identity`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner binds explicit local TLS identity without claiming host configuration changes', async (t) => {
  const fixture = await listen(t, owner);
  const bind = await mutation(fixture.base, 'PUT', {
    expectedRevision: 0,
    webDomainId: fixture.localWebDomain.id,
  });
  assert.equal(bind.status, 200);
  const bound = await bind.json();
  assert.equal(bound.data.hostname, 'mail.example.test');
  assert.equal(bound.data.certificateId, fixture.localWebDomain.certificateId);
  assert.equal(bound.data.revision, 1);
  assert.deepEqual(bound.sideEffects, {
    mailConfigurationChanged: false,
    mailDataChanged: false,
    requiresConfigurationApply: true,
  });
  assert.equal('fullchainPath' in bound.data, false);
  assert.equal('privateKeyPath' in bound.data, false);

  const get = await fetch(`${fixture.base}/api/mail-service-identity`);
  assert.equal(get.status, 200);
  const current = await get.json();
  assert.equal(current.data.webDomainId, fixture.localWebDomain.id);
  assert.equal(current.data.ready, true);
});

test('identity binding rejects cross-server Domain and active managed-mail job conflicts', async (t) => {
  const fixture = await listen(t, owner);
  const remote = await mutation(fixture.base, 'PUT', {
    expectedRevision: 0,
    webDomainId: fixture.remoteWebDomain.id,
  });
  assert.equal(remote.status, 409);
  assert.equal((await remote.json()).error.code, 'mail_service_domain_mismatch');

  const busy = await listen(t, owner, { runningMailJob: true });
  const conflict = await mutation(busy.base, 'PUT', {
    expectedRevision: 0,
    webDomainId: busy.localWebDomain.id,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'mail_configuration_job_conflict');
});

test('identity clear is blocked while local mail is enabled and succeeds after disable', async (t) => {
  const fixture = await listen(t, owner);
  assert.equal((await mutation(fixture.base, 'PUT', {
    expectedRevision: 0,
    webDomainId: fixture.localWebDomain.id,
  })).status, 200);

  const blocked = await mutation(fixture.base, 'DELETE', {
    expectedRevision: 1,
    confirmation: `clear-mail-service-identity:${fixture.localServerId}:1`,
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'mail_service_identity_in_use');

  fixture.setMailStatus('disabled');
  const cleared = await mutation(fixture.base, 'DELETE', {
    expectedRevision: 1,
    confirmation: `clear-mail-service-identity:${fixture.localServerId}:1`,
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).sideEffects, {
    mailConfigurationChanged: false,
    mailDataChanged: false,
    requiresConfigurationApply: false,
  });
  assert.equal((await (await fetch(`${fixture.base}/api/mail-service-identity`)).json()).data, null);
});

test('Read Only can inspect mail TLS identity but cannot bind it and bodies are exact', async (t) => {
  const readOnlyFixture = await listen(t, readOnly);
  assert.equal((await fetch(`${readOnlyFixture.base}/api/mail-service-identity`)).status, 200);
  const denied = await mutation(readOnlyFixture.base, 'PUT', {
    expectedRevision: 0,
    webDomainId: readOnlyFixture.localWebDomain.id,
  });
  assert.equal(denied.status, 403);

  const ownerFixture = await listen(t, owner);
  const invalid = await mutation(ownerFixture.base, 'PUT', {
    expectedRevision: 0,
    webDomainId: ownerFixture.localWebDomain.id,
    arbitrary: true,
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'mail_service_identity_bind_input_invalid');
});