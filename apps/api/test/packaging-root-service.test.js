import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const apiUnitUrl = new URL('../../../packaging/systemd/yunpanel-api.service', import.meta.url);
const webUnitUrl = new URL('../../../packaging/systemd/yunpanel-web.service', import.meta.url);
const controlUrl = new URL('../../../packaging/debian/control', import.meta.url);
const postinstUrl = new URL('../../../packaging/debian/postinst', import.meta.url);

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

test('packaged gateway authenticates canonical client IP metadata to the root API', async () => {
  const [apiUnit, webUnit, postinst] = await Promise.all([
    readFile(apiUnitUrl, 'utf8'),
    readFile(webUnitUrl, 'utf8'),
    readFile(postinstUrl, 'utf8'),
  ]);
  for (const unit of [apiUnit, webUnit]) {
    assert.match(unit, /^EnvironmentFile=\/etc\/yunpanel\/control-plane\/proxy\.env$/m);
  }
  assert.match(postinst, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(postinst, /proxy_token_count=0/);
  assert.match(postinst, /if \[ -f "\$proxy_env" \]; then\n  proxy_token_count=\$\(grep -Ec/);
  assert.match(postinst, /install -o root -g root -m 0600 "\$proxy_temp" "\$proxy_env"/);
  assert.match(postinst, /printf 'YUNPANEL_INTERNAL_PROXY_TOKEN=%s\\n' "\$proxy_token" >>"\$proxy_temp"/);
  assert.match(postinst, /if \[ -f "\$api_env" \] && ! grep -q '\^YUNPANEL_MAILBOX_STORE=' "\$api_env"; then/);
  assert.match(postinst, /YUNPANEL_MAILBOX_STORE=\/var\/lib\/yunpanel\/control-plane\/mailbox-registry\.json/);
  assert.match(postinst, /install -o yunpanel -g yunpanel -m 0600 "\$api_temp" "\$api_env"/);
});
