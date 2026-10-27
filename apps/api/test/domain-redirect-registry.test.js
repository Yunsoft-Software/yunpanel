import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const input = (overrides = {}) => ({
  serverId: 'local', primaryDomain: 'eski.example.com', aliases: ['www.eski.example.com'], targetType: 'redirect',
  target: { url: 'https://yeni.example.com/' }, ...overrides,
});

test('a forwarding-only Domain needs no Website, even when Website binding is enforced', async () => {
  const registry = createDomainRegistry({ websiteBindingRequired: () => true });
  const domain = await registry.createDomain(input());
  assert.equal(domain.websiteId, null);
  assert.deepEqual(domain.target, { url: 'https://yeni.example.com', status: 301, preservePath: true });
  assert.deepEqual(domain.nginxSettings, { clientMaxBodySizeMb: null, headers: [] });
  await assert.rejects(registry.createDomain({ ...input(), primaryDomain: 'site.example.com', aliases: [], targetType: 'static', target: { root: '/var/www/site' } }),
    { code: 'website_binding_required' });
});

test('a Domain cannot forward to one of its own names, and unsafe URLs are refused', async () => {
  const registry = createDomainRegistry();
  for (const url of ['https://eski.example.com/yeni', 'http://WWW.eski.example.com']) {
    await assert.rejects(registry.createDomain(input({ target: { url } })), { code: 'redirect_loop' }, url);
  }
  await assert.rejects(registry.createDomain(input({ target: { url: 'https://x.com/;deny all' } })),
    (error) => error instanceof DomainRegistryError && error.status === 400 && error.code === 'invalid_redirect_url');
  await assert.rejects(registry.createDomain(input({ nginxSettings: { gzip: true } })), DomainRegistryError);
});

test('the forwarding target can be changed through the reviewed update flow; other Domains keep their target', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain(input());
  const changes = { target: { url: 'https://kampanya.example.net/yaz', status: 302, preservePath: false } };
  const preview = await registry.previewDomainUpdate({ domainId: domain.id, changes });
  assert.deepEqual(preview.next.target, { url: 'https://kampanya.example.net/yaz', status: 302, preservePath: false });
  assert.equal(preview.impact.targetChanged, true);
  const { domain: updated } = await registry.updateDomain({ domainId: domain.id, changes, previewDigest: preview.previewDigest });
  assert.deepEqual(updated.target, changes.target);
  assert.equal(updated.desiredRevision, 2);
  await assert.rejects(registry.previewDomainUpdate({ domainId: domain.id, changes: { aliases: ['kampanya.example.net'] } }), { code: 'redirect_loop' });
  const proxy = await registry.createDomain({ serverId: 'local', primaryDomain: 'app.example.com', targetType: 'proxy', target: { upstreamPort: 4301 } });
  await assert.rejects(registry.previewDomainUpdate({ domainId: proxy.id, changes: { target: { upstreamPort: 4302 } } }), { code: 'invalid_domain_update' });
});
