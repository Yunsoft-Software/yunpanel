import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDnsHostingRegistry } from '../src/dns/dns-hosting-registry.js';
import { createDnsProviderCredentialRegistry } from '../src/dns/dns-provider-credential-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker/docker-workload-registry.js';
import { createMailDomainRegistry } from '../src/mail/mail-domain-registry.js';
import { createMailboxRegistry } from '../src/mail/mailbox-registry.js';
import { createWebsiteMigrationLedger } from '../src/migration/website-migration-ledger.js';
import { createWebsiteMigrationPolicyStore } from '../src/migration/website-migration-policy.js';
import { createWebsiteRegistry } from '../src/websites/website-registry.js';

test('empty file-backed control-plane stores materialize private versioned state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-empty-stores-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stores = [
    ['website-registry.json', { version: 6, websites: [] }, (filePath) => createWebsiteRegistry({ filePath })],
    ['website-migration-policy.json', {
      version: 1, mode: 'compatibility', enforcedDigest: null, transitionedAt: null,
    }, (filePath) => createWebsiteMigrationPolicyStore({ filePath })],
    ['website-migration-ledger.json', { version: 1, entries: [] }, (filePath) => createWebsiteMigrationLedger({ filePath })],
    ['dns-hosting-registry.json', { version: 1, dnsZones: [] }, (filePath) => createDnsHostingRegistry({ filePath })],
    ['mail-domain-registry.json', { version: 1, mailDomains: [] }, (filePath) => createMailDomainRegistry({ filePath })],
    ['mailbox-registry.json', { version: 1, mailboxes: [] }, (filePath) => createMailboxRegistry({
      filePath,
      masterKey: randomBytes(32),
    })],
    ['docker-workload-registry.json', { version: 1, workloads: [] }, (filePath) => createDockerWorkloadRegistry({ filePath })],
    ['dns-provider-credential-registry.json', { version: 1, credentials: [] }, (filePath) => createDnsProviderCredentialRegistry({
      filePath,
      masterKey: randomBytes(32),
    })],
  ];

  for (const [name, expected, createRegistry] of stores) {
    const filePath = path.join(root, name);
    const configured = createRegistry(filePath);
    await configured.init();
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), expected);
    assert.equal((await stat(filePath)).mode & 0o077, 0);
  }
});
