import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production local runtime uses the shared Docker inspector', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /import \{[^}]*inspectDocker[^}]*\} from '@yunpanel\/host-runtime';/);
  assert.match(source, /startConfiguredLocalRuntime\(\{[\s\S]*?inspectServices: inspectAllowlistedServices,[\s\S]*?inspectDocker,[\s\S]*?onError: reportLocalExecutorFault,/);
  assert.equal((source.match(/\n  inspectDocker,/g) ?? []).length, 1);
});
