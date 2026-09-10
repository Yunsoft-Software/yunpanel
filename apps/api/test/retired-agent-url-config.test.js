import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const envExampleUrl = new URL('../../../.env.example', import.meta.url);
const agentClientUrl = new URL('../src/agent-client.js', import.meta.url);

test('API no longer documents or reads the retired loopback YUN_AGENT_URL setting', async () => {
  const [envExample, agentClient] = await Promise.all([
    readFile(envExampleUrl, 'utf8'),
    readFile(agentClientUrl, 'utf8'),
  ]);

  assert.doesNotMatch(envExample, /YUN_AGENT_URL/);
  assert.doesNotMatch(agentClient, /YUN_AGENT_URL|127\.0\.0\.1:4010|\/v1\/operations/);
});

test('legacy daemon settings remain explicit until migration rollback acceptance is complete', async () => {
  const envExample = await readFile(envExampleUrl, 'utf8');
  for (const key of [
    'YUN_AGENT_HOST',
    'YUN_AGENT_PORT',
    'YUN_AGENT_MODE',
    'YUN_AGENT_TOKEN',
    'YUNPANEL_CONTROL_PLANE_URL',
    'YUNPANEL_ENROLLMENT_TOKEN',
    'YUN_AGENT_IDENTITY_FILE',
  ]) {
    assert.match(envExample, new RegExp(`^${key}=`, 'm'));
  }
});
