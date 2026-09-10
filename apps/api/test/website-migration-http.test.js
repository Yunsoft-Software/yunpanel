import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebsiteMigrationBindError } from '../src/website-migration-bind.js';
import { WebsiteMigrationCreateError } from '../src/website-migration-create.js';
import { mountWebsiteMigrationRoutes } from '../src/website-migration-http.js';
import { WebsiteMigrationPolicyError } from '../src/website-migration-policy.js';
import { WebsiteMigrationRollbackError } from '../src/website-migration-rollback.js';

const domainId = '0ef7e00b-1b85-4938-b726-247c94679c66';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const previewDigest = 'a'.repeat(64);
const ownerAuth = Object.freeze({ user: { id: 'owner-1', role: 'owner' }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } });
const readerAuth = Object.freeze({ user: { id: 'reader-1', role: 'read_only' }, access: { mode: 'read_only', permissions: ['websites.read', 'domains.read', 'applications.read'] }, security: { managementAllowed: false } });

async function fixture(t, auth) {
  const calls = [];
  const policyState = { version: 1, mode: 'compatibility', enforcedDigest: null, transitionedAt: null, websiteBindingRequired: false };
  const migrationLedger = {
    async list() { calls.push('ledger.list'); return [{ domainId, applicationId, websiteId, state: 'bound' }]; },
    async get() { return null; },
    async planWebsiteCreation() {}, async markWebsiteCreated() {}, async planBinding() {}, async markBound() {},
    async beginRollback() {}, async markRolledBack() {},
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountWebsiteMigrationRoutes(app, {
    websiteRegistry: {
      async listWebsites() { calls.push('websites'); return []; },
      async getWebsite(id) { calls.push(['website.get', id]); return null; },
      async createMigrationWebsite() { calls.push('website.createMigrationWebsite'); throw new Error('registry primitive should be invoked only through create adapter'); },
      async deleteMigrationWebsite() { calls.push('website.deleteMigrationWebsite'); throw new Error('registry primitive should be invoked only through rollback adapter'); },
    },
    domainRegistry: {
      async listDomains() { calls.push('domains'); return []; },
      async getDomain() { return null; },
      async bindWebsite() { calls.push('bindWebsite'); throw new Error('bind primitive should be invoked only through bind adapter'); },
      async rollbackWebsiteBinding() { calls.push('rollbackWebsiteBinding'); throw new Error('registry primitive should be invoked only through rollback adapter'); },
    },
    applicationRegistry: { async listApplications() { calls.push('applications'); return []; } },
    websiteMigrationPolicy: {
      snapshot() { calls.push('policy.snapshot'); return { ...policyState }; },
      async finalize(input) { calls.push(['policy.finalize', input.previewDigest, input.preview.digest]); policyState.mode = 'enforced'; policyState.enforcedDigest = input.previewDigest; policyState.websiteBindingRequired = true; return { ...policyState }; },
      async rollback(input) { calls.push(['policy.rollback', input.enforcedDigest]); policyState.mode = 'compatibility'; policyState.enforcedDigest = null; policyState.websiteBindingRequired = false; return { ...policyState }; },
    },
    migrationLedger,
    preview(input) {
      calls.push(['preview', input]);
      return { version: 1, digest: previewDigest, destructive: false, autoApply: false, counts: { total: 0, alreadyBound: 0, ready: 0, ambiguous: 0, unresolved: 0 }, items: [] };
    },
    async create(input) {
      assert.equal(input.migrationLedger, migrationLedger);
      calls.push(['create', input.domainId, input.applicationId, input.previewDigest]);
      return { created: input.previewDigest === previewDigest, website: { id: websiteId, applicationId: input.applicationId }, sourcePreviewDigest: input.previewDigest, nextAction: 'rerun_preview_then_bind' };
    },
    async bind(input) {
      assert.equal(input.migrationLedger, migrationLedger);
      calls.push(['bind', input.domainId, input.websiteId, input.previewDigest]);
      return { migrated: true, domain: { id: input.domainId, websiteId: input.websiteId }, websiteId: input.websiteId, previewVersion: 1, previewDigest: input.previewDigest };
    },
    async rollbackBinding(input) {
      assert.equal(input.migrationLedger, migrationLedger);
      calls.push(['rollbackBinding', input.domainId, input.websiteId, input.bindingPreviewDigest]);
      return { rolledBack: true, domain: { id: input.domainId, websiteId: null }, websiteDeleted: false };
    },
  });
  app.use((error, _request, response, _next) => {
    if (error instanceof WebsiteMigrationBindError || error instanceof WebsiteMigrationCreateError || error instanceof WebsiteMigrationPolicyError || error instanceof WebsiteMigrationRollbackError) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    return response.status(500).json({ error: { code: 'internal_error' } });
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, request: (pathname = '/api/websites/migration/preview', options = {}) => fetch(`${base}${pathname}`, { ...options, headers: options.body ? { 'content-type': 'application/json', ...(options.headers ?? {}) } : options.headers }) };
}

function bindBody(overrides = {}) { const values = { domainId, websiteId, previewDigest, ...overrides }; return { ...values, confirmation: overrides.confirmation ?? `bind:${values.domainId}:${values.websiteId}:${values.previewDigest}` }; }
function createBody(overrides = {}) { const values = { domainId, applicationId, previewDigest, ...overrides }; return { ...values, confirmation: overrides.confirmation ?? `create-website:${values.domainId}:${values.applicationId}:${values.previewDigest}` }; }
function finalizeBody(overrides = {}) { const values = { previewDigest, ...overrides }; return { ...values, confirmation: overrides.confirmation ?? `finalize:${values.previewDigest}` }; }
function rollbackBody(overrides = {}) { const values = { enforcedDigest: previewDigest, ...overrides }; return { ...values, confirmation: overrides.confirmation ?? `rollback:${values.enforcedDigest}` }; }
function rollbackBindingBody(overrides = {}) { const values = { domainId, websiteId, bindingPreviewDigest: previewDigest, ...overrides }; return { ...values, confirmation: overrides.confirmation ?? `rollback-binding:${values.domainId}:${values.websiteId}:${values.bindingPreviewDigest}` }; }

test('Owner receives non-destructive migration preview from persisted resource snapshots', async (t) => {
  const f = await fixture(t, ownerAuth); const response = await f.request(); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.data.digest, previewDigest); assert.equal(body.data.destructive, false); assert.equal(body.data.autoApply, false); assert.deepEqual(f.calls.slice(0, 3).sort(), ['applications', 'domains', 'websites']);
});

test('Owner status returns current policy preview and safe ledger state', async (t) => {
  const f = await fixture(t, ownerAuth); const response = await f.request('/api/websites/migration/status'); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.data.policy.mode, 'compatibility'); assert.equal(body.data.preview.digest, previewDigest); assert.equal(body.data.ledger[0].state, 'bound'); assert.equal(f.calls.includes('policy.snapshot'), true); assert.equal(f.calls.includes('ledger.list'), true);
});

test('Owner migration Website creation requires exact IDs digest and typed confirmation', async (t) => {
  const f = await fixture(t, ownerAuth); const valid = await f.request('/api/websites/migration/create-website', { method: 'POST', body: JSON.stringify(createBody()) }); assert.equal(valid.status, 201); assert.equal((await valid.json()).data.created, true); assert.deepEqual(f.calls, [['create', domainId, applicationId, previewDigest]]);
  for (const body of [createBody({ confirmation: 'wrong' }), createBody({ domainId: 'bad', confirmation: 'wrong' }), createBody({ applicationId: 'bad', confirmation: 'wrong' }), createBody({ previewDigest: 'bad', confirmation: 'wrong' }), { ...createBody(), extra: 'field' }]) {
    const before = f.calls.length; const response = await f.request('/api/websites/migration/create-website', { method: 'POST', body: JSON.stringify(body) }); assert.equal(response.status, 400); assert.match((await response.json()).error.code, /^website_migration_/); assert.equal(f.calls.length, before);
  }
});

test('idempotent migration Website creation can return 200 without creating another resource', async (t) => {
  const f = await fixture(t, ownerAuth); const other = 'b'.repeat(64); const response = await f.request('/api/websites/migration/create-website', { method: 'POST', body: JSON.stringify(createBody({ previewDigest: other, confirmation: `create-website:${domainId}:${applicationId}:${other}` })) }); assert.equal(response.status, 200); assert.equal((await response.json()).data.created, false);
});

test('Owner bind requires exact canonical IDs preview digest and typed confirmation', async (t) => {
  const f = await fixture(t, ownerAuth); const valid = await f.request('/api/websites/migration/bind', { method: 'POST', body: JSON.stringify(bindBody()) }); assert.equal(valid.status, 200); assert.equal((await valid.json()).data.migrated, true); assert.deepEqual(f.calls, [['bind', domainId, websiteId, previewDigest]]);
  for (const body of [bindBody({ confirmation: 'wrong' }), bindBody({ domainId: 'bad', confirmation: 'wrong' }), bindBody({ previewDigest: 'bad', confirmation: 'wrong' }), { ...bindBody(), extra: 'field' }]) { const before = f.calls.length; const response = await f.request('/api/websites/migration/bind', { method: 'POST', body: JSON.stringify(body) }); assert.equal(response.status, 400); assert.equal(f.calls.length, before); }
});

test('Owner finalize and rollback require exact typed confirmations', async (t) => {
  const f = await fixture(t, ownerAuth); const finalized = await f.request('/api/websites/migration/finalize', { method: 'POST', body: JSON.stringify(finalizeBody()) }); assert.equal(finalized.status, 200); assert.equal((await finalized.json()).data.mode, 'enforced'); const rolled = await f.request('/api/websites/migration/rollback', { method: 'POST', body: JSON.stringify(rollbackBody()) }); assert.equal(rolled.status, 200); assert.equal((await rolled.json()).data.mode, 'compatibility');
});

test('Owner binding rollback requires exact ledger identity and typed confirmation', async (t) => {
  const f = await fixture(t, ownerAuth);
  const valid = await f.request('/api/websites/migration/rollback-binding', { method: 'POST', body: JSON.stringify(rollbackBindingBody()) });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).data.rolledBack, true);
  assert.deepEqual(f.calls, [['rollbackBinding', domainId, websiteId, previewDigest]]);
  for (const body of [rollbackBindingBody({ confirmation: 'wrong' }), rollbackBindingBody({ bindingPreviewDigest: 'bad', confirmation: 'wrong' }), { ...rollbackBindingBody(), extra: 'field' }]) {
    const before = f.calls.length;
    const response = await f.request('/api/websites/migration/rollback-binding', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal(f.calls.length, before);
  }
});

test('Read Only cannot invoke migration management surfaces', async (t) => {
  const f = await fixture(t, readerAuth); const requests = [['/api/websites/migration/preview', {}], ['/api/websites/migration/status', {}], ['/api/websites/migration/create-website', { method: 'POST', body: JSON.stringify(createBody()) }], ['/api/websites/migration/bind', { method: 'POST', body: JSON.stringify(bindBody()) }], ['/api/websites/migration/finalize', { method: 'POST', body: JSON.stringify(finalizeBody()) }], ['/api/websites/migration/rollback', { method: 'POST', body: JSON.stringify(rollbackBody()) }], ['/api/websites/migration/rollback-binding', { method: 'POST', body: JSON.stringify(rollbackBindingBody()) }]]; for (const [pathname, options] of requests) { const response = await f.request(pathname, options); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'forbidden'); } assert.deepEqual(f.calls, []);
});
