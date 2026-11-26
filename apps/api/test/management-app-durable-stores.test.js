import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/app.js';

const FILE_BACKED_STORES = [
  'registry', 'jobRegistry', 'certificateRegistry', 'applicationRegistry', 'dockerWorkloadRegistry',
  'websiteRegistry', 'websiteMigrationPolicy', 'migrationLedger', 'domainRegistry', 'dnsHostingRegistry',
  'dnsProviderCredentialRegistry', 'mailDomainRegistry', 'mailDkimRegistry', 'mailDkimRetirementRegistry',
  'mailboxRegistry', 'mailboxQuotaRegistry', 'mailboxForwardingRegistry', 'mailAliasRegistry',
];

test('production wiring refuses to fall back to in-memory stores', () => {
  assert.throws(
    () => createApp({ requireDurableStores: true }),
    (error) => FILE_BACKED_STORES.every((name) => error.message.split(/[:,]\s*/).includes(name)),
  );
});

test('production wiring names exactly the store that was not handed in', () => {
  const provided = Object.fromEntries(FILE_BACKED_STORES.filter((name) => name !== 'jobRegistry').map((name) => [name, {}]));
  assert.throws(
    () => createApp({ requireDurableStores: true, ...provided }),
    { message: 'Production wiring is missing file-backed stores: jobRegistry' },
  );
});

test('tests may still build the app on in-memory stores by not asking for durable stores', () => {
  assert.equal(typeof createApp(), 'function');
});
