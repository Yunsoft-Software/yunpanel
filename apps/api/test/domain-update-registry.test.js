import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const input = (primaryDomain = 'old.example.com', overrides = {}) => ({
  serverId: 'local', primaryDomain, aliases: ['www.old.example.com'], targetType: 'proxy',
  target: { upstreamPort: 4301 }, httpsMode: 'managed', ...overrides,
});

async function activeDomain(registry) {
  const domain = await registry.createDomain(input());
  await registry.markStaged(domain.id, { checksum: 'a'.repeat(64), configName: 'yunpanel-old.example.com.conf' });
  await registry.markApplied(domain.id, { checksum: 'a'.repeat(64) });
  await registry.attachCertificate(domain.id, 'certificate-1');
  await registry.markStaged(domain.id, { checksum: 'b'.repeat(64), configName: 'yunpanel-old.example.com.conf' });
  return registry.markApplied(domain.id, { checksum: 'b'.repeat(64) });
}

test('Domain routing preview and apply update canonical names and detach a stale certificate', async () => {
  const registry = createDomainRegistry();
  const active = await activeDomain(registry);
  assert.equal(active.appliedPrimaryDomain, 'old.example.com');
  assert.equal(active.diagnosis, null);
  const changes = {
    primaryDomain: 'new.example.com',
    aliases: ['www.new.example.com', 'NEW.example.com.'],
    canonicalRedirect: true,
    httpsRedirect: false,
  };
  const preview = await registry.previewDomainUpdate({ domainId: active.id, changes });
  assert.equal(preview.currentRevision, 2);
  assert.equal(preview.nextRevision, 3);
  assert.deepEqual(preview.next, {
    primaryDomain: 'new.example.com', aliases: ['www.new.example.com'],
    httpsMode: 'managed', httpsRedirect: false, canonicalRedirect: true,
  });
  assert.equal(preview.impact.hostnameChanged, true);
  assert.equal(preview.impact.policyChanged, true);
  assert.equal(preview.impact.activeConfigRename, true);
  assert.deepEqual(preview.impact.certificate, {
    id: 'certificate-1', detached: true, reason: 'hostname_set_changed',
  });

  const result = await registry.updateDomain({ domainId: active.id, changes, previewDigest: preview.previewDigest });
  assert.equal(result.domain.primaryDomain, 'new.example.com');
  assert.deepEqual(result.domain.aliases, ['www.new.example.com']);
  assert.equal(result.domain.certificateId, null);
  assert.equal(result.domain.appliedPrimaryDomain, 'old.example.com');
  assert.equal(result.domain.state, 'draft');
  assert.equal(result.domain.diagnosis.code, 'domain_stage_required');
  await registry.markStaged(active.id, { checksum: 'c'.repeat(64), configName: 'yunpanel-new.example.com.conf' });
  const applied = await registry.markApplied(active.id, { checksum: 'c'.repeat(64) });
  assert.equal(applied.appliedPrimaryDomain, 'new.example.com');
  assert.equal(applied.diagnosis.code, 'domain_certificate_required');
});

test('Domain update rejects conflicts, hierarchy drift, no-op and stale previews without mutation', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(input('example.com', { aliases: [], httpsMode: 'off' }));
  const child = await registry.createDomain(input('api.example.com', { aliases: [], parentDomainId: root.id, httpsMode: 'off' }));
  await registry.createDomain(input('taken.example.net', { aliases: ['alias.example.net'], httpsMode: 'off' }));

  await assert.rejects(
    registry.previewDomainUpdate({ domainId: child.id, changes: { primaryDomain: 'alias.example.net' } }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_conflict',
  );
  await assert.rejects(
    registry.previewDomainUpdate({ domainId: root.id, changes: { primaryDomain: 'renamed.example.net' } }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_subdomain_parent',
  );
  await assert.rejects(
    registry.previewDomainUpdate({ domainId: child.id, changes: { primaryDomain: child.primaryDomain } }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_update_no_changes',
  );

  const changes = { canonicalRedirect: true };
  const preview = await registry.previewDomainUpdate({ domainId: child.id, changes });
  await registry.createDomain(input('fresh.example.net', { aliases: [], httpsMode: 'off' }));
  await assert.rejects(
    registry.updateDomain({ domainId: child.id, changes, previewDigest: preview.previewDigest }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_update_preview_stale',
  );
  assert.equal((await registry.getDomain(child.id)).canonicalRedirect, false);
});

test('HTTPS lifecycle defaults redirect on managed mode and disables it with HTTPS', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain(input());
  assert.equal(domain.httpsRedirect, true);
  assert.equal(domain.canonicalRedirect, false);
  const preview = await registry.previewDomainUpdate({ domainId: domain.id, changes: { httpsMode: 'off' } });
  assert.equal(preview.next.httpsMode, 'off');
  assert.equal(preview.next.httpsRedirect, false);
  await registry.updateDomain({ domainId: domain.id, changes: { httpsMode: 'off' }, previewDigest: preview.previewDigest });
  await assert.rejects(
    registry.previewDomainUpdate({ domainId: domain.id, changes: { httpsRedirect: true } }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_redirect_policy',
  );
});

test('Domain diagnosis maps safe errors to concrete actions without copying hostile values', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain(input('diagnosis.example.com', { aliases: [], httpsMode: 'off' }));
  assert.equal(domain.diagnosis.code, 'domain_stage_required');
  await registry.markStaged(domain.id, { checksum: 'a'.repeat(64), configName: 'diagnosis.conf' });
  assert.equal((await registry.getDomain(domain.id)).diagnosis.code, 'domain_activation_required');
  const known = await registry.markFailed(domain.id, 'nginx_reload_failed');
  assert.equal(known.diagnosis.action, 'Inspect protected Nginx service logs, then retry activation.');
  const hostile = await registry.markFailed(domain.id, 'TOKEN=/private/path');
  assert.equal(hostile.lastError, 'apply_failed');
  assert.doesNotMatch(JSON.stringify(hostile.diagnosis), /TOKEN|private|path/);
});

test('version one Domain state hydrates without rewrite and persists version two on mutation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-update-'));
  const filePath = path.join(directory, 'domains.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = createDomainRegistry();
  const domain = await seed.createDomain(input('legacy.example.com', { aliases: [], httpsMode: 'off' }));
  const legacy = { ...domain };
  for (const key of ['kind', 'diagnosis', 'canonicalRedirect', 'httpsRedirect', 'appliedPrimaryDomain']) delete legacy[key];
  legacy.state = 'active';
  legacy.stagedRevision = 1;
  legacy.appliedRevision = 1;
  legacy.lastError = 'TOKEN=/private/path';
  const before = JSON.stringify({ version: 1, domains: [legacy] });
  await writeFile(filePath, before);
  const registry = createDomainRegistry({ filePath });
  const loaded = await registry.getDomain(domain.id);
  assert.equal(loaded.canonicalRedirect, false);
  assert.equal(loaded.httpsRedirect, false);
  assert.equal(loaded.appliedPrimaryDomain, 'legacy.example.com');
  assert.equal(loaded.lastError, 'apply_failed');
  assert.doesNotMatch(JSON.stringify(loaded.diagnosis), /TOKEN|private|path/);
  assert.equal(await readFile(filePath, 'utf8'), before);

  const changes = { canonicalRedirect: true };
  const preview = await registry.previewDomainUpdate({ domainId: domain.id, changes });
  await registry.updateDomain({ domainId: domain.id, changes, previewDigest: preview.previewDigest });
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 2);
});
