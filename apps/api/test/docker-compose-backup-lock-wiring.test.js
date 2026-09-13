import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimeUrl = new URL('../src/docker-compose-runtime.js', import.meta.url);

test('Docker Compose runtime forwards the durable backup lock provider into lifecycle operations', async () => {
  const source = await readFile(runtimeUrl, 'utf8');
  assert.match(source, /projectBackupLocked = async \(\) => false,/);
  assert.match(source, /typeof projectBackupLocked !== 'function'/);
  assert.match(source, /createDockerComposeOperationsService\(\{[\s\S]*?jobRegistry,[\s\S]*?projectBackupLocked,[\s\S]*?\}\)/);
});
