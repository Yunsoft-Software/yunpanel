import assert from 'node:assert/strict';
import test from 'node:test';
import {
  phpMyAdminSignonTemplatePolicy,
  previewPhpMyAdminSignonBridge,
  previewPhpMyAdminSignonConfig,
  renderPhpMyAdminSignonBridge,
  renderPhpMyAdminSignonConfig,
} from '../src/phpmyadmin-signon.js';

test('phpMyAdmin signon config disables root and passwordless login and uses the protected session', () => {
  const content = renderPhpMyAdminSignonConfig();
  assert.match(content, /\['PmaAbsoluteUri'\] = 'https:\/\/' \. \$yunpanelHost \. '\/tools\/phpmyadmin\/';/);
  assert.match(content, /\['auth_type'\] = 'signon';/);
  assert.match(content, /\['AllowRoot'\] = false;/);
  assert.match(content, /\['AllowNoPassword'\] = false;/);
  assert.match(content, /\['hide_connection_errors'\] = true;/);
  assert.ok(content.includes(`['SignonSession'] = '${phpMyAdminSignonTemplatePolicy.signonSession}'`));
  assert.ok(content.includes(`'path' => '${phpMyAdminSignonTemplatePolicy.gatewayBasePath}'`));
  assert.match(content, /\['LogoutURL'\] = 'https:\/\/' \. \$yunpanelHost \. '\/tools\/phpmyadmin\/__yunpanel\/logout';/);
  assert.equal(content.includes("['password'] ="), false);

  const preview = previewPhpMyAdminSignonConfig();
  assert.equal(preview.artifact.path, '/etc/phpmyadmin/conf.d/zz-yunpanel.php');
  assert.equal(preview.artifact.mode, 0o640);
  assert.equal(preview.artifact.sensitive, false);
  assert.equal(preview.artifact.bytes, Buffer.byteLength(content));
});

test('phpMyAdmin signon bridge consumes only a capability over the private Unix socket', () => {
  const content = renderPhpMyAdminSignonBridge();
  assert.ok(content.includes(`const YUNPANEL_HANDOFF_SOCKET = '${phpMyAdminSignonTemplatePolicy.handoffSocketPath}';`));
  assert.match(content, /\$_POST\['capability'\]/);
  assert.match(content, /count\(\$_POST\) !== 1/);
  assert.doesNotMatch(content, /\$_POST\['databaseName'\]/);
  assert.match(content, /POST \/consume HTTP\/1\.1/);
  assert.match(content, /PMA_single_signon_user/);
  assert.match(content, /PMA_single_signon_password/);
  assert.match(content, /PMA_single_signon_HMAC_secret/);
  assert.match(content, /PMA_single_signon_cfgupdate/);
  assert.match(content, /'only_db' => str_replace\([^\n]+\$data\['databaseName'\]\)/);
  assert.match(content, /YUNPANEL_SIGNON_ACTION/);
  assert.match(content, /session_destroy\(\)/);
  assert.match(content, /setcookie\(YUNPANEL_SIGNON_SESSION/);
  assert.match(content, /Location: '\/'/);
  assert.match(content, /Location: ' \. YUNPANEL_GATEWAY_BASE/);
  assert.equal(content.includes('root\', \'\''), false);

  const preview = previewPhpMyAdminSignonBridge();
  assert.equal(preview.artifact.path, '/usr/lib/yunpanel/phpmyadmin/signon.php');
  assert.equal(preview.handoffSocketPath, '/run/yunpanel-phpmyadmin/handoff.sock');
  assert.equal(preview.internalSignonPath, '/__yunpanel/signon');
  assert.equal(preview.internalLogoutPath, '/__yunpanel/logout');
  assert.equal(preview.gatewayBasePath, '/tools/phpmyadmin/');
  assert.equal(preview.artifact.mode, 0o640);
  assert.equal(preview.artifact.bytes, Buffer.byteLength(content));
});

test('phpMyAdmin signon previews are deterministic and change if rendered policy bytes change', () => {
  const configA = previewPhpMyAdminSignonConfig();
  const configB = previewPhpMyAdminSignonConfig();
  const bridgeA = previewPhpMyAdminSignonBridge();
  const bridgeB = previewPhpMyAdminSignonBridge();
  assert.deepEqual(configA, configB);
  assert.deepEqual(bridgeA, bridgeB);
  assert.match(configA.sha256, /^[a-f0-9]{64}$/);
  assert.match(bridgeA.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(configA.sha256, bridgeA.sha256);
});
