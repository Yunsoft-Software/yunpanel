import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const jobRegistryUrl = new URL('../src/job-registry.js', import.meta.url);
const localOperationsUrl = new URL('../src/local-host-operations.js', import.meta.url);

function operationNames(source, pattern) {
  const match = source.match(pattern);
  assert.ok(match, 'Expected operation collection was not found');
  return new Set([...match[1].matchAll(/OPERATIONS\.([A-Z0-9_]+)/g)].map((entry) => entry[1]));
}

test('every durable async queue operation has a local host execution path', async () => {
  const [jobSource, localSource] = await Promise.all([
    readFile(jobRegistryUrl, 'utf8'),
    readFile(localOperationsUrl, 'utf8'),
  ]);

  const queued = operationNames(jobSource, /const ASYNC_OPERATIONS = new Set\(\[([\s\S]*?)\]\);/);
  const local = operationNames(localSource, /export const LOCAL_HOST_OPERATIONS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  const localWithEnvironment = operationNames(localSource, /export const LOCAL_NODE_ENVIRONMENT_OPERATIONS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  const executable = new Set([...local, ...localWithEnvironment]);

  assert.deepEqual([...executable].sort(), [...queued].sort());
});
