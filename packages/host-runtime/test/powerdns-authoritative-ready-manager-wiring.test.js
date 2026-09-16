import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('PowerDNS ready manager defaults to the durable authoritative manager', async () => {
  const source = await readFile(new URL('../src/powerdns-authoritative-ready-manager.js', import.meta.url), 'utf8');
  assert.match(source, /createPowerDnsAuthoritativeDurableManager/);
  assert.match(source, /manager\s*=\s*createPowerDnsAuthoritativeDurableManager\(\)/);
  assert.doesNotMatch(source, /manager\s*=\s*createPowerDnsAuthoritativeSecureManager\(\)/);
});
