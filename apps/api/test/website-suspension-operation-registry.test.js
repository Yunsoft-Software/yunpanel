import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createWebsiteSuspensionOperationRegistry,
  WebsiteSuspensionOperationRegistryError,
} from '../src/website-suspension-operation-registry.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'website-susp-reg-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('website-suspension-operation-registry persists and validates operations', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const registry = createWebsiteSuspensionOperationRegistry({ filePath });

    const previewDigest = 'a'.repeat(64);
    const op = await registry.create({
      websiteId: 'ws-1',
      serverId: 'srv-1',
      websiteRevision: 1,
      previewDigest,
      confirmation: `start-website-suspend:ws-1:1:${previewDigest}`,
      domainOperations: [
        { domainId: 'dom-1', operationId: null, status: 'pending', error: null },
      ],
    });

    assert.equal(op.websiteId, 'ws-1');
    assert.equal(op.status, 'pending');
    assert.equal(op.domainOperations.length, 1);

    const fetched = await registry.get(op.id);
    assert.deepEqual(fetched, op);

    const list = await registry.listForWebsite('ws-1');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, op.id);

    const updated = await registry.update(op.id, {
      status: 'suspending',
      domainOperations: [
        { domainId: 'dom-1', operationId: 'dom-op-1', status: 'suspending', error: null },
      ],
    });
    assert.equal(updated.status, 'suspending');
    assert.equal(updated.domainOperations[0].operationId, 'dom-op-1');

    const interrupted = await registry.listInterrupted();
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].id, op.id);

    // Persistence reload check
    const reloadRegistry = createWebsiteSuspensionOperationRegistry({ filePath });
    await reloadRegistry.init();
    const reloaded = await reloadRegistry.get(op.id);
    assert.deepEqual(reloaded, updated);

    // Invalid update throws
    await assert.rejects(
      registry.update(op.id, { status: 'invalid_status' }),
      WebsiteSuspensionOperationRegistryError,
    );
  });
});
