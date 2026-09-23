import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { mountWebsiteRemovalRoutes } from '../src/website-removal-http.js';
import { removalFixture, removalPreview, removalStart, removalContinue, deferred } from '../test-support/website-removal-fixture.js';

const code = (expected) => (error) => error.code === expected;
for (const [title, changes, expected] of [
  ['missing Website', { websiteId: undefined }, 'website_removal_target_invalid'],
  ['invalid Website', { websiteId: '../other' }, 'website_removal_target_invalid'],
  ['another Website', { websiteId: 'site-b' }, 'website_removal_confirmation_invalid'],
  ['missing digest', { previewDigest: undefined }, 'website_removal_confirmation_invalid'],
  ['invalid digest', { previewDigest: 'x' }, 'website_removal_confirmation_invalid'],
  ['different digest', { previewDigest: 'b'.repeat(64) }, 'website_removal_preview_stale'],
  ['another confirmation', { confirmation: `start-website-remove:site-b:1:${'a'.repeat(64)}` }, 'website_removal_confirmation_invalid'],
  ['modified confirmation', { confirmation: `start-website-remove:site-a:1:${'b'.repeat(64)}` }, 'website_removal_preview_stale'],
]) {
  test(`start rejects ${title} before creating a removal operation`, async () => {
    const f = await removalFixture();
    await assert.rejects(f.runtime.start({ ...removalStart(f.preview), ...changes }), code(expected));
    assert.equal((await f.registry.list()).length, 0); assert.equal(f.calls.length, 0);
  });
}
for (const changes of [{ website: { id: 'other' } }, { readyToStart: false }, { readyToStart: 'true' }, { previewDigest: 'b'.repeat(64) }]) {
  test(`start rejects mismatched preview evidence: ${JSON.stringify(changes)}`, async () => {
    const original = removalPreview();
    const f = await removalFixture({ previewProvider: async () => ({ ...original, ...changes }) });
    await assert.rejects(f.runtime.start(removalStart(original)), code('website_removal_preview_stale'));
    assert.equal((await f.registry.list()).length, 0); assert.equal(f.calls.length, 0);
  });
}
test('valid explicit target enters the existing cleanup runtime', async () => {
  const f = await removalFixture(); const op = await f.runtime.start(removalStart(f.preview));
  assert.equal(op.websiteId, 'site-a'); assert.equal(f.calls.length, 1);
  assert.equal(op.steps[0].status, 'succeeded');
});
for (const changes of [{ websiteId: 'other' }, { stepId: 'old-step' }, { expectedUpdatedAt: new Date(0).toISOString() }, { confirmation: 'old' }]) {
  test(`stale or wrong-target continuation does not execute cleanup: ${JSON.stringify(changes)}`, async () => {
    const f = await removalFixture(); const op = await f.runtime.start(removalStart(f.preview));
    const before = await f.registry.get(op.id);
    await assert.rejects(f.runtime.continueStep({ ...removalContinue(op), ...changes }),
      code(changes.websiteId ? 'operation_not_found' : 'website_removal_step_continuation_stale'));
    assert.deepEqual(await f.registry.get(op.id), before); assert.equal(f.calls.length, 1);
  });
}
test('finished operation continuation is a 409, not a null-step TypeError', async () => {
  const f = await removalFixture(); let op = await f.runtime.start(removalStart(f.preview));
  const stale = removalContinue(op);
  op = await f.runtime.continueStep(stale); assert.equal(op.status, 'removed');
  await assert.rejects(f.runtime.continueStep(stale), code('website_removal_step_continuation_stale'));
});
test('two runtime instances sharing a registry cannot start the same Website concurrently', async () => {
  const entered = deferred(), wait = deferred();
  const f = await removalFixture({ previewProvider: async () => { entered.resolve(); await wait.promise; return removalPreview(); } });
  const second = createWebsiteRemovalRuntime(f.dependencies);
  const running = f.runtime.start(removalStart(f.preview)); await entered.promise;
  await assert.rejects(second.start(removalStart(f.preview)), code('website_removal_busy'));
  wait.resolve(); await running;
  assert.equal((await f.registry.list()).length, 1); assert.equal(f.calls.length, 1);
});
test('overlapping continuation cannot replay an in-flight cleanup step', async () => {
  const entered = deferred(), wait = deferred(); let cleanups = 0;
  const f = await removalFixture({ fileCleanupHandler: async (input) => { cleanups++; entered.resolve(); await wait.promise; return { ...input, filesCleaned: true }; } });
  const op = await f.registry.create(f.preview);
  const current = await f.runtime.get(op.id);
  const running = f.runtime.continueStep(removalContinue(current)); await entered.promise;
  await assert.rejects(f.runtime.continueStep(removalContinue(current)), code('website_removal_busy'));
  wait.resolve(); await running; assert.equal(cleanups, 1);
});
test('failed preview releases the in-process guard for a corrected request', async () => {
  let broken = true;
  const f = await removalFixture({ previewProvider: async () => { if (broken) throw new Error('fixture failure'); return removalPreview(); } });
  await assert.rejects(f.runtime.start(removalStart(f.preview)), /fixture failure/);
  broken = false; await f.runtime.start(removalStart(f.preview)); assert.equal(f.calls.length, 1);
});
test('a pending request snapshots its target and confirmation before awaiting', async () => {
  const entered = deferred(), wait = deferred();
  const f = await removalFixture({ previewProvider: async () => { entered.resolve(); await wait.promise; return removalPreview(); } });
  const submitted = removalStart(f.preview); const running = f.runtime.start(submitted); await entered.promise;
  submitted.websiteId = 'site-b'; submitted.confirmation = 'other'; wait.resolve();
  assert.equal((await running).websiteId, 'site-a');
});

// Execute the actual route callback. This is not an Express/auth-cookie/browser test.
for (const [websiteId, exists, expected] of [['site-a', true, 200], ['site-b', true, 404], ['site-a', false, 404]]) {
  test(`operation detail is bound to URL Website: ${websiteId}, exists=${exists}`, async () => {
    const routes = new Map(); const route = '/api/websites/:websiteId/removal-operations/:operationId';
    const f = await removalFixture(); const operation = await f.runtime.start(removalStart(f.preview));
    mountWebsiteRemovalRoutes({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)), post() {} },
      { runtime: { ...f.runtime, get: async () => exists ? operation : null } });
    let status = 200, payload;
    await routes.get(route)({ params: { websiteId, operationId: operation.id } }, { json: (data) => { payload = data; } },
      (error) => { status = error.status; });
    assert.equal(status, expected);
    if (expected === 404) assert.equal(payload, undefined); else assert.equal(payload.operation.id, operation.id);
  });
}
