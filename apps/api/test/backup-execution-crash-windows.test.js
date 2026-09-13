import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupExecutionOrchestrator } from '../src/backup-execution-orchestrator.js';
import { createBackupOperationRegistry } from '../src/backup-operation-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const operationId = '2c387b02-8747-458a-b509-8f531d4d149e';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const releaseId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const previewDigest = 'a'.repeat(64);

function resource() {
  return {
    identity: `application:${applicationId}`,
    type: 'application',
    serverId,
    applicationId,
    name: 'Storefront',
    applicationType: 'node',
    snapshot: {
      desiredRevision: 3,
      appliedRevision: 3,
      currentReleaseId: releaseId,
      currentCommitSha: 'c'.repeat(40),
      environment: {
        savedRevision: 2,
        appliedRevision: 2,
        appliedReleaseId: releaseId,
      },
    },
    policy: { disposition: 'include', reason: 'managed_application' },
  };
}

function preview() {
  const selected = resource();
  return {
    version: 1,
    manifestVersion: 1,
    serverId,
    selectionMode: 'explicit',
    selectedResourceIdentities: [selected.identity],
    resources: [selected],
    previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
    counts: { total: 1, selected: 1, included: 1, excluded: 0, rejected: 0 },
    decisions: [{ identity: selected.identity, type: selected.type, selected: true, policy: selected.policy }],
    sideEffects: false,
  };
}

test('terminal parent write survives a lost acknowledgement without replaying local mutation', async () => {
  let now = Date.parse('2026-09-14T00:00:00.000Z');
  const base = createBackupOperationRegistry({
    now: () => now += 1000,
    randomId: () => operationId,
  });
  let loseTerminalAck = true;
  const registry = {
    create: (...args) => base.create(...args),
    start: (...args) => base.start(...args),
    linkStep: (...args) => base.linkStep(...args),
    failStep: (...args) => base.failStep(...args),
    getOperation: (...args) => base.getOperation(...args),
    async succeedStep(input) {
      const persisted = await base.succeedStep(input);
      if (loseTerminalAck) {
        loseTerminalAck = false;
        throw new Error('simulated lost acknowledgement after durable terminal write');
      }
      return persisted;
    },
  };
  let executions = 0;
  const orchestrator = createBackupExecutionOrchestrator({
    backupResourceProvider: { async preview() { return preview(); } },
    backupOperationRegistry: registry,
    childJobDispatcher: {
      intent() { throw new Error('child dispatcher must not be used'); },
      async dispatchPrepared() { throw new Error('child dispatcher must not be used'); },
      evidence() { throw new Error('child dispatcher must not be used'); },
    },
    localExecutors: {
      application_snapshot: {
        async prepare(_serverId, step) {
          return { workRef: { kind: 'local', id: `application-backup:${step.stepDigest}` } };
        },
        async executePrepared() {
          executions += 1;
          return {
            evidence: {
              artifactId: 'application-backup-evidence',
              contentSha256: 'd'.repeat(64),
              bytes: 4096,
              createdAt: '2026-09-14T00:00:10.000Z',
            },
          };
        },
      },
    },
  });

  const created = await orchestrator.create({
    serverId,
    selectedResourceIdentities: [`application:${applicationId}`],
    expectedPreviewDigest: previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
  });

  await assert.rejects(
    () => orchestrator.advance(created.id),
    /simulated lost acknowledgement/,
  );
  assert.equal(executions, 1);
  assert.equal((await base.getOperation(created.id)).status, 'succeeded');

  const replay = await orchestrator.advance(created.id);
  assert.equal(replay.operation.status, 'succeeded');
  assert.equal(replay.waiting, false);
  assert.equal(executions, 1);
});
