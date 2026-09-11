import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../..');
const source = readFileSync(path.join(repositoryRoot, 'apps/api/src/index.js'), 'utf8');
const envExample = readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');

test('production API persists separate DNS, mail Domain and encrypted mailbox stores', () => {
  assert.match(source, /const dnsHostingStorePath = process\.env\.YUNPANEL_DNS_HOSTING_STORE \?\? path\.resolve\('\.data\/dns-hosting-registry\.json'\);/);
  assert.match(source, /const dnsProviderCredentialStorePath = process\.env\.YUNPANEL_DNS_CREDENTIAL_STORE \?\? path\.resolve\('\.data\/dns-provider-credential-registry\.json'\);/);
  assert.match(source, /const mailDomainStorePath = process\.env\.YUNPANEL_MAIL_DOMAIN_STORE \?\? path\.resolve\('\.data\/mail-domain-registry\.json'\);/);
  assert.match(source, /const mailboxStorePath = process\.env\.YUNPANEL_MAILBOX_STORE \?\? path\.resolve\('\.data\/mailbox-registry\.json'\);/);
  assert.match(source, /const dnsHostingRegistry = createDnsHostingRegistry\(\{[\s\S]*filePath: dnsHostingStorePath,[\s\S]*getWebDomain:/);
  assert.match(source, /const mailDomainRegistry = createMailDomainRegistry\(\{[\s\S]*filePath: mailDomainStorePath,[\s\S]*getWebDomain:/);
  assert.match(source, /await dnsHostingRegistry\.init\(\);/);
  assert.match(source, /await mailDomainRegistry\.init\(\);/);
  assert.match(source, /const mailboxRegistry = createMailboxRegistry\(\{[\s\S]*filePath: mailboxStorePath,[\s\S]*masterKey: process\.env\.YUNPANEL_SECRET_MASTER_KEY,[\s\S]*getMailDomain:/);
  assert.match(source, /await mailboxRegistry\.init\(\);/);
  assert.match(source, /dnsHostingRegistry,[\s\S]*mailDomainRegistry,/);
  assert.match(envExample, /^YUNPANEL_DNS_HOSTING_STORE=\.data\/dns-hosting-registry\.json$/m);
  assert.match(envExample, /^YUNPANEL_DNS_CREDENTIAL_STORE=\.data\/dns-provider-credential-registry\.json$/m);
  assert.match(envExample, /^YUNPANEL_MAIL_DOMAIN_STORE=\.data\/mail-domain-registry\.json$/m);
  assert.match(envExample, /^YUNPANEL_MAILBOX_STORE=\.data\/mailbox-registry\.json$/m);
});
