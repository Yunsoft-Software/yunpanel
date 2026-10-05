import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

const WEBSITE_ID = '33333333-3333-4333-8333-333333333333';

async function fixture(t, customFileManager) {
  const operations = [];
  const defaultFileManager = {
    execute: async (websiteId, op) => {
      operations.push({ websiteId, op });
      if (op.operation === 'permissions') return { path: op.path, mode: op.mode, updated: true };
      if (op.operation === 'list') {
        return { path: op.path, entries: [{ name: 'index.html', path: 'index.html', type: 'file', size: 100, mode: '0644' }] };
      }
      if (op.operation === 'create_file') {
        return { created: true, file: { name: 'new.txt', path: op.path, size: 0 } };
      }
      if (op.operation === 'mkdir') {
        return { created: true, directory: { name: 'assets', path: op.path } };
      }
      if (op.operation === 'read_text') {
        return { path: op.path, content: 'test content', sha256: 'abc123' };
      }
      if (op.operation === 'write_text') {
        return { path: op.path, sha256: 'def456', size: op.content.length };
      }
      if (op.operation === 'upload') {
        return { created: true, path: op.path, size: 12 };
      }
      if (op.operation === 'download') {
        return { path: op.path, content: Buffer.from('downloaded-content').toString('base64') };
      }
      if (op.operation === 'delete') {
        return { deleted: true, path: op.path };
      }
      if (op.operation === 'batch_delete') {
        return { deleted: op.paths.map((p) => ({ path: p, deleted: true })) };
      }
      return null;
    },
  };

  const siteFileManager = customFileManager ?? defaultFileManager;
  const server = http.createServer(withPanelContext(createApp({
    environment: 'production',
    siteFileManager,
  }))).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    operations,
    request: (url, options = {}) => fetch(`${base}${url}`, options),
  };
}

test('site-file-http: list files', async (t) => {
  const { request, operations } = await fixture(t);
  const response = await request(`/api/websites/${WEBSITE_ID}/files?path=public`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.entries[0].name, 'index.html');
  assert.equal(operations[0].websiteId, WEBSITE_ID);
  assert.equal(operations[0].op.path, 'public');
});

test('site-file-http: create file and directory', async (t) => {
  const { request } = await fixture(t);

  // create file
  const fileRes = await request(`/api/websites/${WEBSITE_ID}/files/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'robots.txt' }),
  });
  assert.equal(fileRes.status, 201);
  const fileData = (await fileRes.json()).data;
  assert.equal(fileData.created, true);

  // mkdir
  const dirRes = await request(`/api/websites/${WEBSITE_ID}/files/mkdir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'images' }),
  });
  assert.equal(dirRes.status, 201);
  const dirData = (await dirRes.json()).data;
  assert.equal(dirData.created, true);
});

test('site-file-http: read and edit text', async (t) => {
  const { request } = await fixture(t);

  const readRes = await request(`/api/websites/${WEBSITE_ID}/files/text?path=index.html`);
  assert.equal(readRes.status, 200);
  const readData = (await readRes.json()).data;
  assert.equal(readData.content, 'test content');

  const editRes = await request(`/api/websites/${WEBSITE_ID}/files/text`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'index.html',
      content: 'new content',
      expectedSha256: 'abc123',
    }),
  });
  assert.equal(editRes.status, 200);
  const editData = (await editRes.json()).data;
  assert.equal(editData.sha256, 'def456');
});

test('site-file-http: download and upload binary', async (t) => {
  const { request } = await fixture(t);

  const downloadRes = await request(`/api/websites/${WEBSITE_ID}/files/download?path=file.bin`);
  assert.equal(downloadRes.status, 200);
  const downloadText = await downloadRes.text();
  assert.equal(downloadText, 'downloaded-content');

  const uploadRes = await request(`/api/websites/${WEBSITE_ID}/files/upload?path=uploaded.bin`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('hello payload'),
  });
  assert.equal(uploadRes.status, 201);
  const uploadData = (await uploadRes.json()).data;
  assert.equal(uploadData.created, true);
});

test('site-file-http: delete single and batch_delete', async (t) => {
  const { request } = await fixture(t);

  // single delete with correct confirmation
  const deleteRes = await request(`/api/websites/${WEBSITE_ID}/files`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'old.txt',
      confirmation: `delete:${WEBSITE_ID}:old.txt`,
    }),
  });
  assert.equal(deleteRes.status, 200);

  // single delete with incorrect confirmation fails
  const badDeleteRes = await request(`/api/websites/${WEBSITE_ID}/files`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'old.txt',
      confirmation: 'wrong',
    }),
  });
  assert.equal(badDeleteRes.status, 400);

  // batch delete with correct confirmation
  const batchRes = await request(`/api/websites/${WEBSITE_ID}/files/batch-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      paths: ['f1.txt', 'f2.txt'],
      confirmation: `batch-delete:${WEBSITE_ID}`,
    }),
  });
  assert.equal(batchRes.status, 200);
  const batchData = (await batchRes.json()).data;
  assert.equal(batchData.deleted.length, 2);

  // batch delete with underscore route alias
  const batchUnderscoreRes = await request(`/api/websites/${WEBSITE_ID}/files/batch_delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      paths: ['f3.txt'],
      confirmation: `batch-delete:${WEBSITE_ID}`,
    }),
  });
  assert.equal(batchUnderscoreRes.status, 200);
  const batchUnderscoreData = (await batchUnderscoreRes.json()).data;
  assert.equal(batchUnderscoreData.deleted.length, 1);
});


test('permissions use the existing Website file manager and reject malformed requests before dispatch', async (t) => {
  const { request, operations } = await fixture(t);
  const url = `/api/websites/${WEBSITE_ID}/files/permissions`;
  const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'index.html', mode: '640' }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { path: 'index.html', mode: '0640', updated: true });
  assert.deepEqual(operations, [{ websiteId: WEBSITE_ID, op: { operation: 'permissions', path: 'index.html', mode: '0640' } }]);
  for (const body of [{ path: 'index.html', mode: '0777' }, { path: '../secret', mode: '0640' }, { path: 'index.html', mode: '0640', root: '/other' }]) {
    const rejected = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(rejected.status, 400);
  }
  assert.equal(operations.length, 1);
});

test('permissions preserve the file manager failure instead of returning updated success', async (t) => {
  const { SiteFileWorkerError } = await import('../src/site-file-worker.js');
  const { request } = await fixture(t, { execute: async () => { throw new SiteFileWorkerError('site_file_permission_denied', 'Permission denied', 403); } });
  const response = await request(`/api/websites/${WEBSITE_ID}/files/permissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'index.html', mode: '0640' }) });
  assert.equal(response.status, 403);
  const body = await response.json(); assert.equal(body.error.code, 'site_file_permission_denied'); assert.equal(body.data, undefined);
});

test('permissions require authenticated management context before file access', async (t) => {
  let calls = 0;
  const server = http.createServer(createApp({ environment: 'production', siteFileManager: { execute: async () => { calls++; } } })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/websites/${WEBSITE_ID}/files/permissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'index.html', mode: '0640' }) });
  assert.equal(response.status, 401); assert.equal(calls, 0);
});
