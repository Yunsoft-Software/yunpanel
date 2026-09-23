import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { siteAdminResult, siteAdminMessage } from '../src/workspace/site-admin-result.js';
import { createSiteSubmission } from '../src/workspace/site-create-submission.js';

const operationId = '22222222-2222-4222-8222-222222222222';
const websiteId = '11111111-1111-4111-8111-111111111111';
const domainId = '33333333-3333-4333-8333-333333333333';
const serverId = '44444444-4444-4444-8444-444444444444';
const input = { operationId, serverId, primaryDomain: 'example.test', siteAdmin: { email: 'admin@example.test', password: 'fixture-only-password' } };
const operation = (ready = false) => ({ operationId, websiteId, ready, steps: [{ id: 'nginx', required: true, state: ready ? 'succeeded' : 'pending' }] });
const options = { requested: true, websiteId };
const preview = { operationId, ids: { websiteId, primaryDomainId: domainId }, hostname: { primaryDomain: input.primaryDomain }, previewDigest: 'a'.repeat(64), confirmation: `create-site:${operationId}:${'a'.repeat(64)}`, provisioning: operation() };
const created = { operationId, website: { id: websiteId, serverId }, primaryDomain: { id: domainId, websiteId, serverId, primaryDomain: input.primaryDomain }, provisioning: operation() };

test('only a successful outcome bound to the expected site shows account creation', () => {
  assert.deepEqual(siteAdminResult({ status: 'created', websiteId, code: null, password: 'private' }, options), { status: 'created', code: null });
  assert.equal(siteAdminResult({ status: 'created', websiteId: serverId, code: null }, options).status, 'attention');
});

for (const value of [null, undefined, {}, [], { status: 'not_requested', websiteId, code: null }, { status: 'created', websiteId, code: 'error' }, { status: 'attention', websiteId, code: '__proto__' }]) {
  test(`missing or malformed requested account outcome remains attention: ${JSON.stringify(value)}`, () => {
    const result = siteAdminResult(value, options);
    assert.deepEqual(result, { status: 'attention', code: 'site_admin_result_unverified' });
    assert.equal(typeof siteAdminMessage(result), 'string');
  });
}

test('unrequested account does not display unsolicited identities or success', () => {
  assert.deepEqual(siteAdminResult({ status: 'created', websiteId, code: null }, { requested: false, websiteId }), { status: 'not_requested', code: null });
});

test('bounded known error codes become local messages, not raw API text', () => {
  for (const code of ['site_admin_conflict', 'site_admin_input_invalid', 'site_admin_busy', 'site_admin_unavailable', 'site_admin_actor_unavailable', 'site_admin_replay_requires_review']) {
    const result = siteAdminResult({ status: 'attention', websiteId, code, message: 'private-password' }, options);
    assert.equal(result.code, code);
    assert.equal(siteAdminMessage(result).includes('private-password'), false);
    assert.equal(Object.isFrozen(result), true);
  }
  assert.equal(typeof siteAdminMessage({ code: '__proto__' }), 'string');
});

for (const final of ['ready', 'stopped', 'throw']) {
  test(`account warning survives ${final} provisioning and cannot trigger a second create`, async () => {
    let writes = 0; const states = [];
    const flow = createSiteSubmission({
      request: async (url) => {
        if (url.endsWith('create-preview')) return preview;
        writes++; return { ...created, siteAdmin: { status: 'attention', websiteId, code: 'site_admin_conflict' } };
      },
      advance: async (_id, { onStep }) => {
        if (final === 'throw') throw new Error('private');
        const result = operation(final === 'ready'); onStep({ operationId, operation: result }); return result;
      },
      onState: (value) => states.push(value),
    });
    const result = await flow.submit(input);
    assert.equal(result.created.id, domainId);
    assert.deepEqual(result.siteAdmin, { status: 'attention', code: 'site_admin_conflict' });
    // phase reports the host plan, not the separate account readiness.
    assert.equal(result.phase, final === 'ready' ? 'ready' : 'attention');
    await flow.submit(input); assert.equal(writes, 1);
    assert.ok(states.some((value) => value.phase === 'recorded' && value.siteAdmin.status === 'attention'));
    assert.equal(JSON.stringify(states).includes('fixture-only-password'), false);
  });
}

test('older API response preserves the created site while warning that the account is unverified', async () => {
  const flow = createSiteSubmission({ request: async (url) => url.endsWith('create-preview') ? preview : { ...created, provisioning: operation(true) }, advance: async () => { throw new Error('must not advance'); } });
  const result = await flow.submit(input);
  assert.equal(result.phase, 'ready'); assert.equal(result.created.id, domainId);
  assert.equal(result.siteAdmin.status, 'attention');
});

test('late response after scope disposal cannot publish the account or site', async () => {
  let resolve; const states = [];
  const flow = createSiteSubmission({ request: async (url) => url.endsWith('create-preview') ? preview : new Promise((done) => { resolve = done; }), advance: async () => operation(true), onState: (value) => states.push(value) });
  const pending = flow.submit(input); await new Promise(setImmediate); flow.dispose();
  const length = states.length;
  resolve({ ...created, siteAdmin: { status: 'created', websiteId, code: null } });
  await pending; assert.equal(states.length, length); assert.equal(flow.getState().created, null);
});

test('source wiring keeps account warning independent from host phase and retains existing navigation', async () => {
  const source = await readFile(new URL('../src/workspace/SiteCreateResult.jsx', import.meta.url), 'utf8');
  assert.match(source, /domain && state.siteAdmin && state.siteAdmin.status !== 'not_requested'/);
  assert.match(source, /siteAdminMessage\(state.siteAdmin\)/);
  assert.match(source, /to="\/settings\/users"/);
  assert.match(source, /siteHref\(domain.id, 'overview'\)/);
  assert.match(source, /siteHref\(domain.id, 'files'\)/);
  assert.doesNotMatch(source, /panelRequest|localStorage|sessionStorage/);
});
