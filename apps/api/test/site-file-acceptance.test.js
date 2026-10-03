import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createSiteResourceBoundary } from '../src/site-resource-boundary.js';
import { createTenantBoundaryMiddleware } from '../src/tenant-boundary.js';
import { mountSiteFileRoutes, SiteFileHttpError } from '../src/site-file-http.js';
import { mountElFinderHandoffRoutes } from '../src/elfinder-handoff-http.js';
import { ElFinderHandoffError } from '../src/elfinder-handoff-service.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const siteAId = '11111111-1111-4111-8111-111111111111';
const siteBId = '22222222-2222-4222-8222-222222222222';
const dummyDigest = 'a'.repeat(64);

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function setupAcceptanceServer(t) {
  const websites = new Map([
    [siteAId, {
      id: siteAId,
      serverId,
      name: 'SiteA',
      runtimeType: 'node',
      applicationId: '33333333-3333-4333-8333-333333333333',
      unixUser: 'yunapp-333333333333',
      revision: 1,
      customerId: 'customer-a',
      resellerId: 'reseller-a',
    }],
    [siteBId, {
      id: siteBId,
      serverId,
      name: 'SiteB',
      runtimeType: 'php',
      applicationId: '44444444-4444-4444-8444-444444444444',
      unixUser: 'yunapp-444444444444',
      revision: 1,
      customerId: 'customer-b',
      resellerId: 'reseller-b',
    }],
  ]);

  const customers = new Map([
    ['customer-a', { id: 'customer-a', kind: 'customer', resellerId: 'reseller-a', active: true }],
    ['customer-b', { id: 'customer-b', kind: 'customer', resellerId: 'reseller-b', active: true }],
  ]);

  const websiteRegistry = {
    async getWebsite(id) { return websites.get(id) ?? null; },
    async listWebsites() { return Array.from(websites.values()); },
  };

  const domainRegistry = {
    async getDomain(id) {
      if (id === 'domain-a') return { id: 'domain-a', websiteId: siteAId, serverId };
      if (id === 'domain-b') return { id: 'domain-b', websiteId: siteBId, serverId };
      return null;
    },
    async listDomains() {
      return [
        { id: 'domain-a', websiteId: siteAId, serverId },
        { id: 'domain-b', websiteId: siteBId, serverId },
      ];
    },
  };

  const customerLookup = async (id) => customers.get(id) ?? null;

  // In-memory virtual file system per site
  const siteStorage = new Map([
    [siteAId, new Map([
      ['index.html', { content: '<html>Site A</html>', sha256: hash('<html>Site A</html>'), mode: '0640', type: 'file', size: 19 }],
      ['config.json', { content: '{"site":"A"}', sha256: hash('{"site":"A"}'), mode: '0640', type: 'file', size: 12 }],
    ])],
    [siteBId, new Map([
      ['index.php', { content: '<?php echo "Site B"; ?>', sha256: hash('<?php echo "Site B"; ?>'), mode: '0640', type: 'file', size: 24 }],
    ])],
  ]);

  const fileOperations = [];

  const siteFileManager = {
    async execute(websiteId, op) {
      fileOperations.push({ websiteId, op });
      const store = siteStorage.get(websiteId);
      if (!store) {
        throw new SiteFileHttpError('site_file_not_found', 'Website file storage not found', 404);
      }

      if (op.operation === 'list') {
        const entries = [];
        for (const [filePath, data] of store) {
          entries.push({
            name: filePath,
            path: filePath,
            type: data.type,
            size: data.size,
            mode: data.mode,
            modifiedAt: new Date().toISOString(),
          });
        }
        return { path: op.path ?? '', entries };
      }

      if (op.operation === 'read_text') {
        const item = store.get(op.path);
        if (!item) throw new SiteFileHttpError('site_file_not_found', 'File not found', 404);
        return { path: op.path, content: item.content, sha256: item.sha256 };
      }

      if (op.operation === 'write_text') {
        const item = store.get(op.path);
        if (!item) throw new SiteFileHttpError('site_file_not_found', 'File not found', 404);
        if (item.sha256 !== op.expectedSha256) {
          throw new SiteFileHttpError('site_file_changed', 'File changed since it was opened', 409);
        }
        const newSha256 = hash(op.content);
        item.content = op.content;
        item.sha256 = newSha256;
        item.size = Buffer.byteLength(op.content, 'utf8');
        return { path: op.path, sha256: newSha256, size: item.size };
      }

      if (op.operation === 'create_file') {
        if (store.has(op.path)) throw new SiteFileHttpError('site_file_exists', 'Destination already exists', 409);
        const newSha256 = hash('');
        store.set(op.path, { content: '', sha256: newSha256, mode: '0640', type: 'file', size: 0 });
        return { created: true, file: { path: op.path, name: op.path, size: 0, mode: '0640' } };
      }

      if (op.operation === 'mkdir') {
        if (store.has(op.path)) throw new SiteFileHttpError('site_file_exists', 'Destination already exists', 409);
        store.set(op.path, { content: null, sha256: null, mode: '0750', type: 'directory', size: null });
        return { created: true, directory: { path: op.path, name: op.path, mode: '0750' } };
      }

      if (op.operation === 'upload') {
        const content = Buffer.from(op.content, 'base64').toString('utf8');
        const newSha256 = hash(content);
        const exists = store.has(op.path);
        store.set(op.path, { content, sha256: newSha256, mode: '0640', type: 'file', size: Buffer.byteLength(content, 'utf8') });
        return { created: !exists, path: op.path, size: Buffer.byteLength(content, 'utf8') };
      }

      if (op.operation === 'download') {
        const item = store.get(op.path);
        if (!item) throw new SiteFileHttpError('site_file_not_found', 'File not found', 404);
        return { path: op.path, content: Buffer.from(item.content).toString('base64') };
      }

      if (op.operation === 'rename') {
        const item = store.get(op.path);
        if (!item) throw new SiteFileHttpError('site_file_not_found', 'File not found', 404);
        store.delete(op.path);
        store.set(op.destination, item);
        return { path: op.destination, previousPath: op.path };
      }

      if (op.operation === 'permissions') {
        const item = store.get(op.path);
        if (!item) throw new SiteFileHttpError('site_file_not_found', 'File not found', 404);
        item.mode = op.mode;
        return { path: op.path, mode: op.mode, updated: true };
      }

      if (op.operation === 'delete') {
        if (!store.has(op.path)) throw new SiteFileHttpError('site_file_not_found', 'File not found', 404);
        store.delete(op.path);
        return { deleted: true, path: op.path };
      }

      if (op.operation === 'batch_delete') {
        const deleted = [];
        for (const p of op.paths) {
          if (store.has(p)) {
            store.delete(p);
            deleted.push({ path: p, deleted: true });
          }
        }
        return { deleted };
      }

      throw new SiteFileHttpError('site_file_operation_unsupported', 'Unsupported operation', 400);
    },
  };

  const elFinderHandoffService = {
    async issue({ serverId: srvId, websiteId: wId }) {
      if (srvId !== serverId) {
        throw new ElFinderHandoffError('elfinder_handoff_server_not_local', 'Server not local', 404);
      }
      const site = websites.get(wId);
      if (!site) {
        throw new ElFinderHandoffError('elfinder_handoff_website_not_found', 'Website not found', 404);
      }
      return {
        capability: `cap-${wId}-${Date.now()}`,
        expiresAt: Date.now() + 30000,
        protocol: 'yunpanel-elfinder-handoff-v1',
        audience: 'elfinder',
        target: { serverId: srvId, websiteId: wId },
      };
    },
  };

  const serverRegistry = {
    async getServer(id) {
      if (id === serverId) return { id: serverId, hostname: 'panel.internal', executionMode: 'direct' };
      return null;
    },
  };

  let currentAuth = null;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = currentAuth;
    req.authSessionDigest = dummyDigest;
    next();
  });

  app.use(createTenantBoundaryMiddleware({
    websiteRegistry,
    customerLookup,
    websiteLookup: async (id) => websiteRegistry.getWebsite(id),
  }));

  app.use(createSiteResourceBoundary({
    websiteRegistry,
    domainRegistry,
    localServerId: serverId,
    customerLookup,
  }));

  mountSiteFileRoutes(app, { siteFileManager });
  mountElFinderHandoffRoutes(app, {
    registry: serverRegistry,
    elFinderHandoffService,
  });

  app.use((error, req, res, _next) => {
    const status = error.status ?? 500;
    res.status(status).json({
      error: { code: error.code ?? 'error', message: error.message },
    });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    setAuth: (auth) => { currentAuth = auth; },
    siteStorage,
    fileOperations,
  };
}

test('UX-PL-01f Acceptance: Owner has full file management access across all websites', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);

  setAuth({
    id: 'session-owner',
    user: { id: 'user-owner', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // 1. Owner lists Site A files
  const listResA = await fetch(`${baseUrl}/api/websites/${siteAId}/files?path=`);
  assert.equal(listResA.status, 200);
  const listA = await listResA.json();
  assert.equal(listA.data.entries.length, 2);

  // 2. Owner lists Site B files
  const listResB = await fetch(`${baseUrl}/api/websites/${siteBId}/files?path=`);
  assert.equal(listResB.status, 200);
  const listB = await listResB.json();
  assert.equal(listB.data.entries.length, 1);

  // 3. Owner reads text from Site A
  const readRes = await fetch(`${baseUrl}/api/websites/${siteAId}/files/text?path=index.html`);
  assert.equal(readRes.status, 200);
  const readData = await readRes.json();
  assert.equal(readData.data.content, '<html>Site A</html>');

  // 4. Owner writes text to Site A with matching hash
  const writeRes = await fetch(`${baseUrl}/api/websites/${siteAId}/files/text`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'index.html',
      content: '<html>Updated Site A</html>',
      expectedSha256: readData.data.sha256,
    }),
  });
  assert.equal(writeRes.status, 200);
  const writeData = await writeRes.json();
  assert.equal(writeData.data.sha256, hash('<html>Updated Site A</html>'));

  // 5. Owner creates elFinder handoff for Site A and Site B
  const elfinderResA = await fetch(`${baseUrl}/api/servers/${serverId}/websites/${siteAId}/elfinder-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(elfinderResA.status, 201);
  const elfinderDataA = await elfinderResA.json();
  assert.equal(elfinderDataA.data.target.websiteId, siteAId);

  const elfinderResB = await fetch(`${baseUrl}/api/servers/${serverId}/websites/${siteBId}/elfinder-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(elfinderResB.status, 201);
});

test('UX-PL-01f Acceptance: Site A manager has file access for Site A and is blocked from Site B (403)', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);

  // Site A manager authentication context
  setAuth({
    id: 'session-site-a',
    user: { id: 'mgr-a', role: 'site_manager', websiteIds: [siteAId], active: true },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // 1. Authorized access: Site A manager lists Site A files
  const listRes = await fetch(`${baseUrl}/api/websites/${siteAId}/files?path=`);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.ok(listData.data.entries.some((e) => e.name === 'index.html'));

  // 2. Authorized access: Site A manager reads text file on Site A
  const readRes = await fetch(`${baseUrl}/api/websites/${siteAId}/files/text?path=index.html`);
  assert.equal(readRes.status, 200);

  // 3. Authorized access: Site A manager creates a file on Site A
  const createRes = await fetch(`${baseUrl}/api/websites/${siteAId}/files/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'test-mgr.txt' }),
  });
  assert.equal(createRes.status, 201);

  // 4. Authorized access: Site A manager issues elFinder handoff for Site A
  const elfinderRes = await fetch(`${baseUrl}/api/servers/${serverId}/websites/${siteAId}/elfinder-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(elfinderRes.status, 201);

  // 5. UNAUTHORIZED: Site A manager attempts to read Site B files -> 403
  const badListRes = await fetch(`${baseUrl}/api/websites/${siteBId}/files?path=`);
  assert.equal(badListRes.status, 403);
  const badList = await badListRes.json();
  assert.ok(['tenant_boundary_forbidden', 'site_scope_forbidden'].includes(badList.error.code));

  // 6. UNAUTHORIZED: Site A manager attempts to read Site B text -> 403
  const badTextRes = await fetch(`${baseUrl}/api/websites/${siteBId}/files/text?path=index.php`);
  assert.equal(badTextRes.status, 403);

  // 7. UNAUTHORIZED: Site A manager attempts to write Site B text -> 403
  const badWriteRes = await fetch(`${baseUrl}/api/websites/${siteBId}/files/text`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'index.php', content: 'hack', expectedSha256: 'a'.repeat(64) }),
  });
  assert.equal(badWriteRes.status, 403);

  // 8. UNAUTHORIZED: Site A manager attempts to delete Site B files -> 403
  const badDelRes = await fetch(`${baseUrl}/api/websites/${siteBId}/files`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'index.php', confirmation: `delete:${siteBId}:index.php` }),
  });
  assert.equal(badDelRes.status, 403);

  // 9. UNAUTHORIZED: Site A manager attempts elFinder handoff for Site B -> 403
  const badElfinderRes = await fetch(`${baseUrl}/api/servers/${serverId}/websites/${siteBId}/elfinder-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(badElfinderRes.status, 403);
  const badElfinder = await badElfinderRes.json();
  assert.ok(['tenant_boundary_forbidden', 'elfinder_handoff_authorized_required'].includes(badElfinder.error.code));
});

test('UX-PL-01f Acceptance: Customer and Reseller tenant boundary isolation for file operations', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);

  // Customer A context
  setAuth({
    id: 'session-cust-a',
    user: { id: 'customer-a', role: 'customer', websiteIds: [siteAId], hosting: { kind: 'customer' }, active: true },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // Customer A accesses Site A: OK
  const listA = await fetch(`${baseUrl}/api/websites/${siteAId}/files?path=`);
  assert.equal(listA.status, 200);

  // Customer A accesses Site B: 403
  const listB = await fetch(`${baseUrl}/api/websites/${siteBId}/files?path=`);
  assert.equal(listB.status, 403);

  // Reseller B context (owns Customer B / Site B)
  setAuth({
    id: 'session-reseller-b',
    user: { id: 'reseller-b', role: 'reseller', websiteIds: [siteBId], hosting: { kind: 'reseller' }, active: true },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // Reseller B accesses Site B: OK
  const resB = await fetch(`${baseUrl}/api/websites/${siteBId}/files?path=`);
  assert.equal(resB.status, 200);

  // Reseller B attempts Site A: 403
  const resA = await fetch(`${baseUrl}/api/websites/${siteAId}/files?path=`);
  assert.equal(resA.status, 403);
});

test('UX-PL-01f Acceptance: Suspended and Inactive accounts fail-closed on file operations', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);

  // Inactive site manager
  setAuth({
    id: 'session-inactive',
    user: { id: 'mgr-inactive', role: 'site_manager', websiteIds: [siteAId], active: false },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  const res = await fetch(`${baseUrl}/api/websites/${siteAId}/files?path=`);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.ok(['tenant_actor_inactive', 'site_scope_forbidden'].includes(data.error.code));

  // Inactive elFinder bootstrap
  const bootstrapRes = await fetch(`${baseUrl}/api/elfinder-bootstrap-access`);
  assert.equal(bootstrapRes.status, 403);
});

test('UX-PL-01f Acceptance: Concurrent save race detection via expectedSha256 prevents dirty overwrite', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);

  setAuth({
    id: 'session-owner',
    user: { id: 'user-owner', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // Initial read gets hash H0
  const readRes = await fetch(`${baseUrl}/api/websites/${siteAId}/files/text?path=config.json`);
  assert.equal(readRes.status, 200);
  const initial = await readRes.json();
  const hash0 = initial.data.sha256;

  // Tab 1 / Writer 1 updates file to H1 using expectedSha256 H0 -> succeeds
  const update1Res = await fetch(`${baseUrl}/api/websites/${siteAId}/files/text`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'config.json',
      content: '{"site":"A","v":1}',
      expectedSha256: hash0,
    }),
  });
  assert.equal(update1Res.status, 200);
  const updated1 = await update1Res.json();
  const hash1 = updated1.data.sha256;
  assert.notEqual(hash1, hash0);

  // Tab 2 / Writer 2 (who still held hash0) attempts to save -> 409 Conflict
  const update2Res = await fetch(`${baseUrl}/api/websites/${siteAId}/files/text`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'config.json',
      content: '{"site":"A","v":2}',
      expectedSha256: hash0, // Stale!
    }),
  });
  assert.equal(update2Res.status, 409);
  const errorData = await update2Res.json();
  assert.equal(errorData.error.code, 'site_file_changed');

  // Verify the file on server retains Writer 1's content and was NOT corrupted
  const verifyRes = await fetch(`${baseUrl}/api/websites/${siteAId}/files/text?path=config.json`);
  const verifyData = await verifyRes.json();
  assert.equal(verifyData.data.content, '{"site":"A","v":1}');
  assert.equal(verifyData.data.sha256, hash1);
});
