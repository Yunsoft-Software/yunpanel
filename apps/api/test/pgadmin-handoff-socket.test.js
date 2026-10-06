import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPgAdminHandoffConsumerHandler,
  pgAdminHandoffSocketInternals,
  startPgAdminHandoffSocket,
} from '../src/pgadmin-handoff-socket.js';
import { PgAdminHandoffError } from '../src/pgadmin-handoff-service.js';

const capability = 'A'.repeat(43);
const sessionDigest = 'd'.repeat(64);
const gatewaySession = 'G'.repeat(43);

async function listenHandler(t, service) {
  const server = http.createServer(createPgAdminHandoffConsumerHandler({
    pgAdminHandoffService: service,
  }));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('pgAdmin private consumer returns the DB secret only after consuming an exact capability', async (t) => {
  const calls = [];
  const base = await listenHandler(t, {
    async consume(value, options) {
      calls.push([value, structuredClone(options)]);
      return {
        version: 1,
        protocol: 'yunpanel-pgadmin-signon-v1',
        serverId: 'ignored',
        websiteId: 'ignored',
        databaseCredentialId: 'ignored',
        databaseBindingId: 'ignored',
        credentialRevision: 3,
        bindingRevision: 2,
        databaseName: 'site_main',
        username: 'ydb_0123456789abcdef01234567',
        password: 'database-secret-value',
        host: 'localhost',
        gatewaySession,
        expiresAt: 50_000,
      };
    },
  });

  const response = await fetch(`${base}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, sessionDigest }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(await response.json(), {
    data: {
      version: 1,
      protocol: 'yunpanel-pgadmin-signon-v1',
      databaseName: 'site_main',
      username: 'ydb_0123456789abcdef01234567',
      password: 'database-secret-value',
      host: 'localhost',
      gatewaySession,
      expiresAt: 50_000,
    },
  });
  assert.deepEqual(calls, [[capability, { sessionDigest }]]);
});

test('pgAdmin private consumer rejects non-consume routes, malformed bodies and service errors', async (t) => {
  let consumeCalls = 0;
  const base = await listenHandler(t, {
    async consume() {
      consumeCalls += 1;
      throw new PgAdminHandoffError(
        'pgadmin_handoff_invalid',
        'pgAdmin handoff is invalid',
        401,
      );
    },
  });

  const getResponse = await fetch(`${base}/consume`);
  assert.equal(getResponse.status, 404);
  assert.equal((await getResponse.json()).error.code, 'pgadmin_handoff_consume_not_found');

  const extra = await fetch(`${base}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, sessionDigest, password: 'forbidden' }),
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error.code, 'pgadmin_handoff_consume_request_invalid');

  const invalid = await fetch(`${base}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, sessionDigest }),
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, 'pgadmin_handoff_invalid');
  assert.equal(consumeCalls, 1);
});

test('pgAdmin socket runtime uses a dedicated root-owned pgAdmin runtime boundary and cleans its socket', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-pgadmin-handoff-'));
  const directory = path.join(root, 'runtime');
  const socketPath = path.join(directory, 'handoff.sock');
  const policyGid = 2468;
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

  const runtime = await startPgAdminHandoffSocket({
    pgAdminHandoffService: {
      async consume(value, options) {
        assert.equal(value, capability);
        assert.deepEqual(options, { sessionDigest });
        return {
          version: 1,
          protocol: 'yunpanel-pgadmin-signon-v1',
          databaseName: 'site_main',
          username: 'ydb_0123456789abcdef01234567',
          password: 'database-secret-value',
          host: 'localhost',
          gatewaySession,
          expiresAt: 50_000,
        };
      },
    },
    socketDirectory: directory,
    socketPath,
    run: async (file, args) => {
      assert.equal(file, '/usr/bin/getent');
      assert.deepEqual(args, ['group', 'yunpanel-pgadmin']);
      return { stdout: `yunpanel-pgadmin:x:${policyGid}:\n` };
    },
    chownFn: async () => {},
    lstatFn: policyLstat,
  });
  assert.equal(runtime.socketPath, socketPath);
  assert.equal(runtime.mode, 0o660);
  assert.equal(runtime.directoryMode, 0o750);

  const payload = JSON.stringify({ capability, sessionDigest });
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
  assert.equal(result.body.data.username, 'ydb_0123456789abcdef01234567');
  assert.equal(result.body.data.password, 'database-secret-value');
  assert.equal(result.body.data.gatewaySession, gatewaySession);

  await runtime.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
});

test('pgAdmin socket runtime refuses a pre-existing non-socket path and invalid group lookup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-pgadmin-handoff-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = { async consume() { throw new Error('not used'); } };

  await assert.rejects(
    startPgAdminHandoffSocket({
      pgAdminHandoffService: service,
      socketDirectory: path.join(root, 'runtime'),
      socketPath: path.join(root, 'runtime', 'handoff.sock'),
      run: async () => ({ stdout: 'other:x:2468:\n' }),
    }),
    { code: 'pgadmin_handoff_socket_group_missing' },
  );
});
