import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainRegistry } from '../../api/src/domain-registry.js';
import { createHostingForm, editHostingForm, reloadHostingForm } from '../src/workspace/domain-hosting-form.js';
import { hostingExpectedDomain, hostingSettingsChanges, validateHostingSettingsPreview } from '../src/workspace/domain-hosting-model.js';

// The preview comes from the real API registry, so the form and the server contract are checked together.
async function forwardingDomain() {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain({ serverId: 'local', primaryDomain: 'eski.example.com', targetType: 'redirect',
    target: { url: 'https://yeni.example.com' } });
  return { registry, domain };
}

test('a forwarding Domain edits its target in the hosting form and the server preview validates', async () => {
  const { registry, domain } = await forwardingDomain();
  const clean = createHostingForm(domain);
  assert.deepEqual(clean.values.target, { url: 'https://yeni.example.com', status: 301, preservePath: true });
  const form = editHostingForm(clean, 'target', { url: 'https://kampanya.example.net/', status: 302, preservePath: true });
  const changes = hostingSettingsChanges(form.base, form.values);
  assert.deepEqual(changes, { target: { url: 'https://kampanya.example.net', status: 302, preservePath: true } });
  const preview = await registry.previewDomainUpdate({ domainId: domain.id, changes });
  const plan = validateHostingSettingsPreview(form.base, form.values, preview);
  const { domain: saved } = await registry.updateDomain({ domainId: domain.id, changes: plan.changes, previewDigest: plan.previewDigest });
  assert.deepEqual(hostingExpectedDomain(form.base, plan.changes, plan.nextRevision).target, saved.target);
});

test('an unsafe or looping target is refused before review; a target draft survives a reload', async () => {
  const { domain } = await forwardingDomain();
  const clean = createHostingForm(domain);
  for (const url of ['https://x.com/;deny all', 'ftp://x.com']) {
    assert.throws(() => hostingSettingsChanges(clean.base, editHostingForm(clean, 'target', { ...clean.values.target, url }).values), { code: 'hosting_draft_invalid' });
  }
  const form = editHostingForm(clean, 'target', { ...clean.values.target, status: 302 });
  const next = reloadHostingForm(form, { ...domain, desiredRevision: 2, nginxSettings: { ...domain.nginxSettings, clientMaxBodySizeMb: 5 } }, form.base);
  assert.equal(next.values.target.status, 302);
});

test('other Domains keep their form unchanged and cannot edit a target', () => {
  const form = createHostingForm({ id: 'domain-a', websiteId: 'website-a', serverId: 'local-a', parentDomainId: null, primaryDomain: 'example.com',
    aliases: [], desiredRevision: 3, targetType: 'proxy', target: { upstreamHost: '127.0.0.1', upstreamPort: 3000, websocket: true },
    nginxSettings: { clientMaxBodySizeMb: null, proxyTimeoutSeconds: null, websocket: true, headers: [] },
    httpsMode: 'off', httpsRedirect: false, canonicalRedirect: false, certificateId: null, state: 'active' });
  assert.equal(Object.hasOwn(form.values, 'target'), false);
  assert.throws(() => editHostingForm(form, 'target', { url: 'https://x.com' }), { code: 'hosting_draft_invalid' });
});

test('the advanced domain form builds a forwarding Domain the registry accepts', async () => {
  const { domainCreatePayload } = await import('../src/domain-form.js');
  const payload = domainCreatePayload({ mode: 'domain', primaryDomain: 'Eski.Example.com', aliases: 'www.eski.example.com', targetType: 'redirect',
    targetValue: ' https://yeni.example.com/ ', redirectStatus: 302, preservePath: true, httpsMode: 'off' }, [], [{ id: 'local' }]);
  assert.deepEqual(payload.target, { url: 'https://yeni.example.com/', status: 302, preservePath: true });
  const domain = await createDomainRegistry().createDomain(payload);
  assert.deepEqual(domain.target, { url: 'https://yeni.example.com', status: 302, preservePath: true });
});
