import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site workspace exposes real authoritative DNS management instead of a placeholder', async () => {
  const [detail, model, panel, client] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/site-model.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/DnsPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/dns-client.js', import.meta.url), 'utf8'),
  ]);

  assert.match(model, /\['dns', 'DNS'\]/);
  assert.match(detail, /import DnsPanel from '\.\/DnsPanel\.jsx'/);
  assert.match(detail, /tab === 'dns'/);
  assert.match(detail, /<DnsPanel key=\{domain\.id\}/);
  assert.match(panel, /rootDnsDomain\(domain, domains\)/);
  assert.match(panel, /Managed kayıtlar bu yoldan silinemez/);
  assert.match(panel, /previewDnsReapply/);
  assert.match(panel, /previewDnssec/);
  assert.match(panel, /waitForDnsOperation/);
  assert.match(client, /\/reapply-preview/);
  assert.match(client, /\/dnssec\/operations/);
  assert.doesNotMatch(panel, /window\.(?:alert|confirm|prompt)|privateKey|apiKey/i);
});

test('DNS workspace keeps managed records read-only and routes subdomains to the root authoritative zone', async () => {
  const panel = await readFile(new URL('../src/workspace/DnsPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /const editable = dnsRecordEditable\(rrset\)/);
  assert.match(panel, /editable && canManage/);
  assert.match(panel, /root\.id !== domain\.id/);
  assert.match(panel, /ayrı bir zone sahibi değil/);
  assert.match(panel, /siteHref\(root\.id, 'dns'\)/);
});
