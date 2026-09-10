import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { mountWebsiteMigrationRoutes } from '../src/website-migration-http.js';

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
  const app = express();
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountWebsiteMigrationRoutes(app, {
    websiteRegistry: { async listWebsites() { calls.push('websites'); return []; } },
    domainRegistry: { async listDomains() { calls.push('domains'); return []; } },
    applicationRegistry: { async listApplications() { calls.push('applications'); return []; } },
    preview(input) {
      calls.push(['preview', input]);
      return { version: 1, destructive: false, autoApply: false, counts: { total: 0 }, items: [] };
    },
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    calls,
    request: () => fetch(`http://127.0.0.1:${server.address().port}/api/websites/migration/preview`),
  };
}

test('Owner receives non-destructive migration preview from persisted resource snapshots', async (t) => {
  const f = await fixture(t, ownerAuth);
  const response = await f.request();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.destructive, false);
  assert.equal(body.data.autoApply, false);
  assert.deepEqual(f.calls.slice(0, 3).sort(), ['applications', 'domains', 'websites']);
  assert.equal(Array.isArray(f.calls[3]), true);
  assert.equal(f.calls[3][0], 'preview');
});

test('Read Only cannot invoke migration preview despite ordinary Website/domain reads', async (t) => {
  const f = await fixture(t, readerAuth);
  const response = await f.request();
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'forbidden');
  assert.deepEqual(f.calls, []);
});
