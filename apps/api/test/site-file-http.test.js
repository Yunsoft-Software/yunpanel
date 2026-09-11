import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { mountSiteFileRoutes, SiteFileHttpError } from '../src/site-file-http.js';
import { ownerManagementContext, readOnlyManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

const WEBSITE_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';

async function serve(t, context = ownerManagementContext) {
  const calls = [];
  const manager = {
    async execute(websiteId, operation) {
      calls.push([websiteId, operation]);
      if (operation.operation === 'download') {
        return { file: { path: operation.path }, content: Buffer.from('downloaded').toString('base64') };
      }
      if (operation.operation === 'read_text') return { file: { path: operation.path }, content: 'text', sha256: 'a'.repeat(64) };
      if (operation.operation === 'upload') return { file: { path: operation.path }, created: operation.path === 'new.bin' };
      if (operation.operation === 'list') return { directory: { path: operation.path }, entries: [] };
      return { operation: operation.operation };
    },
  };
  const app = express();
  mountSiteFileRoutes(app, { siteFileManager: manager });
  app.use((error, _request, response, _next) => {
    if (error instanceof SiteFileHttpError) return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: { code: 'request_body_too_large' } });
    return response.status(error.status ?? 500).json({ error: { code: error.code ?? 'internal_error' } });
  });
  const server = http.createServer(withPanelContext(app, context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls };
}

test('site file HTTP exposes list, text, download and bounded raw upload contracts', async (t) => {
  const state = await serve(t);
  const base = `${state.baseUrl}/api/websites/${WEBSITE_ID}/files`;

  const list = await fetch(`${base}?path=assets`);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal((await list.json()).data.directory.path, 'assets');

  const text = await fetch(`${base}/text?path=index.html`);
  assert.equal(text.status, 200);
  assert.equal((await text.json()).data.content, 'text');

  const download = await fetch(`${base}/download?path=assets%2Frapor%20%C3%B6.txt`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'downloaded');
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''rapor%20%C3%B6\.txt/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

  const upload = await fetch(`${base}/upload?path=new.bin`, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 1, 255]),
  });
  assert.equal(upload.status, 201);
  assert.equal((await upload.json()).data.created, true);
  const uploadCall = state.calls.find(([, operation]) => operation.operation === 'upload')[1];
  assert.deepEqual(Buffer.from(uploadCall.content, 'base64'), Buffer.from([0, 1, 255]));
});

test('site file HTTP validates mutation shapes and exact destructive confirmation', async (t) => {
  const state = await serve(t);
  const base = `${state.baseUrl}/api/websites/${WEBSITE_ID}/files`;
  const json = { 'content-type': 'application/json' };

  assert.equal((await fetch(`${base}/mkdir`, { method: 'POST', headers: json, body: JSON.stringify({ path: 'assets/new' }) })).status, 201);
  assert.equal((await fetch(`${base}/rename`, {
    method: 'POST', headers: json, body: JSON.stringify({ path: 'old.txt', destination: 'new.txt' }),
  })).status, 200);
  assert.equal((await fetch(`${base}/text`, {
    method: 'PUT', headers: json, body: JSON.stringify({ path: 'index.html', content: 'changed', expectedSha256: 'a'.repeat(64) }),
  })).status, 200);

  const denied = await fetch(base, {
    method: 'DELETE', headers: json, body: JSON.stringify({ path: 'assets', confirmation: 'delete:assets' }),
  });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, 'site_file_delete_confirmation_required');
  const deleted = await fetch(base, {
    method: 'DELETE', headers: json, body: JSON.stringify({ path: 'assets', confirmation: `delete:${WEBSITE_ID}:assets` }),
  });
  assert.equal(deleted.status, 200);
  assert.equal(state.calls.some(([, operation]) => operation.operation === 'delete'), true);
});

test('site file HTTP rejects ambiguous queries, wrong upload types and read-only accounts', async (t) => {
  const owner = await serve(t);
  const base = `${owner.baseUrl}/api/websites/${WEBSITE_ID}/files`;
  assert.equal((await fetch(`${base}?path=a&path=b`)).status, 400);
  assert.equal((await fetch(`${base}/download`)).status, 400);
  assert.equal((await fetch(`${base}/upload?path=a`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'bad' })).status, 415);
  assert.equal(owner.calls.length, 0);

  const readOnly = await serve(t, readOnlyManagementContext);
  assert.equal((await fetch(`${readOnly.baseUrl}/api/websites/${WEBSITE_ID}/files`)).status, 403);
  assert.equal(readOnly.calls.length, 0);
});
