import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enableManagedMailAntivirus,
  mailAntivirusTemplatePolicy,
  MailAntivirusTemplateError,
  previewManagedMailSecurityConfiguration,
  renderRspamdAntivirusConfig,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`;

function basePreview() {
  return previewManagedMailSecurityConfiguration({
    domains: ['example.com'],
    mailboxes: ['user@example.com'],
    accounts: [{ address: 'user@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'user@example.com',
  });
}

test('renderRspamdAntivirusConfig renders ClamAV config with correct socket', () => {
  const content = renderRspamdAntivirusConfig({ profile: 'clamav' });
  assert.match(content, /clamav \{/);
  assert.match(content, /type = "clamav";/);
  assert.match(content, /servers = "\/run\/clamav\/clamd\.ctl";/);
  assert.match(content, /action = "reject";/);
  assert.match(content, /scan_mime_parts = true;/);
});

test('renderRspamdAntivirusConfig renders disabled message when profile is disabled', () => {
  const content = renderRspamdAntivirusConfig({ profile: 'disabled' });
  assert.equal(content, '# Antivirus scanning disabled\n');
});

test('renderRspamdAntivirusConfig throws on unknown profile', () => {
  assert.throws(
    () => renderRspamdAntivirusConfig({ profile: 'unknown' }),
    (error) => error instanceof MailAntivirusTemplateError && error.code === 'invalid_antivirus_profile',
  );
});

test('enableManagedMailAntivirus attaches ClamAV artifact and requirement when enabled', () => {
  const preview = basePreview();
  assert.equal(preview.requirements.includes('clamav'), false);
  assert.equal(preview.artifacts.some((a) => a.path === mailAntivirusTemplatePolicy.rspamdAntivirusConfigPath), false);

  const enabled = enableManagedMailAntivirus(preview, { profile: 'clamav' });
  assert.equal(enabled.antivirus.enabled, true);
  assert.equal(enabled.antivirus.profile, 'clamav');
  assert.equal(enabled.antivirus.socketPath, '/run/clamav/clamd.ctl');
  assert.equal(enabled.requirements.includes('clamav'), true);

  const artifact = enabled.artifacts.find((a) => a.path === mailAntivirusTemplatePolicy.rspamdAntivirusConfigPath);
  assert.ok(artifact);
  assert.match(artifact.content, /servers = "\/run\/clamav\/clamd\.ctl";/);
  assert.deepEqual(artifact.validate, { file: '/usr/bin/rspamadm', args: ['configtest'] });
  assert.notEqual(enabled.sha256, preview.sha256);
});

test('enableManagedMailAntivirus removes ClamAV artifact and requirement when disabled', () => {
  const preview = basePreview();
  const enabled = enableManagedMailAntivirus(preview, { profile: 'clamav' });
  assert.equal(enabled.requirements.includes('clamav'), true);

  const disabled = enableManagedMailAntivirus(enabled, { profile: 'disabled' });
  assert.equal(disabled.antivirus.enabled, false);
  assert.equal(disabled.antivirus.profile, 'disabled');
  assert.equal(disabled.requirements.includes('clamav'), false);
  assert.equal(disabled.artifacts.some((a) => a.path === mailAntivirusTemplatePolicy.rspamdAntivirusConfigPath), false);
});

test('enableManagedMailAntivirus fails closed on invalid profile or preview', () => {
  const preview = basePreview();
  assert.throws(
    () => enableManagedMailAntivirus(preview, { profile: 'kaspersky' }),
    (error) => error instanceof MailAntivirusTemplateError && error.code === 'invalid_antivirus_profile',
  );
  assert.throws(
    () => enableManagedMailAntivirus(null, { profile: 'clamav' }),
    (error) => error instanceof MailAntivirusTemplateError && error.code === 'invalid_mail_preview',
  );
});
