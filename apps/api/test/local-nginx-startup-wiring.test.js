import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production local runtime uses the shared Nginx inspector', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /import \{ inspectAllowlistedServices, inspectDocker, inspectNginx \} from '@yunpanel\/host-runtime';/);
  assert.match(source, /startConfiguredLocalRuntime\(\{[\s\S]*?inspectDocker,[\s\S]*?inspectNginx,[\s\S]*?onError: reportLocalExecutorFault,/);
  assert.equal((source.match(/\n  inspectNginx,/g) ?? []).length, 1);
});
