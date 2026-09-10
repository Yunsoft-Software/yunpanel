import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverManagerUrl = new URL('../src/ServerManager.jsx', import.meta.url);

test('server manager does not expose the retained legacy enrollment-token flow', async () => {
  const source = await readFile(serverManagerUrl, 'utf8');
  assert.doesNotMatch(source, /enrollment-tokens|Enroll a server|15-minute token|Copy this token now/);
  assert.doesNotMatch(source, /panelRequest|useState/);
});

test('empty server state points operators to the agentless local bootstrap', async () => {
  const source = await readFile(serverManagerUrl, 'utf8');
  assert.match(source, /No local server configured/);
  assert.match(source, /local-runtime create command/);
});
