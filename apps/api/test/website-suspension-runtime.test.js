import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createWebsiteSuspensionOperationRegistry,
} from '../src/website-suspension-operation-registry.js';
import {
  createWebsiteSuspensionRuntime,
  WebsiteSuspensionRuntimeError,
} from '../src/website-suspension-runtime.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'website-susp-rt-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('website-suspension-runtime manages website suspension preview, start and resume lifecycle', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const registry = createWebsiteSuspensionOperationRegistry({ filePath });
    const localServerId = 'srv-local';

    const testWebsite = {
      id: 'ws-1',
      serverId: localServerId,
      name: 'example-site',
      revision: 1,
    };

    const domain1 = {
      id: 'dom-1',
      serverId: localServerId,
      websiteId: 'ws-1',
      primaryDomain: 'example.com',
      state: 'active',
    };

    const domain2 = {
      id: 'dom-2',
      serverId: localServerId,
      websiteId: 'ws-1',
      primaryDomain: 'sub.example.com',
      state: 'active',
    };

    const websiteRegistry = {
      getWebsite: async (id) => (id === 'ws-1' ? testWebsite : null),
    };

    const domainRegistry = {
      listDomains: async () => [domain1, domain2],
    };

    let domainSuspendedState = new Map();
    const domainSuspensionRuntime = {
      preview: async ({ domainId }) => {
        const isSusp = domainSuspendedState.get(domainId) === 'suspended';
        return {
          readyToSuspend: !isSusp,
          previewDigest: 'd'.repeat(64),
          confirmation: `start-domain-suspend:${domainId}:1:${'d'.repeat(64)}`,
        };
      },
      start: async ({ domainId, confirmation }) => {
        domainSuspendedState.set(domainId, 'suspended');
        return {
          id: `op-${domainId}`,
          domainId,
          status: 'suspended',
          checksum: 'c'.repeat(64),
          updatedAt: '2026-09-19T20:00:00.000Z',
        };
      },
      get: async (id) => {
        const domainId = id.replace('op-', '');
        return {
          id,
          domainId,
          status: domainSuspendedState.get(domainId) || 'active',
          checksum: 'c'.repeat(64),
          updatedAt: '2026-09-19T20:00:00.000Z',
        };
      },
      resume: async ({ domainId }) => {
        domainSuspendedState.set(domainId, 'active');
        return {
          id: `op-${domainId}`,
          domainId,
          status: 'resumed',
          checksum: 'c'.repeat(64),
          updatedAt: '2026-09-19T20:01:00.000Z',
        };
      },
    };

    const runtime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry,
      domainRegistry,
      domainSuspensionRuntime,
      localServerId,
    });

    // 1. Preview
    const p = await runtime.preview({ websiteId: 'ws-1' });
    assert.equal(p.readyToSuspend, true);
    assert.equal(p.readyToResume, false);
    assert.equal(p.domains.length, 2);
    assert.ok(p.confirmation.startsWith('start-website-suspend:ws-1:1:'));

    // 2. Start (both succeed -> suspended)
    const op = await runtime.start({
      websiteId: 'ws-1',
      previewDigest: p.previewDigest,
      confirmation: p.confirmation,
    });
    assert.equal(op.status, 'suspended');
    assert.equal(op.domainOperations.length, 2);
    assert.ok(op.domainOperations.every((d) => d.status === 'suspended'));
    assert.ok(op.actions.resumeConfirmation);

    // 3. Resume
    const resumed = await runtime.resume({
      websiteId: 'ws-1',
      operationId: op.id,
      expectedUpdatedAt: op.updatedAt,
      confirmation: op.actions.resumeConfirmation,
    });
    assert.equal(resumed.status, 'resumed');
    assert.ok(resumed.domainOperations.every((d) => d.status === 'resumed'));

    // 4. Partial failure scenario: one domain fails on start
    domainSuspendedState.clear();
    const failingDomainSuspensionRuntime = {
      ...domainSuspensionRuntime,
      start: async ({ domainId }) => {
        if (domainId === 'dom-2') {
          throw new Error('Nginx reload failed for dom-2');
        }
        domainSuspendedState.set(domainId, 'suspended');
        return {
          id: `op-${domainId}`,
          domainId,
          status: 'suspended',
          checksum: 'c'.repeat(64),
          updatedAt: '2026-09-19T20:00:00.000Z',
        };
      },
    };

    const failingRuntime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry,
      domainRegistry,
      domainSuspensionRuntime: failingDomainSuspensionRuntime,
      localServerId,
    });

    const pFail = await failingRuntime.preview({ websiteId: 'ws-1' });
    const opFail = await failingRuntime.start({
      websiteId: 'ws-1',
      previewDigest: pFail.previewDigest,
      confirmation: pFail.confirmation,
    });
    // Critical: Website must NOT be marked suspended when a domain fails!
    assert.equal(opFail.status, 'partial');
    assert.equal(opFail.domainOperations.find((d) => d.domainId === 'dom-1').status, 'suspended');
    assert.equal(opFail.domainOperations.find((d) => d.domainId === 'dom-2').status, 'failed');
    assert.ok(opFail.actions.suspendRetryConfirmation);

    // 5. Retry partial suspend after dom-2 is fixed
    const recoveredDomainSuspensionRuntime = {
      ...domainSuspensionRuntime,
      preview: async ({ domainId }) => {
        const isSusp = domainSuspendedState.get(domainId) === 'suspended';
        return {
          readyToSuspend: !isSusp,
          previewDigest: 'd'.repeat(64),
          confirmation: `start-domain-suspend:${domainId}:1:${'d'.repeat(64)}`,
        };
      },
      start: async ({ domainId }) => {
        domainSuspendedState.set(domainId, 'suspended');
        return {
          id: `op-${domainId}`,
          domainId,
          status: 'suspended',
          checksum: 'c'.repeat(64),
          updatedAt: '2026-09-19T20:00:00.000Z',
        };
      },
    };
    const recoveredRuntime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry,
      domainRegistry,
      domainSuspensionRuntime: recoveredDomainSuspensionRuntime,
      localServerId,
    });
    const opRetried = await recoveredRuntime.retrySuspend({
      websiteId: 'ws-1',
      operationId: opFail.id,
      expectedUpdatedAt: opFail.updatedAt,
      confirmation: opFail.actions.suspendRetryConfirmation,
    });
    assert.equal(opRetried.status, 'suspended');
    assert.ok(opRetried.domainOperations.every((d) => d.status === 'suspended'));
    assert.ok(opRetried.actions.resumeConfirmation);

    // 6. Resume with partial failure (dom-2 restore fails)
    const failingResumeDomainRuntime = {
      ...recoveredDomainSuspensionRuntime,
      resume: async ({ domainId }) => {
        if (domainId === 'dom-2') {
          throw new Error('Nginx restore failed for dom-2');
        }
        domainSuspendedState.set(domainId, 'active');
        return {
          id: `op-${domainId}`,
          domainId,
          status: 'resumed',
          checksum: 'c'.repeat(64),
          updatedAt: '2026-09-19T20:01:00.000Z',
        };
      },
    };
    const resumeFailingRuntime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry,
      domainRegistry,
      domainSuspensionRuntime: failingResumeDomainRuntime,
      localServerId,
    });
    const resumeFailOp = await resumeFailingRuntime.resume({
      websiteId: 'ws-1',
      operationId: opRetried.id,
      expectedUpdatedAt: opRetried.updatedAt,
      confirmation: opRetried.actions.resumeConfirmation,
    });
    assert.equal(resumeFailOp.status, 'resume_partial');
    assert.equal(resumeFailOp.domainOperations.find((d) => d.domainId === 'dom-1').status, 'resumed');
    assert.equal(resumeFailOp.domainOperations.find((d) => d.domainId === 'dom-2').status, 'resume_failed');
    assert.ok(resumeFailOp.actions.resumeRetryConfirmation);

    // 7. Retry resume once dom-2 restore issue is resolved
    const fixedResumeDomainRuntime = {
      ...recoveredDomainSuspensionRuntime,
      resume: async ({ domainId }) => {
        domainSuspendedState.set(domainId, 'active');
        return {
          id: `op-${domainId}`,
          domainId,
          status: 'resumed',
          checksum: 'c'.repeat(64),
          updatedAt: '2026-09-19T20:02:00.000Z',
        };
      },
    };
    const fixedResumeRuntime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry,
      domainRegistry,
      domainSuspensionRuntime: fixedResumeDomainRuntime,
      localServerId,
    });
    const resumeFixedOp = await fixedResumeRuntime.retryResume({
      websiteId: 'ws-1',
      operationId: resumeFailOp.id,
      expectedUpdatedAt: resumeFailOp.updatedAt,
      confirmation: resumeFailOp.actions.resumeRetryConfirmation,
    });
    assert.equal(resumeFixedOp.status, 'resumed');
    assert.ok(resumeFixedOp.domainOperations.every((d) => d.status === 'resumed'));
  });
});
