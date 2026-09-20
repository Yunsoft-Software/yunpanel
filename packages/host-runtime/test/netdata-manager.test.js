import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNetdataManager } from '../src/netdata-manager.js';

test('createNetdataManager configures and inspects loopback Netdata configuration', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-netdata-test-'));
  const configPath = path.join(dir, 'netdata.conf');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const manager = createNetdataManager({ configPath });

  // Initial inspect: file doesn't exist
  const initial = await manager.inspectConfiguration();
  assert.equal(initial.exists, false);
  assert.equal(initial.isLoopbackOnly, false);

  // Configure loopback
  const result = await manager.configureLoopback({ address: '127.0.0.1', port: 19999 });
  assert.equal(result.configured, true);
  assert.equal(result.bindAddress, '127.0.0.1');
  assert.equal(result.port, 19999);

  // Inspect after configuration
  const inspected = await manager.inspectConfiguration();
  assert.equal(inspected.exists, true);
  assert.equal(inspected.bindAddress, '127.0.0.1');
  assert.equal(inspected.port, 19999);
  assert.equal(inspected.isLoopbackOnly, true);
});

test('createNetdataManager rejects unsafe non-loopback addresses when configuring', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-netdata-test-'));
  const configPath = path.join(dir, 'netdata.conf');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const manager = createNetdataManager({ configPath });

  await assert.rejects(
    () => manager.configureLoopback({ address: '0.0.0.0' }),
    /Netdata must bind exclusively to a loopback address/,
  );
});
