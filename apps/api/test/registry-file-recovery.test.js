import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';
import { createWebsiteMigrationPolicyStore } from '../src/website-migration-policy.js';

async function withDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-registry-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const stage = (resourceId) => ({
  serverId: 'server-1',
  type: 'domain.stage',
  operation: OPERATIONS.DOMAIN_STAGE,
  payload: { primaryDomain: `${resourceId}.example.com`, aliases: [], targetType: 'proxy', target: { upstreamPort: 3008 } },
  resourceType: 'domain',
  resourceId,
});

for (const [label, damage] of [
  ['empty', ''],
  ['half-written', '{\n  "version": 1,\n  "jobs": [\n    {\n      "id": "'],
]) {
  test(`job registry starts from the last good copy when the main file is ${label}`, async (t) => {
    const directory = await withDirectory(t);
    const filePath = path.join(directory, 'jobs.json');
    const writer = createJobRegistry({ filePath });
    const first = await writer.enqueue(stage('first'));
    await writer.enqueue(stage('second'));
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    await writeFile(filePath, damage);

    const restarted = createJobRegistry({ filePath });
    await restarted.init();
    assert.deepEqual((await restarted.listJobs()).map((job) => job.id), [first.id]);

    // The next write replaces the damaged main file and keeps the good backup.
    const third = await restarted.enqueue(stage('third'));
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).jobs.map((job) => job.id), [first.id, third.id]);
    assert.deepEqual(JSON.parse(await readFile(`${filePath}.bak`, 'utf8')).jobs.map((job) => job.id), [first.id]);
  });
}

test('registry startup fails closed when the main file and its backup are both unreadable', async (t) => {
  const directory = await withDirectory(t);
  const filePath = path.join(directory, 'jobs.json');
  await writeFile(filePath, '{"version":1,"jobs":[');
  await writeFile(`${filePath}.bak`, '');
  await assert.rejects(createJobRegistry({ filePath }).init(), SyntaxError);
});

test('a store fails closed on a corrupt main file without backup and recovers once a good backup exists', async (t) => {
  const directory = await withDirectory(t);
  const filePath = path.join(directory, 'website-migration-policy.json');
  const store = createWebsiteMigrationPolicyStore({ filePath });
  await store.init();
  const initial = await readFile(filePath, 'utf8');
  assert.equal(initial.endsWith('\n'), false, 'the stored format is unchanged');

  await writeFile(filePath, '{"version":');
  await assert.rejects(createWebsiteMigrationPolicyStore({ filePath }).init(), SyntaxError);

  await writeFile(`${filePath}.bak`, initial);
  const recovered = createWebsiteMigrationPolicyStore({ filePath });
  await recovered.init();
  assert.deepEqual(recovered.snapshot(), store.snapshot());
});
