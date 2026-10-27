import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { LogHttpError, mountLogRoutes } from '../src/log-http.js';
import { ownerManagementContext, readOnlyManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const OWN_APP = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const FOREIGN_APP = '1c7e6c2b-55b5-4e0c-9a77-0d5c5f2f6a01';
const OWN_JOB = 'ff830043-9752-4640-83b4-3a1998de78a0';
const FOREIGN_JOB = '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const OWN_SITE = 'b0b4e7a2-0f1d-4a38-9a2e-6a3f0f7c1d11';
const SECRET = 'baska-musterinin-kaydi';

const siteUser = (role, websiteIds) => Object.freeze({
  user: Object.freeze({ id: `${role}-1`, username: role, role, hosting: { kind: role === 'reseller' ? 'reseller' : 'customer' }, websiteIds }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});

async function serve(t, context) {
  const page = { entries: [{ cursor: 'c1', timestamp: '2026-10-27T10:00:00.000Z', level: 'info', source: 'test', message: SECRET, truncated: false }],
    page: { count: 1, hasMore: false, nextCursor: null }, range: {} };
  const app = express();
  mountLogRoutes(app, {
    registry: { getServer: async id => id === SERVER_ID ? { id, executionMode: 'local' } : null },
    applicationRegistry: { getApplication: async id => [OWN_APP, FOREIGN_APP].includes(id) ? { id, serverId: SERVER_ID, type: 'node' } : null },
    websiteRegistry: { listWebsites: async () => [{ id: OWN_SITE, applicationId: OWN_APP }, { id: 'other-site', applicationId: FOREIGN_APP }] },
    jobRegistry: { getJob: async id => id === OWN_JOB ? { id, serverId: SERVER_ID, operation: 'app.node.deploy', payload: { applicationId: OWN_APP } }
      : id === FOREIGN_JOB ? { id, serverId: SERVER_ID, operation: 'app.node.deploy', payload: { applicationId: FOREIGN_APP } } : null },
    journalLogReader: { query: async () => page }, nginxLogReader: { query: async () => page }, jobLogStore: { query: async () => page },
    mailQueueInspector: { query: async () => ({ messages: [{ sender: SECRET }] }) },
    localServerId: SERVER_ID, now: () => Date.parse('2026-10-27T12:00:00.000Z'),
  });
  app.use((error, request, response, next) => error instanceof LogHttpError
    ? response.status(error.status).json({ error: { code: error.code } }) : next(error));
  const server = http.createServer(withPanelContext(app, context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (pathname) => { const response = await fetch(base + pathname); return { status: response.status, text: await response.text() }; };
}

const SERVER_WIDE = [`/api/servers/${SERVER_ID}/logs/nginx-access`, `/api/servers/${SERVER_ID}/logs/nginx-error`, `/api/servers/${SERVER_ID}/mail/queue`];

for (const role of ['customer', 'reseller', 'site_manager']) {
  test(`${role}: server-wide logs and the mail queue are closed`, async (t) => {
    const get = await serve(t, siteUser(role, [OWN_SITE]));
    for (const pathname of SERVER_WIDE) {
      const result = await get(pathname);
      assert.equal(result.status, 403, pathname);
      assert.equal(result.text.includes(SECRET), false, pathname);
    }
  });

  test(`${role}: application and deploy logs only for applications of their own Websites`, async (t) => {
    const get = await serve(t, siteUser(role, [OWN_SITE]));
    assert.equal((await get(`/api/applications/${OWN_APP}/logs/node`)).status, 200);
    assert.equal((await get(`/api/jobs/${OWN_JOB}/logs/deploy`)).status, 200);
    for (const pathname of [`/api/applications/${FOREIGN_APP}/logs/node`, `/api/jobs/${FOREIGN_JOB}/logs/deploy`]) {
      const result = await get(pathname);
      assert.equal(result.status, 404, pathname);
      assert.equal(result.text.includes(SECRET), false, pathname);
    }
  });
}

test('the Owner keeps server-wide access; the read-only role stays as the route guard decides', async (t) => {
  const owner = await serve(t, ownerManagementContext);
  for (const pathname of SERVER_WIDE) assert.equal((await owner(pathname)).status, 200, pathname);
  assert.equal((await owner(`/api/applications/${FOREIGN_APP}/logs/node`)).status, 200);
  const readOnly = await serve(t, readOnlyManagementContext);
  assert.equal((await readOnly(SERVER_WIDE[0])).status, 403, 'unchanged: no read-only permission maps to server logs');
});
