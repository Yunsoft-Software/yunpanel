import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createJobIdempotencyLookup,
  JobIdempotencyLookupError,
} from '../src/job-idempotency-lookup.js';
import { createJobRegistry } from '../src/job-registry.js';

const key = `general-backup-step:${'a'.repeat(64)}`;

function request(overrides = {}) {
  return {
    serverId: 'server-1',
    type: OPERATIONS.DOMAIN_STAGE,
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'example.com',
      aliases: [],
      targetType: 'static',
      target: { root: '/var/www/example' },
    },
    resourceType: 'domain',
    resourceId: 'domain-1',
    idempotencyKey: key,
    ...overrides,
  };
}

test('private idempotency lookup returns the existing public-safe job without exposing the key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-lookup-'));
  const filePath = path.join(directory, 'jobs.json');
  try {
    const registry = createJobRegistry({ filePath });
    const input = request();
    const created = await registry.enqueue(input);
    const lookup = createJobIdempotencyLookup({ filePath, jobRegistry: registry });

    const found = await lookup.find(input);
    assert.equal(found.id, created.id);
    assert.equal(found.status, 'queued');
    assert.equal(Object.hasOwn(found, 'idempotencyKey'), false);
    assert.equal(Object.hasOwn(found, 'payload'), false);
    assert.doesNotMatch(JSON.stringify(found), /general-backup-step/);

    const missing = await lookup.find({ ...input, idempotencyKey: `general-backup-step:${'b'.repeat(64)}` });
    assert.equal(missing, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('private idempotency lookup rejects reuse of the same identity for different work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-lookup-conflict-'));
  const filePath = path.join(directory, 'jobs.json');
  try {
    const registry = createJobRegistry({ filePath });
    const input = request();
    await registry.enqueue(input);
    const lookup = createJobIdempotencyLookup({ filePath, jobRegistry: registry });

    await assert.rejects(
      () => lookup.find({
        ...input,
        payload: { ...input.payload, primaryDomain: 'changed.example.com' },
      }),
      (error) => error instanceof JobIdempotencyLookupError
        && error.code === 'job_idempotency_lookup_conflict'
        && error.status === 409,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
