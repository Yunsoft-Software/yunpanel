import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

// Execute the real route module, substituting only its outer engine/planner and
// middleware boundaries. No Express listener, real auth, hashing or host here.
// The child enables Node's built-in module mocks without changing npm test flags.
test('mounted site create route awaits users, preserves partial results and existing guard/envelope contracts', () => {
  const routeUrl = new URL('../src/site-create-http.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const route = ${JSON.stringify(routeUrl)};
    const input = { operationId: '22222222-2222-4222-8222-222222222222', serverId: '44444444-4444-4444-8444-444444444444', siteAdmin: { email: 'admin@example.test', password: 'fixture-only-password' } };
    const websiteId = '11111111-1111-4111-8111-111111111111';
    let creates = 0, previews = 0, planner = null, replay = false, createError = false, calls = 0;
    const guard = () => {};
    class SiteCreateError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
    mock.module(new URL('./panel-http-guard.js', route).href, { namedExports: { requirePanelRouteAccess: guard } });
    mock.module(new URL('./site-create-isolation-guard.js', route).href, { namedExports: {
      SiteCreateError,
      createSite: async (options) => {
        creates++; assert.equal(options.confirmation, 'fixture-confirmation');
        if (createError) throw new SiteCreateError('site_create_confirmation_required', 'fixture');
        return { operationId: input.operationId, created: !replay, resumed: false, website: { id: websiteId, serverId: input.serverId }, primaryDomain: { websiteId } };
      },
      previewSiteCreate: async () => { previews++; return { fixture: true }; },
    } });
    for (const [file, kind] of [['site-create-dns-provisioning.js', 'dns'], ['site-create-mail-provisioning.js', 'mail']]) {
      mock.module(new URL('./' + file, route).href, { namedExports: { siteCreateProvisioningPlan: async () => { planner = kind; return { fixturePlan: true }; } } });
    }
    const { mountSiteCreateRoutes } = await import(route);
    const routes = new Map(); let resolveUser;
    const store = { createSiteManager: (args) => { calls++; assert.equal(args.username, 'admin@example.test'); assert.equal(args.actorId, 'owner-id'); return new Promise((resolve) => { resolveUser = resolve; }); } };
    mountSiteCreateRoutes({ post: (path, ...handlers) => routes.set(path, handlers) }, { localServerId: input.serverId, userAdminStore: store, websiteProvisioningRegistry: { create: async (plan) => ({ ...plan, persisted: true }) } });
    assert.deepEqual([...routes.keys()], ['/api/sites/create-preview', '/api/sites']);
    for (const handlers of routes.values()) assert.equal(handlers[0], guard);
    const invoke = async (body, path = '/api/sites') => {
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
      await routes.get(path)[1]({ body, auth: { user: { id: 'owner-id' } } }, res, (error) => { res.error = error; }); return res;
    };
    const body = { input, confirmation: 'fixture-confirmation', previewDigest: 'a'.repeat(64) };
    let done = false; const pending = invoke(body).then((value) => { done = true; return value; });
    await new Promise(setImmediate); assert.equal(done, false); assert.equal(calls, 1);
    resolveUser({ id: '33333333-3333-4333-8333-333333333333', username: 'admin@example.test', role: 'site_manager', active: true, websiteIds: [websiteId] });
    let response = await pending; assert.equal(response.statusCode, 201); assert.equal(response.body.data.siteAdmin.status, 'created'); assert.equal(response.body.data.provisioning.persisted, true); assert.equal(planner, 'dns');
    store.createSiteManager = async () => { calls++; throw new Error('private-password-and-sql-error'); };
    response = await invoke(body); assert.equal(response.statusCode, 201); assert.equal(response.body.data.website.id, websiteId); assert.equal(response.body.data.siteAdmin.status, 'attention'); assert.equal(JSON.stringify(response).includes('private-password'), false);
    replay = true; const prior = calls; response = await invoke(body); assert.equal(response.statusCode, 200); assert.equal(calls, prior); assert.equal(response.body.data.siteAdmin.code, 'site_admin_replay_requires_review');
    const before = creates;
    for (const invalid of [{ ...body, unexpected: true }, { ...body, previewDigest: 'invalid' }, { ...body, input: { ...input, serverId: 'other-host' } }]) {
      response = await invoke(invalid); assert.ok(response.error); assert.equal(response.body, undefined);
    }
    assert.equal(creates, before);
    createError = true; response = await invoke(body); assert.equal(response.error.code, 'site_create_confirmation_required'); assert.equal(calls, prior);
    response = await invoke({ input }, '/api/sites/create-preview'); assert.ok(response.body.data.provisioning); assert.equal(calls, prior); assert.ok(previews > 0);
  `;
  const stdout = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(stdout, '');
});
