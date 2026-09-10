import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebsiteMigrationBindError } from '../src/website-migration-bind.js';
import { mountWebsiteMigrationRoutes } from '../src/website-migration-http.js';
import { WebsiteMigrationPolicyError } from '../src/website-migration-policy.js';

const domainId = '0ef7e00b-1b85-4938-b726-247c94679c66';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const previewDigest = 'a'.repeat(64);
const ownerAuth = Object.freeze({
  user: { id: 'owner-1', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const readerAuth = Object.freeze({
  user: { id: 'reader-1', role: 'read_only' },
  access: { mode: 'read_only', permissions: ['websites.read', 'domains.read', 'applications.read'] },
  security: { managementAllowed: false },
});

async function fixture(t, auth) {
  const calls = [];
  const policyState = {
    version: 1,
    mode: 'compatibility',
    enforcedDigest: null,
    transitionedAt: null,
    websiteBindingRequired: false,
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountWebsiteMigrationRoutes(app, {
    websiteRegistry: { async listWebsites() { calls.push('websites'); return []; } },
    domainRegistry: {
      async listDomains() { calls.push('domains'); return []; },
      async bindWebsite() { calls.push('bindWebsite'); throw new Error('bind primitive should be invoked only through bind adapter'); },
    },
    applicationRegistry: { async listApplications() { calls.push('applications'); return []; } },
    websiteMigrationPolicy: {
      snapshot() { calls.push('policy.snapshot'); return { ...policyState }; },
      async finalize(input) {
        calls.push(['policy.finalize', input.previewDigest, input.preview.digest]);
        policyState.mode = 'enforced';
        policyState.enforcedDigest = input.previewDigest;
        policyState.websiteBindingRequired = true;
        return { ...policyState };
      },
      async rollback(input) {
        calls.push(['policy.rollback', input.enforcedDigest]);
        policyState.mode = 'compatibility';
        policyState.enforcedDigest = null;
        policyState.websiteBindingRequired = false;
        return { ...policyState };
      },
    },
    preview(input) {
      calls.push(['preview', input]);
      return {
        version: 1,
        digest: previewDigest,
        destructive: false,
        autoApply: false,
        counts: { total: 0, alreadyBound: 0, ready: 0, ambiguous: 0, unresolved: 0 },
        items: [],
      };
    },
    async bind(input) {
      calls.push(['bind', input.domainId, input.websiteId, input.previewDigest]);
      return {
        migrated: true,
        domain: { id: input.domainId, websiteId: input.websiteId },
        websiteId: input.websiteId,
        previewVersion: 1,
        previewDigest: input.previewDigest,
      };
    },
  });
  app.use((error, _request, response, _next) => {
    if (error instanceof WebsiteMigrationBindError || error instanceof WebsiteMigrationPolicyError) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    return response.status(500).json({ error: { code: 'internal_error' } });
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    request: (pathname = '/api/websites/migration/preview', options = {}) => fetch(`${base}${pathname}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...(options.headers ?? {}) } : options.headers,
    }),
  };
}

function bindBody(overrides = {}) {
  const values = { domainId, websiteId, previewDigest, ...overrides };
  return {
    ...values,
    confirmation: overrides.confirmation ?? `bind:${values.domainId}:${values.websiteId}:${values.previewDigest}`,
  };
}

function finalizeBody(overrides = {}) {
  const values = { previewDigest, ...overrides };
  return {
    ...values,
    confirmation: overrides.confirmation ?? `finalize:${values.previewDigest}`,
  };
}

function rollbackBody(overrides = {}) {
  const values = { enforcedDigest: previewDigest, ...overrides };
  return {
    ...values,
    confirmation: overrides.confirmation ?? `rollback:${values.enforcedDigest}`,
  };
}

test('Owner receives non-destructive migration preview from persisted resource snapshots', async (t) => {
  const f = await fixture(t, ownerAuth);
  const response = await f.request();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.digest, previewDigest);
  assert.equal(body.data.destructive, false);
  assert.equal(body.data.autoApply, false);
  assert.deepEqual(f.calls.slice(0, 3).sort(), ['applications', 'domains', 'websites']);
  assert.equal(Array.isArray(f.calls[3]), true);
  assert.equal(f.calls[3][0], 'preview');
});

test('Owner status returns current policy beside the same read-only preview', async (t) => {
  const f = await fixture(t, ownerAuth);
  const response = await f.request('/api/websites/migration/status');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.policy.mode, 'compatibility');
  assert.equal(body.data.policy.websiteBindingRequired, false);
  assert.equal(body.data.preview.digest, previewDigest);
  assert.equal(f.calls.includes('policy.snapshot'), true);
});

test('Owner bind requires exact canonical IDs preview digest and typed confirmation before adapter invocation', async (t) => {
  const f = await fixture(t, ownerAuth);
  const valid = await f.request('/api/websites/migration/bind', {
    method: 'POST', body: JSON.stringify(bindBody()),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).data.migrated, true);
  assert.deepEqual(f.calls, [['bind', domainId, websiteId, previewDigest]]);

  for (const body of [
    bindBody({ confirmation: 'wrong' }),
    bindBody({ domainId: 'bad', confirmation: 'wrong' }),
    bindBody({ previewDigest: 'bad', confirmation: 'wrong' }),
    { ...bindBody(), extra: 'field' },
  ]) {
    const before = f.calls.length;
    const response = await f.request('/api/websites/migration/bind', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.code, /^website_migration_/);
    assert.equal(f.calls.length, before);
  }
});

test('Owner finalize recomputes preview and requires exact digest confirmation', async (t) => {
  const f = await fixture(t, ownerAuth);
  const response = await f.request('/api/websites/migration/finalize', {
    method: 'POST', body: JSON.stringify(finalizeBody()),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.mode, 'enforced');
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'policy.finalize' && call[1] === previewDigest && call[2] === previewDigest), true);

  const before = f.calls.length;
  const denied = await f.request('/api/websites/migration/finalize', {
    method: 'POST', body: JSON.stringify(finalizeBody({ confirmation: 'wrong' })),
  });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, 'website_migration_confirmation_required');
  assert.equal(f.calls.length, before);
});

test('Owner rollback requires exact enforced digest confirmation and does not read migration resources', async (t) => {
  const f = await fixture(t, ownerAuth);
  const response = await f.request('/api/websites/migration/rollback', {
    method: 'POST', body: JSON.stringify(rollbackBody()),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.mode, 'compatibility');
  assert.deepEqual(f.calls, [['policy.rollback', previewDigest]]);

  const before = f.calls.length;
  const denied = await f.request('/api/websites/migration/rollback', {
    method: 'POST', body: JSON.stringify(rollbackBody({ enforcedDigest: 'bad', confirmation: 'wrong' })),
  });
  assert.equal(denied.status, 400);
  assert.equal(f.calls.length, before);
});

test('Read Only cannot invoke migration management surfaces despite ordinary Website/domain reads', async (t) => {
  const f = await fixture(t, readerAuth);
  const requests = [
    ['/api/websites/migration/preview', {}],
    ['/api/websites/migration/status', {}],
    ['/api/websites/migration/bind', { method: 'POST', body: JSON.stringify(bindBody()) }],
    ['/api/websites/migration/finalize', { method: 'POST', body: JSON.stringify(finalizeBody()) }],
    ['/api/websites/migration/rollback', { method: 'POST', body: JSON.stringify(rollbackBody()) }],
  ];
  for (const [pathname, options] of requests) {
    const response = await f.request(pathname, options);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'forbidden');
  }
  assert.deepEqual(f.calls, []);
});
