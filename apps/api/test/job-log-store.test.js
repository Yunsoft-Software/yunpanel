import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createJobLogStore } from '../src/job-log-store.js';

const JOB_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

test('persists private deploy logs with redaction, pagination and strict modes', async () => {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-logs-'));
  let clock = Date.parse('2026-09-11T10:00:00.000Z');
  try {
    const store = createJobLogStore({ directoryPath, now: () => clock++ });
    await store.record({ jobId: JOB_ID, stage: 'git', message: 'fetch TOKEN=private-value\nresolved commit' });
    await store.record({ jobId: JOB_ID, stage: 'build', level: 'warning', message: 'warning text' });
    const first = await store.query(JOB_ID, { limit: 2, search: 'i', levels: ['info', 'warning'] });
    assert.equal(first.entries.length, 2);
    assert.equal(first.page.hasMore, true);
    assert.equal(first.entries[0].stage, 'build');
    assert.equal(JSON.stringify(first).includes('private-value'), false);
    const second = await store.query(JOB_ID, { limit: 2, cursor: first.page.nextCursor, levels: ['info', 'warning'] });
    assert.equal(second.entries.length, 1);
    assert.equal(second.entries[0].message, 'fetch TOKEN=[REDACTED]');

    const file = path.join(directoryPath, `${JOB_ID}.json`);
    assert.equal((await stat(directoryPath)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).includes('private-value'), false);
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

test('rejects path-like identities and invalid log metadata before filesystem access', async () => {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-logs-invalid-'));
  try {
    const store = createJobLogStore({ directoryPath });
    await assert.rejects(store.record({ jobId: '../../etc/passwd', stage: 'build', message: 'no' }), /identity is invalid/);
    await assert.rejects(store.record({ jobId: JOB_ID, stage: '../build', message: 'no' }), /metadata is invalid/);
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

test('drops the oldest deploy entries when the per-job entry bound is reached', async () => {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-logs-bound-'));
  try {
    const store = createJobLogStore({ directoryPath });
    for (const marker of ['first', 'second', 'third']) {
      await store.record({ jobId: JOB_ID, stage: 'build', message: Array.from({ length: 400 }, () => marker).join('\n') });
    }
    const result = await store.query(JOB_ID, { limit: 1_000 });
    assert.equal(result.entries.length, 1_000);
    assert.equal(result.page.droppedEntries, 200);
    assert.equal(result.entries.at(-1).message, 'first');
    assert.equal(result.entries[0].message, 'third');
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});
