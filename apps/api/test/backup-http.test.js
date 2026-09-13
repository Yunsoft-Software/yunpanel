import assert from 'node:assert/strict';
import test from 'node:test';
import { BackupHttpError, mountBackupRoutes } from '../src/backup-http.js';
import { requirePanelRouteAccess } from '../src/panel-http-guard.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function routeFixture(preview = async (input) => ({ ...input, previewDigest: 'a'.repeat(64), sideEffects: false })) {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push({ path, handlers }); },
  };
  mountBackupRoutes(app, { backupResourceProvider: { preview } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/backups/preview');
  assert.equal(routes[0].handlers[0], requirePanelRouteAccess);
  return routes[0].handlers[1];
}

async function invoke(handler, body) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  let forwarded = null;
  await handler({ body }, response, (error) => { forwarded = error; });
  return { response, forwarded };
}

test('general backup preview route is management guarded and forwards exact selection intent', async () => {
  let received = null;
  const handler = routeFixture(async (input) => {
    received = input;
    return { serverId: input.serverId, selectionMode: 'explicit', previewDigest: 'b'.repeat(64), sideEffects: false };
  });
  const selectedResourceIdentities = ['application:84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8'];
  const { response, forwarded } = await invoke(handler, { serverId, selectedResourceIdentities });

  assert.equal(forwarded, null);
  assert.deepEqual(received, { serverId, selectedResourceIdentities });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.serverId, serverId);
  assert.equal(response.body.data.selectionMode, 'explicit');
  assert.equal(response.body.data.sideEffects, false);
});

test('general backup preview route defaults to all managed resources', async () => {
  let received = null;
  const handler = routeFixture(async (input) => {
    received = input;
    return { previewDigest: 'c'.repeat(64), sideEffects: false };
  });
  const { forwarded } = await invoke(handler, { serverId });
  assert.equal(forwarded, null);
  assert.deepEqual(received, { serverId, selectedResourceIdentities: null });
});

test('general backup preview route rejects malformed or expanded request bodies', async () => {
  const handler = routeFixture();
  for (const body of [
    null,
    {},
    { serverId: 'not-a-uuid' },
    { serverId, selectedResourceIdentities: 'all' },
    { serverId, selectedResourceIdentities: [], force: true },
  ]) {
    const { forwarded } = await invoke(handler, body);
    assert.ok(forwarded instanceof BackupHttpError);
    assert.equal(forwarded.code, 'backup_preview_input_invalid');
    assert.equal(forwarded.status, 400);
  }
});

test('general backup preview route forwards provider failure without rewriting evidence errors', async () => {
  const expected = new Error('provider failed');
  const handler = routeFixture(async () => { throw expected; });
  const { forwarded } = await invoke(handler, { serverId });
  assert.equal(forwarded, expected);
});
