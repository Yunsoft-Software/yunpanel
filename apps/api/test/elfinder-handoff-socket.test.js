import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createElFinderHandoffConsumerHandler,
  elFinderHandoffSocketInternals,
  startElFinderHandoffSocket,
} from '../src/elfinder-handoff-socket.js';
import { ElFinderHandoffError } from '../src/elfinder-handoff-service.js';

const capability = 'A'.repeat(43);
const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const applicationId = '32345678-1234-4234-8234-123456789012';
const unixUser = 'yunapp-abcdef012345';
const rootPath = `/var/lib/yunpanel/data/${applicationId}`;

function bundle() {
  return {
    version: 1,
    protocol: 'yunpanel-elfinder-handoff-v1',
    audience: 'elfinder',
    serverId,
    websiteId,
    websiteRevision: 7,
    applicationId,
    unixUser,
    root: rootPath,
    expiresAt: 50_000,
  };
}

async function listenHandler(t, service) {
  const server = http.createServer(createElFinderHandoffConsumerHandler({
    elFinderHandoffService: service,
  }));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('private consumer returns canonical Website filesystem scope only after exact capability consume', async (t) => {
  const calls = [];
  const base = await listenHandler(t, {
    async consume(value) {
      calls.push(value);
      return bundle();
    },
  });

  const response = await fetch(`${base}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(await response.json(), { data: bundle() });
  assert.deepEqual(calls, [capability]);
});

test('private consumer rejects interface expansion and invalid service bundles', async (t) => {
  let consumeCalls = 0;
  const base = await listenHandler(t, {
    async consume() {
      consumeCalls += 1;
      return { ...bundle(), root: '/etc' };
    },
  });

  const getResponse = await fetch(`${base}/consume`);
  assert.equal(getResponse.status, 404);
  assert.equal((await getResponse.json()).error.code, 'elfinder_handoff_consume_not_found');

  const extra = await fetch(`${base}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, root: '/etc' }),
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error.code, 'elfinder_handoff_consume_request_invalid');

  const invalid = await fetch(`${base}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'elfinder_handoff_consume_bundle_invalid');
  assert.equal(consumeCalls, 1);
});

test('private consumer preserves handoff service authorization errors', async (t) => {
  const base = await listenHandler(t, {
    async consume() {
      throw new ElFinderHandoffError('elfinder_handoff_invalid', 'elFinder handoff is invalid', 401);
    },
  });
  const response = await fetch(`${base}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'elfinder_handoff_invalid');
});

test('socket runtime uses a dedicated root-owned elFinder boundary and cleans its socket', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-elfinder-handoff-'));
  const directory = path.join(root, 'runtime');
  const socketPath = path.join(directory, 'handoff.sock');
  const policyGid = 2469;
  t.after(() => rm(root, { recursive: true, force: true }));

  async function policyLstat(target) {
    const metadata = await lstat(target);
    return new Proxy(metadata, {
      get(current, property, receiver) {
        if (property === 'uid') return 0;
        if (property === 'gid') return policyGid;
        return Reflect.get(current, property, receiver);
      },
    });
  }

  const runtime = await startElFinderHandoffSocket({
    elFinderHandoffService: {
      async consume(value) {
        assert.equal(value, capability);
        return bundle();
      },
    },
    socketDirectory: directory,
    socketPath,
    run: async (file, args) => {
      assert.equal(file, '/usr/bin/getent');
      assert.deepEqual(args, ['group', 'yunpanel-elfinder']);
      return { stdout: `yunpanel-elfinder:x:${policyGid}:\n` };
    },
    chownFn: async () => {},
    lstatFn: policyLstat,
  });
  assert.equal(runtime.socketPath, socketPath);
  assert.equal(runtime.mode, 0o660);
  assert.equal(runtime.directoryMode, 0o750);

  const payload = JSON.stringify({ capability });
  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method: 'POST',
      path: '/consume',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.unixUser, unixUser);
  assert.equal(result.body.data.root, rootPath);

  await runtime.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
});

test('socket runtime rejects invalid group lookup and keeps a dedicated default policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-elfinder-handoff-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = { async consume() { throw new Error('not used'); } };

  await assert.rejects(
    startElFinderHandoffSocket({
      elFinderHandoffService: service,
      socketDirectory: path.join(root, 'runtime'),
      socketPath: path.join(root, 'runtime', 'handoff.sock'),
      run: async () => ({ stdout: 'other:x:2469:\n' }),
    }),
    { code: 'elfinder_handoff_socket_group_missing' },
  );

  assert.equal(elFinderHandoffSocketInternals.socketDirectory, '/run/yunpanel-elfinder');
  assert.equal(elFinderHandoffSocketInternals.socketPath, '/run/yunpanel-elfinder/handoff.sock');
  assert.equal(elFinderHandoffSocketInternals.socketGroup, 'yunpanel-elfinder');
  assert.equal(elFinderHandoffSocketInternals.directoryMode, 0o750);
  assert.equal(elFinderHandoffSocketInternals.socketMode, 0o660);
});
