import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServerRegistry, RegistryError } from '../src/server-registry.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-local-only-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'server-registry.json');
  const now = () => Date.parse('2026-09-10T09:45:00.000Z');
  const registry = createServerRegistry({ filePath, now });
  await registry.init();
  return { registry, filePath };
}

test('local-only server creation persists no legacy agent credential', async (t) => {
  const { registry, filePath } = await fixture(t);
  const server = await registry.createLocalServer({
    hostname: 'Fresh-Local-Host',
    displayName: 'Fresh Local Host',
  });

  assert.equal(server.hostname, 'fresh-local-host');
  assert.equal(server.name, 'Fresh Local Host');
  assert.equal(server.executionMode, 'local');
  assert.equal(server.localBoundAt, '2026-09-10T09:45:00.000Z');
  assert.equal(server.enrolledAt, null);
  assert.equal(server.agentVersion, null);
  assert.equal(server.connectivity, 'pending');

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.servers.length, 1);
  assert.equal(persisted.servers[0].id, server.id);
  assert.equal(persisted.servers[0].executionMode, 'local');
  assert.equal(persisted.servers[0].agentTokenHash, null);
  assert.equal(persisted.servers[0].enrolledAt, null);
  assert.doesNotMatch(JSON.stringify(persisted), /development-only-token|YUN_AGENT_TOKEN/);
});

test('local-only and legacy-enrolled servers share one hostname uniqueness boundary', async (t) => {
  const { registry } = await fixture(t);
  await registry.createLocalServer({ hostname: 'duplicate-host' });

  await assert.rejects(
    registry.createLocalServer({ hostname: 'DUPLICATE-HOST' }),
    (error) => error instanceof RegistryError && error.code === 'server_exists',
  );

  const token = await registry.issueEnrollmentToken();
  await assert.rejects(
    registry.enrollServer({ token: token.token, hostname: 'duplicate-host' }),
    (error) => error instanceof RegistryError && error.code === 'server_exists',
  );
});

test('credentialless local server cannot authenticate or fall back to legacy agent ownership', async (t) => {
  const { registry } = await fixture(t);
  const server = await registry.createLocalServer({ hostname: 'local-only-host' });

  await assert.rejects(
    registry.authenticateAgent({ serverId: server.id, agentToken: 'arbitrary-agent-token-value' }),
    (error) => error instanceof RegistryError && error.code === 'invalid_agent_credentials',
  );

  await assert.rejects(
    registry.releaseLocalServer({ serverId: server.id, hostname: 'local-only-host' }),
    (error) => error instanceof RegistryError && error.code === 'agent_credentials_unavailable',
  );

  const unchanged = await registry.getServer(server.id);
  assert.equal(unchanged.executionMode, 'local');
  assert.equal(unchanged.localBoundAt, '2026-09-10T09:45:00.000Z');
});

test('local-only server snapshot uses the same hostname-bound runtime path', async (t) => {
  const { registry } = await fixture(t);
  const server = await registry.createLocalServer({ hostname: 'snapshot-local-host' });

  await assert.rejects(
    registry.updateLocalSnapshot({ serverId: server.id, hostname: 'wrong-host', runtimeVersion: '0.3.0' }),
    (error) => error instanceof RegistryError && error.code === 'local_server_hostname_mismatch',
  );

  const updated = await registry.updateLocalSnapshot({
    serverId: server.id,
    hostname: 'snapshot-local-host',
    runtimeVersion: '0.3.0',
    inventory: { hostname: 'snapshot-local-host' },
  });
  assert.equal(updated.executionMode, 'local');
  assert.equal(updated.connectivity, 'online');
  assert.equal(updated.localRuntimeVersion, '0.3.0');
  assert.equal(updated.inventory.hostname, 'snapshot-local-host');
});
