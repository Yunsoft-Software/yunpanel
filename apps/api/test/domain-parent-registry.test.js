import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const input = (primaryDomain = 'example.com.tr', extra = {}) => ({
  serverId: 'local', primaryDomain, targetType: 'proxy', target: { upstreamPort: 4301 }, ...extra,
});
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-hierarchy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'domains.json');
}

test('subdomain parent, independent target and certificate survive reopening', async (t) => {
  const filePath = await fixture(t);
  const registry = createDomainRegistry({ filePath });
  const root = await registry.createDomain(input());
  const child = await registry.createDomain(input('API.EXAMPLE.COM.TR.', {
    parentDomainId: root.id, httpsMode: 'managed', target: { upstreamPort: 4400 },
  }));
  await registry.attachCertificate(child.id, 'child-certificate');
  const reopened = createDomainRegistry({ filePath });
  assert.equal((await reopened.getDomain(child.id)).parentDomainId, root.id);
  assert.equal((await reopened.getDomain(child.id)).primaryDomain, 'api.example.com.tr');
  assert.equal((await reopened.getDomain(child.id)).kind, 'subdomain');
  assert.equal((await reopened.getDomain(child.id)).websiteId, null);
  assert.equal((await reopened.getDomain(child.id)).target.upstreamPort, 4400);
  assert.equal((await reopened.getDomain(child.id)).certificateId, 'child-certificate');
  assert.equal((await reopened.getDomain(root.id)).certificateId, null);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('invalid parent requests leave the persisted registry unchanged', async (t) => {
  const filePath = await fixture(t);
  const registry = createDomainRegistry({ filePath });
  const root = await registry.createDomain(input());
  const before = await readFile(filePath, 'utf8');
  for (const [request, code] of [
    [input('badexample.com.tr', { parentDomainId: root.id }), 'invalid_subdomain_parent'],
    [input('api.example.com.tr', { parentDomainId: 'missing' }), 'parent_domain_not_found'],
    [input('api.example.com.tr', { parentDomainId: root.id, serverId: 'remote' }), 'parent_server_mismatch'],
    [input('api.example.com.tr', { parentDomainId: {} }), 'invalid_parent_domain'],
  ]) {
    await assert.rejects(registry.createDomain(request), (error) => error instanceof DomainRegistryError && error.code === code);
    assert.equal(await readFile(filePath, 'utf8'), before);
    assert.equal((await registry.listDomains()).length, 1);
  }
});

test('aliases remain attached names, not implicit parent resources', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(input('example.com.tr', { aliases: ['example.net', 'www.example.com.tr'] }));
  await assert.rejects(registry.createDomain(input('api.example.net', { parentDomainId: root.id })), { code: 'invalid_subdomain_parent' });
  await assert.rejects(registry.createDomain(input('www.example.com.tr', { parentDomainId: root.id })), { code: 'domain_conflict' });
  assert.equal((await registry.listDomains()).length, 1);
});

test('legacy state is read without rewrite or guessed ancestry or Website linkage', async (t) => {
  const filePath = await fixture(t);
  const seed = createDomainRegistry();
  const records = [await seed.createDomain(input()), await seed.createDomain(input('api.example.com.tr'))];
  for (const record of records) {
    delete record.kind;
    delete record.parentDomainId;
    delete record.websiteId;
    record.state = 'active';
    record.certificateId = `cert-${record.id}`;
    record.desiredRevision = 5;
    record.appliedRevision = 5;
  }
  const before = JSON.stringify({ version: 1, domains: records });
  await writeFile(filePath, before);
  const registry = createDomainRegistry({ filePath });
  const loaded = await registry.listDomains();
  assert.equal(loaded[1].websiteId, null);
  assert.equal(loaded[1].parentDomainId, null);
  assert.equal(loaded[1].kind, 'domain');
  assert.equal(loaded[1].certificateId, records[1].certificateId);
  assert.equal(loaded[1].appliedRevision, 5);
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('corrupt saved parent relationships fail closed without rewriting state', async (t) => {
  const filePath = await fixture(t);
  const before = JSON.stringify({ version: 1, domains: [{ id: 'a', serverId: 'local', primaryDomain: 'example.com', parentDomainId: 'missing' }] });
  await writeFile(filePath, before);
  await assert.rejects(createDomainRegistry({ filePath }).init(), { code: 'parent_domain_not_found' });
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('public results do not allow mutation of stored targets or aliases', async () => {
  const registry = createDomainRegistry();
  const result = await registry.createDomain(input());
  result.target.upstreamPort = 1;
  result.aliases.push('taken.example.com');
  const stored = await registry.getDomain(result.id);
  assert.equal(stored.target.upstreamPort, 4301);
  assert.deepEqual(stored.aliases, []);
});

test('nested creation and existing staging lifecycle remain independent', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(input());
  const child = await registry.createDomain(input('api.example.com.tr', { parentDomainId: root.id }));
  const nested = await registry.createDomain(input('v2.api.example.com.tr', { parentDomainId: child.id }));
  await registry.markStaged(nested.id, { checksum: 'a'.repeat(64), configName: 'nested.conf' });
  await registry.markApplied(nested.id, { checksum: 'a'.repeat(64) });
  assert.equal((await registry.getDomain(nested.id)).state, 'active');
  assert.equal((await registry.getDomain(root.id)).state, 'draft');
  assert.equal((await registry.getDomain(child.id)).state, 'draft');
});

test('reparent preview lists descendants and apply changes hierarchy without touching traffic state', async (t) => {
  const filePath = await fixture(t);
  const registry = createDomainRegistry({ filePath });
  const root = await registry.createDomain(input('example.com'));
  const child = await registry.createDomain(input('api.example.com', { parentDomainId: root.id, httpsMode: 'managed' }));
  const nested = await registry.createDomain(input('v2.api.example.com', { parentDomainId: child.id, target: { upstreamPort: 4400 } }));
  await registry.markStaged(child.id, { checksum: 'a'.repeat(64), configName: 'api.conf' });
  await registry.markApplied(child.id, { checksum: 'a'.repeat(64) });
  const before = await registry.getDomain(child.id);

  const preview = await registry.previewDomainReparent({ domainId: child.id, parentDomainId: null });
  assert.equal(preview.currentParentDomainId, root.id);
  assert.equal(preview.nextParentDomainId, null);
  assert.equal(preview.confirmation, `reparent:${child.id}:root:${preview.previewDigest}`);
  assert.deepEqual(preview.impact.descendants, [
    { id: nested.id, primaryDomain: nested.primaryDomain, parentDomainId: child.id },
  ]);
  assert.deepEqual(preview.impact, {
    hierarchyOnly: true,
    domainTrafficChanged: false,
    websiteId: null,
    certificateId: null,
    descendantCount: 1,
    descendants: preview.impact.descendants,
  });

  const result = await registry.reparentDomain({
    domainId: child.id,
    parentDomainId: null,
    previewDigest: preview.previewDigest,
  });
  assert.equal(result.domain.parentDomainId, null);
  assert.equal(result.domain.kind, 'domain');
  assert.equal(result.domain.desiredRevision, before.desiredRevision);
  assert.equal(result.domain.appliedRevision, before.appliedRevision);
  assert.equal(result.domain.stagedChecksum, before.stagedChecksum);
  assert.deepEqual(result.domain.target, before.target);
  assert.equal((await registry.getDomain(nested.id)).parentDomainId, child.id);

  const reopened = createDomainRegistry({ filePath });
  assert.equal((await reopened.getDomain(child.id)).parentDomainId, null);
});

test('reparent rejects cycle, cross-server and dot-boundary violations before persistence', async (t) => {
  const filePath = await fixture(t);
  const registry = createDomainRegistry({ filePath });
  const root = await registry.createDomain(input('example.com'));
  const child = await registry.createDomain(input('api.example.com', { parentDomainId: root.id }));
  const remote = await registry.createDomain(input('other.example', { serverId: 'remote' }));
  const unrelated = await registry.createDomain(input('api.other.example'));
  const lookalike = await registry.createDomain(input('api.badexample.com'));
  const before = await readFile(filePath, 'utf8');

  for (const [domainId, parentDomainId, code] of [
    [root.id, child.id, 'domain_parent_cycle'],
    [unrelated.id, remote.id, 'parent_server_mismatch'],
    [lookalike.id, root.id, 'invalid_subdomain_parent'],
    [child.id, 'missing-parent', 'parent_domain_not_found'],
  ]) {
    await assert.rejects(
      registry.previewDomainReparent({ domainId, parentDomainId }),
      (error) => error instanceof DomainRegistryError && error.code === code,
    );
    assert.equal(await readFile(filePath, 'utf8'), before);
  }
});

test('reparent digest becomes stale when hierarchy changes and no-op is explicit', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(input('example.com'));
  const child = await registry.createDomain(input('api.example.com', { parentDomainId: root.id }));
  const preview = await registry.previewDomainReparent({ domainId: child.id, parentDomainId: null });
  await registry.createDomain(input('new.example.com', { parentDomainId: root.id }));

  await assert.rejects(
    registry.reparentDomain({ domainId: child.id, parentDomainId: null, previewDigest: preview.previewDigest }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_reparent_preview_stale',
  );
  assert.equal((await registry.getDomain(child.id)).parentDomainId, root.id);
  await assert.rejects(
    registry.previewDomainReparent({ domainId: child.id, parentDomainId: root.id }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_reparent_no_changes',
  );
});
