import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { websiteProvisioningRetirementInternals as policy } from '../src/website-provisioning-retirement-provider.js';

// Pure policy inputs. They do not stand in for a running host or claim that a
// provisioning/removal service has executed. Native25 supplies that acceptance.
function policyInput() {
  const source = {
    operationId: '11111111-1111-4111-8111-111111111111', websiteId: '22222222-2222-4222-8222-222222222222',
    applicationId: '33333333-3333-4333-8333-333333333333', serverId: 'local', name: 'Owned site',
    createdAt: '2026-11-13T00:00:00.000Z', primaryDomain: 'owned.example.test',
    domains: [{ id: '44444444-4444-4444-8444-444444444444', primaryDomain: 'owned.example.test' }],
    names: ['owned.example.test'], checksum: 'a'.repeat(64), configName: 'yunpanel-owned.example.test.conf',
  };
  return {
    source, namespace: [], website: null, application: null,
    websiteRemovals: [{
      id: 'ws-rem-policy', websiteId: source.websiteId, applicationId: source.applicationId, serverId: source.serverId,
      label: source.name, status: 'removed', error: null, createdAt: '2026-11-13T00:01:00.000Z', updatedAt: '2026-11-13T00:03:00.000Z',
      plan: { applicationId: source.applicationId, domains: source.domains },
      steps: [
        { kind: 'domain_removal', resourceId: source.domains[0].id, status: 'succeeded', error: null, result: { domainRemoved: true, domainId: source.domains[0].id } },
        { kind: 'metadata_finalization', resourceId: source.websiteId, status: 'succeeded', error: null, result: { finalized: true } },
        { kind: 'application_cleanup', resourceId: source.applicationId, status: 'succeeded', error: null, result: { applicationCleaned: true } },
      ],
    }],
    domainRemovals: [{
      id: 'domain-rem-policy', domainId: source.domains[0].id, serverId: source.serverId, primaryDomain: source.primaryDomain,
      status: 'removed', error: null, createdAt: '2026-11-13T00:01:00.000Z', updatedAt: '2026-11-13T00:02:00.000Z',
      plan: { websiteId: source.websiteId },
      steps: [{ kind: 'metadata_finalization', resourceId: source.domains[0].id, status: 'succeeded', error: null,
        result: { referenceId: source.domains[0].id, evidenceDigest: 'b'.repeat(64) } }],
    }],
    nginx: { satisfied: false, reason: 'nginx_compensation_pending', receiptVersion: 1, hadPreviousActive: false,
      previousPrimaryDomain: null, configName: source.configName, checksum: source.checksum },
  };
}

test('pure retirement policy accepts only exact terminal ownership and a validated absent-before receipt summary', () => {
  for (const satisfied of [false, true]) {
    const input = policyInput(); input.nginx.satisfied = satisfied;
    const result = policy.verifyRetirement(input);
    assert.equal(result.retired, true); assert.equal(result.reset, false);
    assert.equal(result.removalOperationId, 'ws-rem-policy');
    assert.deepEqual(result.domainRemovalIds, ['domain-rem-policy']);
    assert.equal(Object.hasOwn(result, 'receipt'), false);
    assert.equal(Object.hasOwn(result, 'content'), false);
  }
});

const failures = [
  ['current Website', input => { input.website = { id: input.source.websiteId }; }],
  ['current Application', input => { input.application = { id: input.source.applicationId }; }],
  ['current old Domain identity', input => { input.namespace = [{ id: input.source.domains[0].id, primaryDomain: 'unrelated.example.test' }]; }],
  ['reassigned primary', input => { input.namespace = [{ id: 'other', primaryDomain: input.source.primaryDomain }]; }],
  ['reassigned alias even after config absence', input => { input.nginx.satisfied = true; input.namespace = [{ id: 'other', primaryDomain: 'other.example.test', aliases: [input.source.primaryDomain] }]; }],
  ['retained applied hostname', input => { input.namespace = [{ id: 'other', primaryDomain: 'other.example.test', appliedPrimaryDomain: input.source.primaryDomain }]; }],
  ['nonterminal Website removal', input => { input.websiteRemovals[0].status = 'running'; }],
  ['foreign Website removal', input => { input.websiteRemovals[0].websiteId = 'foreign'; }],
  ['foreign server', input => { input.websiteRemovals[0].serverId = 'foreign'; }],
  ['foreign name', input => { input.websiteRemovals[0].label = 'Foreign'; }],
  ['unfinished Website step', input => { input.websiteRemovals[0].steps[0].status = 'running'; }],
  ['missing Domain removal', input => { input.domainRemovals = []; }],
  ['foreign Domain removal Website', input => { input.domainRemovals[0].plan.websiteId = 'foreign'; }],
  ['nonterminal Domain removal', input => { input.domainRemovals[0].status = 'blocked'; }],
  ['unowned Domain metadata absence', input => { input.domainRemovals[0].steps[0].result = {}; }],
  ['old removal timestamp', input => { input.domainRemovals[0].createdAt = '2026-11-12T00:00:00.000Z'; }],
  ['missing receipt', input => { input.nginx = { satisfied: false, reason: 'nginx_compensation_receipt_missing' }; }],
  ['prior active config', input => { input.nginx.hadPreviousActive = true; }],
  ['rename receipt', input => { input.nginx.previousPrimaryDomain = 'old.example.test'; }],
  ['checksum drift', input => { input.nginx.checksum = 'f'.repeat(64); }],
  ['config name drift', input => { input.nginx.configName = 'foreign.conf'; }],
  ['unverified absence', input => { delete input.nginx.receiptVersion; input.nginx.satisfied = true; }],
];
for (const [name, mutate] of failures) test('pure retirement policy refuses ' + name, () => {
  const input = policyInput(); mutate(input);
  assert.throws(() => policy.verifyRetirement(input), error => error.code?.startsWith('website_provisioning_retirement_'));
});

test('pure original-routing policy binds the immutable operation, resource IDs, names and activation evidence', () => {
  const { source } = policyInput();
  const operation = {
    operationId: source.operationId, websiteId: source.websiteId, createdAt: source.createdAt, terminalState: null,
    resources: {
      website: { id: source.websiteId, serverId: source.serverId, name: source.name, applicationId: source.applicationId },
      application: { id: source.applicationId, serverId: source.serverId },
      primaryDomain: { ...source.domains[0], websiteId: source.websiteId, serverId: source.serverId, aliases: [] },
    },
    steps: [
      { id: 'nginx', intent: { websiteId: source.websiteId, primaryDomain: source.primaryDomain, aliases: [] }, evidence: { satisfied: true, active: true, checksum: source.checksum, configName: source.configName } },
      { id: 'domain_activation', intent: { adapter: 'domain-activation', websiteId: source.websiteId, domains: [{ domainId: source.domains[0].id, expectedRevision: 1 }] },
        evidence: { satisfied: true, adapter: 'domain-activation', websiteId: source.websiteId,
          domains: [{ domainId: source.domains[0].id, expectedRevision: 1 }], nginxChecksum: source.checksum, nginxConfigName: source.configName } },
    ],
  };
  assert.equal(policy.originalRouting(operation, source, source.serverId).checksum, source.checksum);
  for (const mutate of [
    value => { value.operationId = 'foreign'; },
    value => { value.terminalState = 'abandoned'; },
    value => { value.resources.application.serverId = 'foreign'; },
    value => { value.resources.primaryDomain.websiteId = 'foreign'; },
    value => { value.steps[0].intent.aliases = ['foreign.example.test']; },
    value => { value.steps[1].evidence.nginxChecksum = 'f'.repeat(64); },
  ]) {
    const changed = structuredClone(operation); mutate(changed);
    assert.throws(() => policy.originalRouting(changed, source, source.serverId), error => error.code?.startsWith('website_provisioning_retirement_'));
  }
});

test('real file-backed Domain namespace reservation blocks create, alias update and skipLock reparent until the lease ends', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 't892-routing-namespace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const servers = createServerRegistry({ filePath: path.join(dir, 'servers.json') });
  await servers.init();
  const server = await servers.createLocalServer({ hostname: 'panel.example.test' });
  const registry = createDomainRegistry({ filePath: path.join(dir, 'domains.json'), serverExists: async id => Boolean(await servers.getServer(id)) });
  await registry.init();
  const create = (primaryDomain, parentDomainId = null) => registry.createDomain({ serverId: server.id, primaryDomain, parentDomainId, targetType: 'proxy', target: { upstreamPort: 3010 } });
  const parent = await create('example.test');
  const subparent = await create('sub.example.test', parent.id);
  const child = await create('leaf.sub.example.test', parent.id);
  const writes = [
    async () => () => create('new.example.test', parent.id),
    async () => {
      const changes = { aliases: ['reserved.example.test'] };
      const preview = await registry.previewDomainUpdate({ domainId: parent.id, changes });
      return () => registry.updateDomain({ domainId: parent.id, changes, previewDigest: preview.previewDigest, skipLock: true });
    },
    async () => {
      const preview = await registry.previewDomainReparent({ domainId: child.id, parentDomainId: subparent.id });
      return () => registry.reparentDomain({ domainId: child.id, parentDomainId: subparent.id, previewDigest: preview.previewDigest, skipLock: true });
    },
  ];
  for (const prepare of writes) {
    const write = await prepare();
    let entered, release;
    const arrived = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const before = await readFile(path.join(dir, 'domains.json'), 'utf8');
    const lease = registry.withRoutingNamespaceReservation(async snapshot => {
      assert.ok(Object.isFrozen(snapshot)); assert.ok(snapshot.every(item => Object.isFrozen(item) && Object.isFrozen(item.aliases)));
      assert.throws(() => { snapshot[0].aliases.push('forbidden.example.test'); }, TypeError);
      entered(); await held;
    });
    await arrived;
    let completed = false;
    const mutation = write().finally(() => { completed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(completed, false);
      assert.equal(await readFile(path.join(dir, 'domains.json'), 'utf8'), before);
    } finally { release(); }
    await lease; await mutation;
  }
  assert.deepEqual((await registry.getDomain(parent.id)).aliases, ['reserved.example.test']);
  assert.equal((await registry.getDomain(child.id)).parentDomainId, subparent.id);
  assert.ok((await registry.listDomains()).some(domain => domain.primaryDomain === 'new.example.test'));
  await assert.rejects(registry.withRoutingNamespaceReservation(async () => { throw new Error('owned lease failure'); }), /owned lease failure/);
  await create('after-failure.example.test', parent.id);
});
