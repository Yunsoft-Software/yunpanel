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

test('legacy state is read without rewrite or guessed ancestry', async (t) => {
  const filePath = await fixture(t);
  const seed = createDomainRegistry();
  const records = [await seed.createDomain(input()), await seed.createDomain(input('api.example.com.tr'))];
  for (const record of records) {
    delete record.kind;
    delete record.parentDomainId;
    record.state = 'active';
    record.certificateId = `cert-${record.id}`;
    record.desiredRevision = 5;
    record.appliedRevision = 5;
  }
  const before = JSON.stringify({ version: 1, domains: records });
  await writeFile(filePath, before);
  const registry = createDomainRegistry({ filePath });
  const loaded = await registry.listDomains();
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
