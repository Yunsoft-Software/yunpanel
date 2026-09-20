import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const envExampleUrl = new URL('../../../.env.example', import.meta.url);
const legacyAgentDirUrl = new URL('../../../apps/agent', import.meta.url);
const legacyServiceUrl = new URL('../../../packaging/systemd/yun-agent.service', import.meta.url);

test('retired agent package, service unit and configuration stay removed', async () => {
  const envExample = await readFile(envExampleUrl, 'utf8');

  assert.doesNotMatch(envExample, /YUN_AGENT_URL|YUNPANEL_ENROLLMENT_TOKEN|YUN_AGENT_HOST|YUN_AGENT_PORT|YUN_AGENT_MODE|YUN_AGENT_TOKEN|YUN_AGENT_IDENTITY_FILE|YUN_AGENT_HEARTBEAT_MS|YUN_AGENT_COMMAND_POLL_MS/);
  assert.equal(existsSync(legacyAgentDirUrl), false);
  assert.equal(existsSync(legacyServiceUrl), false);
});

