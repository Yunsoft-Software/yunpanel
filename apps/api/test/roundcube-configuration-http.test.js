import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { JobRegistryError } from '../src/job-registry.js';
import {
  RoundcubeConfigurationHttpError,
  mountRoundcubeConfigurationRoutes,
} from '../src/roundcube-configuration-http.js';

const localServerId = randomUUID();
const previewSha256 = 'a'.repeat(64);
const configSha256 = 'b'.repeat(64);
const fpmSha256 = 'c'.repeat(64);
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

function readyPreview() {
  return Object.freeze({
    version: 1,
    serverId: localServerId,
    mailHostname: 'mail.example.com',
    certificateId: randomUUID(),
    certificateFingerprint256: '11:22',
    mailServiceIdentityRevision: 2,
    roundcubeSecretRevision: 1,
    configSha256,
    fpmSha256,
    databasePath: '/var/lib/roundcube/db/roundcube.sqlite',
    publicRoot: '/usr/share/roundcube/public_html',
    fpmSocketPath: '/run/php/roundcube.sock',
    fpmServiceUnit: 'php8.3-fpm.service',
    sha256: previewSha256,
    readyToApply: true,
    configuration: {
      version: 1,
      sha256: configSha256,
      artifact: { path: '/etc/roundcube/config.inc.php' },
      mailHostname: 'mail.example.com',
      databasePath: '/var/lib/roundcube/db/roundcube.sqlite',
      temporaryDirectory: '/var/lib/roundcube/temp',
      databaseSchemaPath: '/usr/share/roundcube/SQL/sqlite.initial.sql',
      publicRoot: '/usr/share/roundcube/public_html',
      requires: [],
    },
    fpm: {
      version: 1,
      sha256: fpmSha256,
      artifact: { path: '/etc/php/8.3/fpm/pool.d/roundcube.conf' },
    },
    sideEffects: false,
  });
}

async function listen(t, auth, {
  preview = readyPreview(),
  prepared = readyPreview(),
  jobs = [],
  configuredServerId = localServerId,
} = {}) {
  const enqueued = [];
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountRoundcubeConfigurationRoutes(app, {
    localServerId: configuredServerId,
    roundcubeConfigurationService: {
      async previewForServer(serverId) {
        calls.push(['preview', serverId]);
        return preview;
      },
      async prepareForServer(serverId) {
        calls.push(['prepare', serverId]);
        return prepared;
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        assert.deepEqual(filter, { serverId: localServerId });
        return jobs;
      },
      async enqueue(input) {
        enqueued.push(structuredClone(input));
        return { id: randomUUID(), status: 'queued', ...input };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof RoundcubeConfigurationHttpError || error instanceof JobRegistryError;
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
  return { base: `http://127.0.0.1:${server.address().port}`, enqueued, calls };
}

function post(base, pathname, body) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner previews, prepares and queues exact secret-free Roundcube configuration', async (t) => {
  const { base, enqueued, calls } = await listen(t, owner);
  const previewResponse = await fetch(`${base}/api/roundcube/config-preview`);
  assert.equal(previewResponse.status, 200);
  const previewBody = await previewResponse.json();
  assert.equal(previewBody.data.sha256, previewSha256);
  assert.equal(previewBody.data.configuration.sha256, configSha256);
  assert.equal(previewBody.data.fpm.sha256, fpmSha256);
  assert.doesNotMatch(JSON.stringify(previewBody), /desKey|password|ciphertext|configContent|fpmContent/i);

  const prepareResponse = await post(base, '/api/roundcube/config-prepare', {});
  assert.equal(prepareResponse.status, 200);
  assert.equal((await prepareResponse.json()).data.roundcubeSecretRevision, 1);

  const applyResponse = await post(base, '/api/roundcube/config-apply', {
    previewSha256,
    configSha256,
    fpmSha256,
  });
  assert.equal(applyResponse.status, 202);
  assert.deepEqual(enqueued, [{
    serverId: localServerId,
    type: 'roundcube.config.apply',
    operation: 'roundcube.config.apply',
    payload: { previewSha256, configSha256, fpmSha256 },
    resourceType: 'server',
    resourceId: localServerId,
  }]);
  assert.doesNotMatch(JSON.stringify(enqueued), /desKey|password|ciphertext|configContent|fpmContent/i);
  assert.deepEqual(calls, [
    ['preview', localServerId],
    ['prepare', localServerId],
    ['preview', localServerId],
  ]);
});

test('Roundcube apply rejects stale desired state and concurrent configuration jobs', async (t) => {
  const staleFixture = await listen(t, owner);
  const stale = await post(staleFixture.base, '/api/roundcube/config-apply', {
    previewSha256: 'd'.repeat(64),
    configSha256,
    fpmSha256,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'roundcube_preview_stale');
  assert.equal(staleFixture.enqueued.length, 0);

  const conflictFixture = await listen(t, owner, {
    jobs: [{ operation: 'roundcube.config.apply', status: 'running' }],
  });
  const conflict = await post(conflictFixture.base, '/api/roundcube/config-apply', {
    previewSha256,
    configSha256,
    fpmSha256,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'roundcube_configuration_job_conflict');
  assert.equal(conflictFixture.enqueued.length, 0);
});

test('Roundcube configuration stays local-server scoped and Read Only cannot mutate it', async (t) => {
  const readOnlyFixture = await listen(t, readOnly);
  assert.equal((await fetch(`${readOnlyFixture.base}/api/roundcube/config-preview`)).status, 403);
  assert.equal((await post(readOnlyFixture.base, '/api/roundcube/config-prepare', {})).status, 403);
  assert.equal((await post(readOnlyFixture.base, '/api/roundcube/config-apply', {
    previewSha256,
    configSha256,
    fpmSha256,
  })).status, 403);
  assert.equal(readOnlyFixture.enqueued.length, 0);

  const unavailable = await listen(t, owner, { configuredServerId: null });
  const response = await fetch(`${unavailable.base}/api/roundcube/config-preview`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'roundcube_configuration_local_server_unavailable');
});
