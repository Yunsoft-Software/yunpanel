import assert from 'node:assert/strict';
import test from 'node:test';
import {
  previewRoundcubeConfiguration,
  renderRoundcubeConfig,
  RoundcubeTemplateError,
  roundcubeTemplatePolicy,
} from '../src/index.js';

const desKey = 'ABCDEFGHIJKLMNOPQRSTUVWX';

test('Roundcube config uses verified STARTTLS mail endpoints and private SQLite state', () => {
  const content = renderRoundcubeConfig({
    mailHostname: 'Mail.Example.COM',
    desKey,
  });
  assert.match(content, /\$config\['db_dsnw'\] = 'sqlite:\/\/\/\/var\/lib\/yunpanel\/roundcube\/roundcube\.sqlite';/);
  assert.match(content, /\$config\['imap_host'\] = 'tls:\/\/mail\.example\.com:143';/);
  assert.match(content, /\$config\['smtp_host'\] = 'tls:\/\/mail\.example\.com:587';/);
  assert.match(content, /\$config\['smtp_user'\] = '%u';/);
  assert.match(content, /\$config\['smtp_pass'\] = '%p';/);
  assert.match(content, /'verify_peer' => true/);
  assert.match(content, /'verify_peer_name' => true/);
  assert.match(content, /'allow_self_signed' => false/);
  assert.match(content, /'peer_name' => 'mail\.example\.com'/);
  assert.match(content, /\$config\['des_key'\] = 'ABCDEFGHIJKLMNOPQRSTUVWX';/);
  assert.match(content, /\$config\['enable_installer'\] = false;/);
  assert.match(content, /\$config\['log_driver'\] = 'syslog';/);
  assert.doesNotMatch(content, /localhost|127\.0\.0\.1|verify_peer' => false|allow_self_signed' => true/);
});

test('Roundcube preview is deterministic and marks the secret-bearing config sensitive', () => {
  const input = { mailHostname: 'mail.example.com', desKey };
  const first = previewRoundcubeConfiguration(input);
  const second = previewRoundcubeConfiguration(input);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.artifact.sha256, first.sha256);
  assert.equal(first.artifact.path, roundcubeTemplatePolicy.configPath);
  assert.equal(first.artifact.sensitive, true);
  assert.equal(first.mailHostname, 'mail.example.com');
  assert.equal(first.databasePath, '/var/lib/yunpanel/roundcube/roundcube.sqlite');
  assert.equal(JSON.stringify(first).includes(desKey), false);
  assert.equal(JSON.stringify(first).includes('smtp_pass'), false);
});

test('Roundcube config rejects unsafe identity, secret and filesystem inputs', () => {
  for (const input of [
    { mailHostname: 'bad host', desKey },
    { mailHostname: 'mail.example.com', desKey: 'too-short' },
    { mailHostname: 'mail.example.com', desKey, databasePath: '/../etc/passwd' },
    { mailHostname: 'mail.example.com', desKey, temporaryDirectory: '/var/lib/../tmp' },
    { mailHostname: 'mail.example.com', desKey, productName: 'bad\nname' },
  ]) {
    assert.throws(() => renderRoundcubeConfig(input), RoundcubeTemplateError);
  }
});