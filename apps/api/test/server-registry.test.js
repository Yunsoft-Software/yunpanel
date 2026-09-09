import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServerRegistry, RegistryError } from '../src/server-registry.js';

async function withRegistry(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-registry-'));
  const filePath = path.join(directory, 'servers.json');
  let clock = Date.parse('2026-09-08T20:30:00.000Z');
  const registry = createServerRegistry({ filePath, now: () => clock, offlineAfterMs: 90_000 });

  try {
    await registry.init();
    await callback({ registry, filePath, advance: (milliseconds) => { clock += milliseconds; } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('enrollment tokens are one-time and persisted only as hashes', async () => {
  await withRegistry(async ({ registry, filePath }) => {
    const enrollment = await registry.issueEnrollmentToken({ label: 'test-server' });
    const persistedBeforeEnrollment = await readFile(filePath, 'utf8');

    assert.equal(persistedBeforeEnrollment.includes(enrollment.token), false);

    const enrolled = await registry.enrollServer({
      token: enrollment.token,
      hostname: 'yun-test-01.example.local',
      displayName: 'Yun Test 01',
    });

    assert.equal(enrolled.server.hostname, 'yun-test-01.example.local');
    assert.equal(enrolled.server.connectivity, 'pending');
    assert.equal(enrolled.server.executionMode, 'agent');
    assert.ok(enrolled.agentToken.length >= 32);

    const persistedAfterEnrollment = await readFile(filePath, 'utf8');
    assert.equal(persistedAfterEnrollment.includes(enrollment.token), false);
    assert.equal(persistedAfterEnrollment.includes(enrolled.agentToken), false);

    await assert.rejects(
      registry.enrollServer({ token: enrollment.token, hostname: 'another.example.local' }),
      (error) => error instanceof RegistryError && error.code === 'invalid_enrollment_token',
    );
  });
});

test('heartbeat requires the enrolled agent credential and updates connectivity', async () => {
  await withRegistry(async ({ registry, advance }) => {
    const enrollment = await registry.issueEnrollmentToken();
    const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'yun-test-02' });

    await assert.rejects(
      registry.heartbeat({ serverId: enrolled.server.id, agentToken: 'wrong-agent-token-value' }),
      (error) => error instanceof RegistryError && error.code === 'invalid_agent_credentials',
    );

    const updated = await registry.heartbeat({
      serverId: enrolled.server.id,
      agentToken: enrolled.agentToken,
      agentVersion: '0.0.1',
      inventory: { os: { name: 'Ubuntu', version: '24.04' } },
      services: { nginx: { active: true } },
    });

    assert.equal(updated.connectivity, 'online');
    assert.equal(updated.agentVersion, '0.0.1');
    assert.equal(updated.inventory.os.version, '24.04');

    advance(91_000);
    const [stale] = await registry.listServers();
    assert.equal(stale.connectivity, 'offline');
  });
});

test('duplicate hostnames and invalid hostnames are rejected', async () => {
  await withRegistry(async ({ registry }) => {
    const first = await registry.issueEnrollmentToken();
    await registry.enrollServer({ token: first.token, hostname: 'yun-prod-01' });

    const second = await registry.issueEnrollmentToken();
    await assert.rejects(
      registry.enrollServer({ token: second.token, hostname: 'YUN-PROD-01' }),
      (error) => error instanceof RegistryError && error.code === 'server_exists',
    );

    const third = await registry.issueEnrollmentToken();
    await assert.rejects(
      registry.enrollServer({ token: third.token, hostname: '../etc/passwd' }),
      (error) => error instanceof RegistryError && error.code === 'invalid_hostname',
    );
  });
});

test('local execution binding is explicit, hostname-bound and blocks the legacy agent channel', async () => {
  await withRegistry(async ({ registry, filePath }) => {
    const token = await registry.issueEnrollmentToken();
    const enrolled = await registry.enrollServer({ token: token.token, hostname: 'local-runtime-host' });

    await assert.rejects(
      registry.bindLocalServer({ serverId: enrolled.server.id, hostname: 'different-host' }),
      (error) => error instanceof RegistryError && error.code === 'local_server_hostname_mismatch',
    );
    assert.equal((await registry.getServer(enrolled.server.id)).executionMode, 'agent');

    const bound = await registry.bindLocalServer({ serverId: enrolled.server.id, hostname: 'LOCAL-RUNTIME-HOST' });
    assert.equal(bound.executionMode, 'local');
    assert.ok(bound.localBoundAt);
    assert.equal(bound.agentVersion, null);

    await assert.rejects(
      registry.authenticateAgent({ serverId: enrolled.server.id, agentToken: enrolled.agentToken }),
      (error) => error instanceof RegistryError && error.code === 'server_managed_locally',
    );

    const snapshot = await registry.updateLocalSnapshot({
      serverId: enrolled.server.id,
      hostname: 'local-runtime-host',
      runtimeVersion: '0.2.0',
      inventory: { hostname: 'local-runtime-host', operatingSystem: { prettyName: 'Ubuntu 24.04' } },
      services: { nginx: { active: true } },
    });
    assert.equal(snapshot.connectivity, 'online');
    assert.equal(snapshot.localRuntimeVersion, '0.2.0');
    assert.equal(snapshot.inventory.operatingSystem.prettyName, 'Ubuntu 24.04');

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    const stored = persisted.servers.find((server) => server.id === enrolled.server.id);
    assert.equal(stored.executionMode, 'local');
    assert.equal(stored.localRuntimeVersion, '0.2.0');
  });
});

test('local execution mode can roll back to the original enrolled agent credential', async () => {
  await withRegistry(async ({ registry }) => {
    const token = await registry.issueEnrollmentToken();
    const enrolled = await registry.enrollServer({ token: token.token, hostname: 'rollback-runtime-host' });
    await registry.bindLocalServer({ serverId: enrolled.server.id, hostname: 'rollback-runtime-host' });
    await registry.updateLocalSnapshot({ serverId: enrolled.server.id, hostname: 'rollback-runtime-host', runtimeVersion: '0.2.0' });

    const released = await registry.releaseLocalServer({ serverId: enrolled.server.id, hostname: 'rollback-runtime-host' });
    assert.equal(released.executionMode, 'agent');
    assert.equal(released.localBoundAt, null);
    assert.equal(released.localRuntimeVersion, null);

    const heartbeat = await registry.heartbeat({
      serverId: enrolled.server.id,
      agentToken: enrolled.agentToken,
      agentVersion: 'legacy-agent',
    });
    assert.equal(heartbeat.executionMode, 'agent');
    assert.equal(heartbeat.agentVersion, 'legacy-agent');
    assert.equal(heartbeat.connectivity, 'online');
  });
});
