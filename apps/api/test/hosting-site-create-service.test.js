import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHostingSiteCreateService } from '../src/hosting-site-create-service.js';
import { siteFixture, website, uuid } from '../test-support/hosting-site-fixture.js';

const code = (expected) => (error) => error.code === expected;
function setup(t, changes = {}) {
  const f = siteFixture(t, changes);
  f.calls = []; f.sites = new Map(); f.applications = new Map(); f.domains = new Map(); f.mailDomains = new Map();
  f.lockCalls = []; f.site = website();
  f.value = { customerId: 'customer-a', input: { operationId: uuid(1001), serverId: uuid(100) } };
  f.base = () => ({ operationId: f.value.input.operationId, ids: {
    websiteId: f.site.id,
    applicationId: f.site.applicationId,
    primaryDomainId: uuid(2),
    wwwDomainId: null,
    mailDomainId: null,
  },
    previewDigest: 'b'.repeat(64), confirmation: 'original-confirmation',
    blockers: [], steps: { websiteReady: f.sites.has(f.site.id) }, source: { kind: 'external_proxy' },
    plan: { website: f.site, application: null } });
  f.previewAdapter = async () => f.base();
  f.createAdapter = async (args) => { f.calls.push(args); f.sites.set(f.site.id, structuredClone(f.site)); return { created: true, website: f.site }; };
  f.readAdapter = async (id) => f.sites.get(id) ?? null;
  f.siteMutationLock = {
    withSiteLock: async (identity, action) => {
      f.lockCalls.push(structuredClone(identity));
      return action();
    },
  };
  f.service = createHostingSiteCreateService({ hostingAccounts: f.store,
    websiteRegistry: { getWebsite: (id) => f.readAdapter(id) },
    applicationRegistry: { getApplication: async (id) => f.applications.get(id) ?? null },
    domainRegistry: { getDomain: async (id) => f.domains.get(id) ?? null },
    mailDomainRegistry: { getMailDomain: async (id) => f.mailDomains.get(id) ?? null },
    siteMutationLock: f.siteMutationLock,
    localServerId: uuid(100),
    previewSiteCreate: (input) => f.previewAdapter(input), createSite: (apply) => f.createAdapter(apply) });
  f.previewHosted = () => f.service.preview(f.token, f.requireManagement, f.value);
  f.submit = async () => {
    const preview = await f.previewHosted();
    return { ...f.value, previewDigest: preview.previewDigest, confirmation: preview.confirmation };
  };
  f.createHosted = async (value) => f.service.create(f.token, f.requireManagement, value ?? await f.submit());
  f.recoverHosted = async (value) => f.service.recoverReservation(f.token, f.requireManagement, value ?? await f.submit());
  return f;
}
test('read-only preview binds customer and plan; create reuses the existing adapters', async (t) => {
  const f = setup(t); const preview = await f.previewHosted();
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  assert.notEqual(preview.previewDigest, f.base().previewDigest);
  const result = await f.createHosted();
  assert.equal(result.created, true); assert.equal(result.ownership.state, 'attached');
  assert.equal(result.provisioningReady, false); assert.equal(result.accessGranted, false);
  assert.equal(f.calls[0].previewDigest, 'b'.repeat(64)); assert.equal(f.calls[0].confirmation, 'original-confirmation');
  assert.equal(f.get().usage.websites, 1); assert.equal(f.count('auth_user_websites'), 0);
});
test('completed retry does not invoke create again or double-charge quota', async (t) => {
  const f = setup(t); await f.createHosted(); const again = await f.createHosted();
  assert.equal(again.created, false); assert.equal(f.calls.length, 1); assert.equal(f.get().usage.websites, 1);
});
test('customer substitution invalidates a prior confirmation before quota is reserved', async (t) => {
  const f = setup(t); const input = await f.submit();
  await assert.rejects(f.createHosted({ ...input, customerId: 'customer-b' }), code('hosting_site_preview_stale'));
  assert.equal(f.calls.length, 0); assert.equal(f.count('auth_hosting_site_allocations'), 0);
});
test('stale base preview and wrong confirmation produce no side effects', async (t) => {
  const f = setup(t); const input = await f.submit();
  await assert.rejects(f.createHosted({ ...input, confirmation: 'wrong' }), code('hosting_site_preview_stale'));
  const base = f.base; f.base = () => ({ ...base(), previewDigest: 'c'.repeat(64) });
  await assert.rejects(f.createHosted(input), code('hosting_site_preview_stale'));
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
});
test('timeout after Website persistence retains capacity; re-created service can resume', async (t) => {
  const f = setup(t);
  const create = f.createAdapter;
  f.createAdapter = async (args) => { await create(args); throw new Error('simulated disconnect'); };
  await assert.rejects(f.createHosted(), /simulated disconnect/);
  assert.equal(f.get().usage.websites, 1); assert.equal(f.count('auth_customer_websites'), 0);
  f.createAdapter = async (args) => { f.calls.push(args); return { created: false, website: f.site }; };
  const result = await f.createHosted();
  assert.equal(result.ownership.state, 'attached'); assert.equal(f.get().usage.websites, 1);
});
test('a fake success response without a persisted Website does not attach ownership', async (t) => {
  const f = setup(t); f.createAdapter = async () => ({ created: true, website: f.site });
  await assert.rejects(f.createHosted(), code('hosting_site_persistence_unverified'));
  assert.equal(f.get().usage.websites, 1); assert.equal(f.count('auth_customer_websites'), 0);
});
for (const patch of [{ serverId: uuid(200) }, { unixUser: 'root' }, { revision: 2 }]) {
  test(`mismatched persisted Website cannot finalize: ${JSON.stringify(patch)}`, async (t) => {
    const f = setup(t); const create = f.createAdapter;
    f.createAdapter = async (args) => { const result = await create(args); f.sites.set(f.site.id, { ...f.site, ...patch }); return result; };
    await assert.rejects(f.createHosted(), code('hosting_site_identity_conflict'));
    assert.equal(f.count('auth_customer_websites'), 0);
  });
}
test('logout while previewing cannot reserve; logout after creation retains hold but not ownership', async (t) => {
  const f = setup(t); const submitted = await f.submit();
  f.previewAdapter = async () => { f.db.exec("DELETE FROM sessions WHERE user_id = 'owner'"); return f.base(); };
  await assert.rejects(f.createHosted(submitted), code('unauthorized'));
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  f.token = f.session('owner'); f.previewAdapter = async () => f.base(); const create = f.createAdapter;
  f.createAdapter = async (args) => { const result = await create(args); f.db.exec("DELETE FROM sessions WHERE user_id = 'owner'"); return result; };
  await assert.rejects(f.createHosted(), code('unauthorized'));
  assert.equal(f.count('auth_hosting_site_allocations'), 1); assert.equal(f.count('auth_customer_websites'), 0);
});
test('unallocated existing Website requires migration, never silent adoption', async (t) => {
  const f = setup(t); f.sites.set(f.site.id, f.site);
  await assert.rejects(f.previewHosted(), code('hosting_site_migration_required'));
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
});
test('existing Website discovered after preview is rejected before reserve', async (t) => {
  const f = setup(t); f.readAdapter = async () => f.site;
  await assert.rejects(f.createHosted(), code('hosting_site_migration_required'));
  assert.equal(f.calls.length, 0); assert.equal(f.count('auth_hosting_site_allocations'), 0);
});
test('remote host, duplicate login and actor/usage fields fail without creation', async (t) => {
  const f = setup(t);
  f.value.input.serverId = uuid(200); await assert.rejects(f.previewHosted(), code('local_server_required'));
  f.value.input.serverId = uuid(100); f.value.input.siteAdmin = { email: 'fixture@example.test', password: 'not-persisted' };
  await assert.rejects(f.previewHosted(), code('hosting_site_admin_conflict'));
  delete f.value.input.siteAdmin;
  await assert.rejects(f.service.preview(f.token, f.requireManagement, { ...f.value, usage: 0 }), code('invalid_hosting_site_request'));
  assert.equal(f.calls.length, 0);
});
test('known blockers never reserve a quota slot', async (t) => {
  const f = setup(t); const base = f.base; f.base = () => ({ ...base(), blockers: ['dns_identity_required'] });
  await assert.rejects(f.createHosted(), code('hosting_site_blocked'));
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
});
test('input is snapshotted before asynchronous preview', async (t) => {
  const f = setup(t); const submitted = await f.submit(); let proceed;
  f.previewAdapter = () => new Promise((resolve) => { proceed = () => resolve(f.base()); });
  const result = f.createHosted(submitted); submitted.input.serverId = uuid(200); submitted.customerId = 'customer-b';
  // Creation is queued to serialize duplicate operations. Wait for preview to start.
  await new Promise((resolve) => setImmediate(resolve));
  proceed(); await result;
  assert.equal(f.calls[0].input.serverId, uuid(100));
  assert.equal(f.db.prepare('SELECT customer_id FROM auth_customer_websites').get().customer_id, 'customer-a');
});
test('construction requires explicit local host and live dependencies', () => {
  assert.throws(() => createHostingSiteCreateService({}), /requires/);
});
test('runtime composition uses existing isolated site engine, no HTTP or role change', async () => {
  const source = await readFile(new URL('../src/hosting-site-create-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/site-create-isolation-guard.js'/);
  assert.match(source, /userAdminStore\?\.hostingAccounts/);
  assert.doesNotMatch(source, /app\.(post|use)|auth_user_websites|INSERT|createSiteManager/);
});

test('simultaneous repeats on the same service invoke the existing creator only once', async (t) => {
  const f = setup(t); const submitted = await f.submit();
  const [first, second] = await Promise.all([f.createHosted(submitted), f.createHosted(submitted)]);
  assert.equal(first.ownership.state, 'attached'); assert.equal(second.ownership.state, 'attached');
  assert.equal(f.calls.length, 1); assert.equal(f.count('auth_hosting_site_allocations'), 1);
});


test('hosted create holds the shared site lock across reserve, metadata creation and ownership attach', async (t) => {
  const f = setup(t);
  const result = await f.createHosted();
  assert.equal(result.ownership.state, 'attached');
  assert.deepEqual(f.lockCalls, [{ applicationId: null, websiteId: f.site.id }]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].siteMutationLock, null);
});

test('explicit recovery releases a reserved hold only when operation-owned metadata is absent', async (t) => {
  const f = setup(t);
  const submitted = await f.submit();
  f.createAdapter = async () => ({ created: true, website: f.site });
  await assert.rejects(f.createHosted(submitted), code('hosting_site_persistence_unverified'));
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
  assert.equal(f.get().usage.websites, 1);

  const recovered = await f.recoverHosted(submitted);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.stage, 'reservation_released');
  assert.equal(recovered.ownership.released, true);
  assert.equal(recovered.ownership.quotaReleased, true);
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  assert.equal(f.get().usage.websites, 0);
});

test('reservation recovery refuses a persisted Website and keeps capacity reserved', async (t) => {
  const f = setup(t);
  const submitted = await f.submit();
  const create = f.createAdapter;
  f.createAdapter = async (args) => {
    await create(args);
    throw new Error('reply lost after Website persistence');
  };
  await assert.rejects(f.createHosted(submitted), /reply lost/);
  await assert.rejects(
    f.recoverHosted(submitted),
    code('hosting_site_recovery_partial_resources_present'),
  );
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
  assert.equal(f.get().usage.websites, 1);
});

test('reservation recovery refuses planned Domain residue even when Website metadata is absent', async (t) => {
  const f = setup(t);
  const submitted = await f.submit();
  f.createAdapter = async () => ({ created: true, website: f.site });
  await assert.rejects(f.createHosted(submitted), code('hosting_site_persistence_unverified'));
  f.domains.set(uuid(2), { id: uuid(2) });
  await assert.rejects(
    f.recoverHosted(submitted),
    code('hosting_site_recovery_partial_resources_present'),
  );
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
});

test('reservation recovery refuses an operation-owned Application residue', async (t) => {
  const f = setup(t);
  const applicationId = uuid(3);
  f.site = {
    ...f.site,
    applicationId,
    runtimeType: 'static',
    documentRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
    unixUser: 'yunapp-123456789abc',
    proxyTarget: null,
  };
  f.base = () => ({
    operationId: f.value.input.operationId,
    ids: {
      websiteId: f.site.id,
      applicationId,
      primaryDomainId: uuid(2),
      wwwDomainId: null,
      mailDomainId: null,
    },
    previewDigest: 'b'.repeat(64),
    confirmation: 'original-confirmation',
    blockers: [],
    steps: { websiteReady: false },
    source: { kind: 'new_static' },
    plan: { website: f.site, application: { id: applicationId } },
  });
  const submitted = await f.submit();
  f.createAdapter = async () => ({ created: true, website: f.site });
  f.applications.set(applicationId, { id: applicationId });
  await assert.rejects(f.createHosted(submitted), code('hosting_site_persistence_unverified'));
  await assert.rejects(
    f.recoverHosted(submitted),
    code('hosting_site_recovery_partial_resources_present'),
  );
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
});

test('attached ownership cannot use reservation recovery and must use Website removal', async (t) => {
  const f = setup(t);
  const submitted = await f.submit();
  await f.createHosted(submitted);
  await assert.rejects(
    f.recoverHosted(submitted),
    code('hosting_site_recovery_requires_removal'),
  );
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
  assert.equal(f.count('auth_customer_websites'), 1);
});
