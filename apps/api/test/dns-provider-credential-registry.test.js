import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDnsProviderCredentialRegistry,
  DnsProviderCredentialRegistryError,
  rewrapDnsProviderCredentialSnapshot,
} from '../src/dns-provider-credential-registry.js';

const DNS_ZONE_ID = '12345678-1234-4234-8234-123456789012';

test('DNS provider tokens persist encrypted and materialize only for execution', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dns-provider-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'credentials.json');
  const masterKey = randomBytes(32);
  const token = 'cloudflare_token_private_1234567890';
  const getDnsZone = async (id) => id === DNS_ZONE_ID ? { id, zoneName: 'example.com' } : null;
  const registry = createDnsProviderCredentialRegistry({ filePath, masterKey, getDnsZone });

  const configured = await registry.setCredential({ dnsZoneId: DNS_ZONE_ID, provider: 'cloudflare', token });
  assert.equal(configured.configured, true);
  assert.equal(configured.provider, 'cloudflare');
  assert.equal('token' in configured, false);
  const stored = await readFile(filePath, 'utf8');
  assert.doesNotMatch(stored, new RegExp(token));
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await registry.materialize(configured.id), {
    id: configured.id,
    dnsZoneId: DNS_ZONE_ID,
    provider: 'cloudflare',
    token,
  });

  const updated = await registry.setCredential({
    dnsZoneId: DNS_ZONE_ID,
    provider: 'cloudflare',
    token: 'cloudflare_token_private_updated_1234',
  });
  assert.equal(updated.id, configured.id);
  const reopened = createDnsProviderCredentialRegistry({ filePath, masterKey, getDnsZone });
  await reopened.init();
  assert.equal((await reopened.materialize(configured.id)).token, 'cloudflare_token_private_updated_1234');

  const wrongKey = createDnsProviderCredentialRegistry({ filePath, masterKey: randomBytes(32), getDnsZone });
  await assert.rejects(wrongKey.init(), { code: 'secret_decryption_failed' });

  const nextKey = randomBytes(32);
  const rewrapped = rewrapDnsProviderCredentialSnapshot(JSON.parse(await readFile(filePath, 'utf8')), {
    currentMasterKey: masterKey,
    nextMasterKey: nextKey,
  });
  const rotatedPath = path.join(directory, 'rotated.json');
  await writeFile(rotatedPath, JSON.stringify(rewrapped));
  const rotated = createDnsProviderCredentialRegistry({ filePath: rotatedPath, masterKey: nextKey, getDnsZone });
  await rotated.init();
  assert.equal((await rotated.materialize(configured.id)).token, 'cloudflare_token_private_updated_1234');
  await reopened.deleteForZone(DNS_ZONE_ID);
  assert.equal((await reopened.getForZone(DNS_ZONE_ID)).configured, false);
});

test('DNS provider credential writes require a valid zone and configured master key', async () => {
  const noKey = createDnsProviderCredentialRegistry({ getDnsZone: async () => ({ id: DNS_ZONE_ID }) });
  await assert.rejects(
    noKey.setCredential({ dnsZoneId: DNS_ZONE_ID, provider: 'cloudflare', token: 'cloudflare_token_private_1234567890' }),
    (error) => error instanceof DnsProviderCredentialRegistryError && error.code === 'secret_store_unavailable',
  );
  const registry = createDnsProviderCredentialRegistry({ masterKey: randomBytes(32), getDnsZone: async () => null });
  await assert.rejects(
    registry.setCredential({ dnsZoneId: DNS_ZONE_ID, provider: 'cloudflare', token: 'cloudflare_token_private_1234567890' }),
    (error) => error instanceof DnsProviderCredentialRegistryError && error.code === 'dns_zone_not_found',
  );
});
