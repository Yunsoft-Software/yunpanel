import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => new URL(`../src/${name}`, import.meta.url);
const text = (name) => readFile(source(name), 'utf8');

test('production app reuses one DKIM DNS service for provider routes and key lifecycle reconciliation', async () => {
  const [appSource, dnsSource, dkimHttpSource] = await Promise.all([
    text('app.js'),
    text('mail-dkim-dns.js'),
    text('mail-dkim-http.js'),
  ]);

  assert.match(appSource, /createMailDkimDnsService\(\{[\s\S]*?mailDomainRegistry,[\s\S]*?mailDkimRegistry,[\s\S]*?mailDkimRetirementRegistry,[\s\S]*?dnsHostingRegistry,[\s\S]*?dnsProviderCredentialRegistry,[\s\S]*?dnsRecordManager,[\s\S]*?jobRegistry,[\s\S]*?\}\)/);
  assert.match(appSource, /mountMailDkimRoutes\(app,\s*\{[\s\S]*?mailDkimDnsService:\s*dkimDns,[\s\S]*?\}\)/);
  assert.match(appSource, /mountMailDkimDnsRoutes\(app,\s*\{\s*mailDkimDnsService:\s*dkimDns\s*\}\)/);
  assert.match(appSource, /error instanceof MailDkimDnsError/);
  assert.match(appSource, /error instanceof MailDkimDnsHttpError/);

  assert.match(dnsSource, /operation:\s*OPERATIONS\.DNS_RECORD_APPLY/);
  assert.match(dnsSource, /resourceType:\s*'dns_zone'/);
  assert.match(dnsSource, /expectedSnapshotDigest:\s*preview\.providerSnapshotDigest/);
  assert.match(dnsSource, /idempotencyKey:\s*`dkim-dns:/);
  assert.doesNotMatch(dnsSource, /fetch\(/);

  assert.match(dkimHttpSource, /mailDkimDnsService\.reconcileRetirement\(request\.params\.mailDomainId\)/);
});

test('DKIM DNS provider lifecycle is backed by generic bounded TXT protocol and Cloudflare adapter', async () => {
  const [protocolSource, cloudflareSource, jobSource] = await Promise.all([
    readFile(new URL('../../../packages/protocol/src/index-extended.js', import.meta.url), 'utf8'),
    readFile(new URL('../../../packages/host-runtime/src/cloudflare-dns-manager.js', import.meta.url), 'utf8'),
    text('job-registry.js'),
  ]);

  assert.match(protocolSource, /record\.type === 'TXT'/);
  assert.match(protocolSource, /TXT_MAX_BYTES = 4096/);
  assert.match(cloudflareSource, /RECORD_TYPES = new Set\(\['A', 'AAAA', 'CNAME', 'TXT'\]\)/);
  assert.match(cloudflareSource, /TXT_MAX_BYTES = 4096/);
  assert.match(jobSource, /OPERATIONS\.MAIL_DKIM_APPLY/);
  assert.match(jobSource, /sanitizeMailDkimResult/);
});
