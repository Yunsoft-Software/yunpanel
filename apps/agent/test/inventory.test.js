import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { executeOperation, inventoryInternals } from '../src/operations.js';

test('parses Ubuntu os-release metadata', () => {
  const parsed = inventoryInternals.parseOsRelease(`
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
PRETTY_NAME="Ubuntu 24.04.3 LTS"
VERSION_CODENAME=noble
`);

  assert.deepEqual(parsed, {
    id: 'ubuntu',
    name: 'Ubuntu',
    prettyName: 'Ubuntu 24.04.3 LTS',
    version: '24.04',
    codename: 'noble',
  });
});

test('server inspection returns read-only host inventory', async () => {
  const result = await executeOperation(OPERATIONS.SERVER_INSPECT, {});

  assert.equal(typeof result.hostname, 'string');
  assert.ok(result.hostname.length > 0);
  assert.equal(typeof result.cpu.count, 'number');
  assert.ok(result.cpu.count > 0);
  assert.equal(typeof result.memory.totalBytes, 'number');
  assert.ok(result.memory.totalBytes > 0);
  assert.equal(result.runtimes.node.installed, true);
  assert.equal(typeof result.runtimes.node.version, 'string');
  assert.equal(typeof result.capabilities, 'object');
  assert.ok(Array.isArray(result.loadAverage));
});
