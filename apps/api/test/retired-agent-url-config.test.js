import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const envExampleUrl = new URL('../../../.env.example', import.meta.url);
const legacyControlPlaneClientUrl = new URL('../../agent/src/control-plane-client.js', import.meta.url);

test('retired API-to-agent URL and first-enrollment settings stay removed', async () => {
  const [envExample, legacyClient] = await Promise.all([
    readFile(envExampleUrl, 'utf8'),
    readFile(legacyControlPlaneClientUrl, 'utf8'),
  ]);

  assert.doesNotMatch(envExample, /YUN_AGENT_URL|YUNPANEL_ENROLLMENT_TOKEN/);
  assert.doesNotMatch(legacyClient, /YUN_AGENT_URL|YUNPANEL_ENROLLMENT_TOKEN|\/api\/servers\/enroll|enrollWithControlPlane/);
  assert.match(legacyClient, /legacy_agent_identity_required/);
  assert.match(legacyClient, /new enrollment is retired/);
});

test('only rollback-required legacy daemon/link settings remain explicit before migration acceptance', async () => {
  const envExample = await readFile(envExampleUrl, 'utf8');
  for (const key of [
    'YUN_AGENT_HOST',
    'YUN_AGENT_PORT',
    'YUN_AGENT_MODE',
    'YUN_AGENT_TOKEN',
    'YUNPANEL_CONTROL_PLANE_URL',
    'YUN_AGENT_IDENTITY_FILE',
    'YUN_AGENT_HEARTBEAT_MS',
    'YUN_AGENT_COMMAND_POLL_MS',
  ]) {
    assert.match(envExample, new RegExp(`^${key}=`, 'm'));
  }
});
