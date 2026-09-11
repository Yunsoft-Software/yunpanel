import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { ExternalLifecycleRegistryError } from '../src/external-lifecycle-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-external-lifecycle-'));
  const domains = new Map([
    ['web-domain-1', { id: 'web-domain-1', primaryDomain: 'xn--bcher-kva.example' }],
    ['web-domain-2', { id: 'web-domain-2', primaryDomain: 'other.example' }],
  ]);
  const options = { getWebDomain: async (id) => domains.get(id) ?? null };
  const dnsPath = path.join(root, 'dns.json');
  const mailPath = path.join(root, 'mail.json');
  const dns = createDnsHostingRegistry({ ...options, filePath: dnsPath });
  const mail = createMailDomainRegistry({ ...options, filePath: mailPath });
  await Promise.all([dns.init(), mail.init()]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, domains, options, dnsPath, mailPath, dns, mail };
}

test('DNS hosting and mail Domain use separate canonical persistent identities', async (t) => {
  const state = await fixture(t);
  const dns = await state.dns.createZone({
    zoneName: 'BÜCHER.example.',
    webDomainId: 'web-domain-1',
    managementMode: 'external',
  });
  const mail = await state.mail.createMailDomain({
    domainName: 'xn--bcher-kva.example',
    webDomainId: 'web-domain-1',
    managementMode: 'external',
  });
  assert.notEqual(dns.id, mail.id);
  assert.equal(dns.resourceType, 'dns_zone');
  assert.equal(dns.zoneName, 'xn--bcher-kva.example');
  assert.equal(mail.resourceType, 'mail_domain');
  assert.equal(mail.domainName, dns.zoneName);
  assert.equal(dns.status, 'unverified');
  assert.equal(mail.status, 'unverified');
  assert.equal(dns.lastObservedAt, null);
  assert.equal((await stat(state.dnsPath)).mode & 0o077, 0);
  assert.equal((await stat(state.mailPath)).mode & 0o077, 0);

  const reopenedDns = createDnsHostingRegistry({ ...state.options, filePath: state.dnsPath });
  const reopenedMail = createMailDomainRegistry({ ...state.options, filePath: state.mailPath });
  await Promise.all([reopenedDns.init(), reopenedMail.init()]);
  assert.deepEqual(await reopenedDns.getZone(dns.id), dns);
  assert.deepEqual(await reopenedMail.getMailDomain(mail.id), mail);
});

test('external observation is revisioned and cannot fabricate readiness or diagnostics', async (t) => {
  const state = await fixture(t);
  const zone = await state.dns.createZone({
    zoneName: 'standalone.example',
    webDomainId: null,
    managementMode: 'external',
  });
  const ready = await state.dns.recordObservation(zone.id, { expectedRevision: 1, status: 'ready' });
  assert.equal(ready.revision, 2);
  assert.equal(ready.status, 'ready');
  assert.ok(ready.lastObservedAt);
  assert.equal(ready.lastErrorCode, null);

  await assert.rejects(
    state.dns.recordObservation(zone.id, { expectedRevision: 1, status: 'degraded', errorCode: 'resolver_timeout' }),
    (error) => error instanceof ExternalLifecycleRegistryError && error.code === 'dns_zone_revision_conflict' && error.status === 409,
  );
  await assert.rejects(
    state.dns.recordObservation(zone.id, { expectedRevision: 2, status: 'degraded', errorCode: 'secret output\n' }),
    (error) => error instanceof ExternalLifecycleRegistryError && error.code === 'invalid_dns_zone_error_code',
  );
  const degraded = await state.dns.recordObservation(zone.id, {
    expectedRevision: 2,
    status: 'degraded',
    errorCode: 'resolver_timeout',
  });
  assert.equal(degraded.revision, 3);
  assert.equal(degraded.lastErrorCode, 'resolver_timeout');
});

test('external tracking requires explicit mode and exact optional web Domain reference', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    state.dns.createZone({ zoneName: 'other.example', webDomainId: 'missing-domain', managementMode: 'external' }),
    (error) => error instanceof ExternalLifecycleRegistryError && error.code === 'dns_zone_web_domain_not_found' && error.status === 404,
  );
  await assert.rejects(
    state.dns.createZone({ zoneName: 'wrong.example', webDomainId: 'web-domain-2', managementMode: 'external' }),
    (error) => error instanceof ExternalLifecycleRegistryError && error.code === 'dns_zone_web_domain_mismatch' && error.status === 409,
  );
  await assert.rejects(
    state.mail.createMailDomain({ domainName: 'mail-only.example', webDomainId: null, managementMode: 'local' }),
    (error) => error instanceof ExternalLifecycleRegistryError && error.code === 'mail_domain_management_mode_unsupported' && error.status === 409,
  );

  await state.dns.createZone({ zoneName: 'other.example', webDomainId: 'web-domain-2', managementMode: 'external' });
  await assert.rejects(
    state.dns.createZone({ zoneName: 'OTHER.EXAMPLE.', webDomainId: null, managementMode: 'external' }),
    (error) => error instanceof ExternalLifecycleRegistryError && error.code === 'dns_zone_name_conflict' && error.status === 409,
  );
});

test('corrupt lifecycle state and stale web Domain references fail closed on reopen', async (t) => {
  const state = await fixture(t);
  await state.mail.createMailDomain({
    domainName: 'xn--bcher-kva.example',
    webDomainId: 'web-domain-1',
    managementMode: 'external',
  });
  const saved = JSON.parse(await readFile(state.mailPath, 'utf8'));

  for (const mutate of [
    (value) => { value.mailDomains[0].status = 'ready'; },
    (value) => { value.mailDomains[0].secret = 'must-fail'; },
    (value) => { value.mailDomains.push({ ...value.mailDomains[0] }); },
  ]) {
    const candidate = structuredClone(saved);
    mutate(candidate);
    await writeFile(state.mailPath, JSON.stringify(candidate), { mode: 0o600 });
    await assert.rejects(createMailDomainRegistry({ ...state.options, filePath: state.mailPath }).init());
  }

  await writeFile(state.mailPath, JSON.stringify(saved), { mode: 0o600 });
  state.domains.delete('web-domain-1');
  await assert.rejects(
    createMailDomainRegistry({ ...state.options, filePath: state.mailPath }).init(),
    (error) => error instanceof ExternalLifecycleRegistryError && error.code === 'mail_domain_web_domain_not_found' && error.status === 409,
  );
});
