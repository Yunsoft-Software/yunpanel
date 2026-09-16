import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Domain DNS workspace exposes secondary sync evidence without a mutation path', async () => {
  const [panel, secondaryPanel, client, model] = await Promise.all([
    readFile(new URL('../src/workspace/DnsPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/SecondaryDnsStatusPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/dns-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/dns-model.js', import.meta.url), 'utf8'),
  ]);

  assert.match(panel, /getDnsSecondaryStatus\(root\.id\)/);
  assert.match(panel, /<SecondaryDnsStatusPanel state=\{secondary\}/);
  assert.match(client, /domainDnsPath\(domainId, '\/secondary'\)/);
  assert.match(secondaryPanel, /Primary SOA serial/);
  assert.match(secondaryPanel, /PowerDNS notified_serial/);
  assert.match(secondaryPanel, /target\.observedSerial/);
  assert.match(secondaryPanel, /target\.errorCode/);
  assert.match(secondaryPanel, /otomatik Zone Template re-apply/);
  assert.match(model, /value\?\.policy\?\.healthGate/);
  assert.match(model, /value\?\.policy\?\.recovery/);
  assert.doesNotMatch(secondaryPanel, /applyDns|previewDns|apiKey|privateKey|window\.(?:alert|confirm|prompt)/i);
});
