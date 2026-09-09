import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const apiUnitUrl = new URL('../../../packaging/systemd/yunpanel-api.service', import.meta.url);
const webUnitUrl = new URL('../../../packaging/systemd/yunpanel-web.service', import.meta.url);
const controlUrl = new URL('../../../packaging/debian/control', import.meta.url);

test('packaged management API is the privileged host process while the web gateway remains restricted', async () => {
  const [apiUnit, webUnit] = await Promise.all([
    readFile(apiUnitUrl, 'utf8'),
    readFile(webUnitUrl, 'utf8'),
  ]);

  assert.match(apiUnit, /^User=root$/m);
  assert.match(apiUnit, /^Group=root$/m);
  assert.doesNotMatch(apiUnit, /^User=yunpanel$/m);
  assert.doesNotMatch(apiUnit, /^ProtectSystem=/m);
  assert.doesNotMatch(apiUnit, /^ProtectHome=/m);
  assert.doesNotMatch(apiUnit, /^PrivateTmp=/m);
  assert.doesNotMatch(apiUnit, /^ReadWritePaths=/m);
  assert.doesNotMatch(apiUnit, /^NoNewPrivileges=true$/m);

  assert.match(webUnit, /^User=yunpanel$/m);
  assert.match(webUnit, /^ProtectSystem=strict$/m);
  assert.match(webUnit, /^NoNewPrivileges=true$/m);
});

test('Debian package description documents the local privileged runtime as the target and the agent as transitional', async () => {
  const control = await readFile(controlUrl, 'utf8');
  assert.match(control, /privileged local\n host runtime/);
  assert.match(control, /legacy yun-agent service remains packaged only for controlled migration/);
  assert.doesNotMatch(control, /privileged allowlisted\n server agent/);
});
