import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';

const jobId = '12345678-1234-4234-8234-123456789012';

async function withTemp(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-recovery-context-'));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('recovery context reader returns payload without exposing result or error', async () => {
  await withTemp(async (root) => {
    const filePath = path.join(root, 'jobs.json');
    await writeFile(filePath, JSON.stringify({
      version: 1,
      jobs: [{
        id: jobId,
        serverId: 'server-1',
        operation: 'domain.stage',
        resourceType: 'domain',
        resourceId: 'domain-1',
        status: 'running',
        attempts: 1,
        payload: { primaryDomain: 'example.test', nested: { value: true } },
        result: { mustNotEscape: true },
        error: { message: 'must-not-escape' },
      }],
    }));

    const reader = createJobRecoveryContextReader({ filePath });
    const context = await reader.read(jobId);
    assert.deepEqual(context.payload, { primaryDomain: 'example.test', nested: { value: true } });
    assert.equal(Object.hasOwn(context, 'result'), false);
    assert.equal(Object.hasOwn(context, 'error'), false);

    context.payload.nested.value = false;
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(raw.jobs[0].payload.nested.value, true);
  });
});

test('recovery context reader fails safely on malformed private state', async () => {
  await withTemp(async (root) => {
    const filePath = path.join(root, 'jobs.json');
    await writeFile(filePath, '{not-json secret-value');
    const reader = createJobRecoveryContextReader({ filePath });
    await assert.rejects(() => reader.read(jobId), (error) => {
      assert.equal(error.code, 'job_recovery_context_read_failed');
      assert.doesNotMatch(error.message, /secret-value|not-json/);
      return true;
    });
  });
});

test('recovery context reader rejects relative store paths', () => {
  assert.throws(
    () => createJobRecoveryContextReader({ filePath: '.data/jobs.json' }),
    { code: 'job_recovery_context_dependencies_invalid' },
  );
});
