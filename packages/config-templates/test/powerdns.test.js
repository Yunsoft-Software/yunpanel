import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PowerDnsTemplateError,
  powerDnsTemplatePolicy,
  previewManagedPowerDnsConfig,
  renderManagedPowerDnsConfig,
} from '../src/powerdns.js';

const hash = '$scrypt$ln=10,r=8,p=1$example-salt$example-hash';

test('managed PowerDNS config is authoritative-only with loopback API and gsqlite3 backend', () => {
  const content = renderManagedPowerDnsConfig({ apiKeyHash: hash, secondaryDns: [] });
  assert.match(content, /^launch=gsqlite3$/m);
  assert.match(content, new RegExp(`^gsqlite3-database=${powerDnsTemplatePolicy.databasePath.replaceAll('/', '\\/')}$`, 'm'));
  assert.match(content, /^gsqlite3-dnssec=yes$/m);
  assert.match(content, /^primary=yes$/m);
  assert.match(content, /^secondary=no$/m);
  assert.match(content, /^autosecondary=no$/m);
  assert.match(content, /^api=yes$/m);
  assert.match(content, /^webserver-address=127\.0\.0\.1$/m);
  assert.match(content, /^webserver-allow-from=127\.0\.0\.1$/m);
  assert.match(content, /^local-port=53$/m);
  assert.match(content, /^version-string=anonymous$/m);
  assert.doesNotMatch(content, /recursor/i);
  assert.equal(powerDnsTemplatePolicy.packages.includes('bind9-dnsutils'), true);

  const preview = previewManagedPowerDnsConfig({ apiKeyHash: hash, secondaryDns: [] });
  assert.equal(preview.api.public, false);
  assert.equal(preview.authoritative, true);
  assert.equal(preview.recursive, false);
});

test('managed PowerDNS config allows only explicit secondary AXFR/notify addresses', () => {
  const content = renderManagedPowerDnsConfig({
    apiKeyHash: hash,
    secondaryDns: ['203.0.113.20', '2001:db8::20'],
  });
  assert.match(content, /^allow-axfr-ips=127\.0\.0\.0\/8, ::1, 2001:db8::20, 203\.0\.113\.20$/m);
  assert.match(content, /^also-notify=2001:db8::20, 203\.0\.113\.20$/m);
});

test('managed PowerDNS config rejects malformed secrets and secondary addresses', () => {
  assert.throws(
    () => renderManagedPowerDnsConfig({ apiKeyHash: 'short', secondaryDns: [] }),
    (error) => error instanceof PowerDnsTemplateError && error.code === 'invalid_powerdns_api_key_hash',
  );
  assert.throws(
    () => renderManagedPowerDnsConfig({ apiKeyHash: hash, secondaryDns: ['not-an-ip'] }),
    (error) => error instanceof PowerDnsTemplateError && error.code === 'invalid_powerdns_secondary_addresses',
  );
});
