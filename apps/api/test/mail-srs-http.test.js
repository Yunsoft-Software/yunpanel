import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { JobRegistryError } from '../src/job-registry.js';
import { MailSrsHttpError, mountMailSrsRoutes } from '../src/mail-srs-http.js';

const localServerId = randomUUID();
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const readOnly = Object.freeze({
  user: { role: 'read_only' },
  access: { mode: 'read_only', permissions: ['mailboxes.read'] },
  security: { managementAllowed: false },
});

function status(revision = 1) {
  return Object.freeze({
    version: 1,
    serverId: localServerId,
    srsDomain: 'mail.example.com',
    mailServiceIdentityRevision: 2,
    srsSecretRevision: revision,
    configured: true,
    ready: true,
    blockers: [],
    sideEffects: false,
  });
}

async function listen(t, auth, { jobs = [], configuredServerId = localServerId } = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailSrsRoutes(app, {
    localServerId: configuredServerId,
    mailSrsConfigurationService: {
      async previewForServer(serverId) { calls.push(['preview', serverId]); return status(); },
      async prepareForServer(serverId) { calls.push(['prepare', serverId]); return status(); },
      async rotateForServer(serverId, options) { calls.push(['rotate', serverId, options]); return status(2); },
    },
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['jobs', filter]);
        return jobs;
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailSrsHttpError || error instanceof JobRegistryError;
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

function post(base, pathname, body) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner can inspect, explicitly prepare and rotate SRS without exposing secret material', async (t) => {
  const fx = await listen(t, owner);
  const inspected = await fetch(`${fx.base}/api/mail/srs`);
  assert.equal(inspected.status, 200);
  assert.doesNotMatch(JSON.stringify(await inspected.json()), /secretContent|ciphertext|private/i);

  const prepared = await post(fx.base, '/api/mail/srs/prepare', {});
  assert.equal(prepared.status, 200);
  assert.equal((await prepared.json()).data.srsSecretRevision, 1);

  const rotated = await post(fx.base, '/api/mail/srs/rotate', {
    expectedRevision: 1,
    confirmation: `rotate-mail-srs-secret:${localServerId}:1`,
  });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).data.srsSecretRevision, 2);
  assert.ok(fx.calls.some(([name]) => name === 'prepare'));
  assert.ok(fx.calls.some(([name]) => name === 'rotate'));
});

test('SRS prepare and rotation refuse concurrent managed mail mutation', async (t) => {
  const fx = await listen(t, owner, { jobs: [{ operation: 'mail.config.apply', status: 'running' }] });
  for (const [pathname, body] of [
    ['/api/mail/srs/prepare', {}],
    ['/api/mail/srs/rotate', { expectedRevision: 1, confirmation: `rotate-mail-srs-secret:${localServerId}:1` }],
  ]) {
    const response = await post(fx.base, pathname, body);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'mail_configuration_job_conflict');
  }
  assert.equal(fx.calls.some(([name]) => name === 'prepare' || name === 'rotate'), false);
});

test('SRS routes stay local-server scoped and Read Only cannot access the management surface', async (t) => {
  const readOnlyFixture = await listen(t, readOnly);
  assert.equal((await fetch(`${readOnlyFixture.base}/api/mail/srs`)).status, 403);
  assert.equal((await post(readOnlyFixture.base, '/api/mail/srs/prepare', {})).status, 403);

  const unavailable = await listen(t, owner, { configuredServerId: null });
  const response = await fetch(`${unavailable.base}/api/mail/srs`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'mail_srs_local_server_unavailable');
});
