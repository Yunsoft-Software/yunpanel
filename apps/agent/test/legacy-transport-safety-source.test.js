import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientUrl = new URL('../src/control-plane-client.js', import.meta.url);
const indexUrl = new URL('../src/index.js', import.meta.url);

test('retained legacy transport cannot reintroduce first enrollment or raw exception logging', async () => {
  const [client, index] = await Promise.all([
    readFile(clientUrl, 'utf8'),
    readFile(indexUrl, 'utf8'),
  ]);

  assert.doesNotMatch(client, /YUNPANEL_ENROLLMENT_TOKEN|\/api\/servers\/enroll|enrollWithControlPlane|error\.message\.slice/);
  assert.doesNotMatch(client, /heartbeat failed: \$\{error\.(?:message|stack)/);
  assert.doesNotMatch(client, /command polling failed: \$\{error\.(?:message|stack)/);
  assert.match(client, /safeLegacyAgentError/);
  assert.match(client, /safeLegacyAgentDiagnosticCode/);

  assert.doesNotMatch(index, /shutdown failed['"],\s*error/);
  assert.doesNotMatch(index, /error\.(?:message|stack)/);
  assert.match(index, /safeLegacyAgentDiagnosticCode/);
});
