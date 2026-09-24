import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCronAccess } from '../src/workspace/cron-task-access.js';
const domainId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const website = { id: '11111111-1111-4111-8111-111111111111', serverId: '22222222-2222-4222-8222-222222222222', applicationId: '33333333-3333-4333-8333-333333333333', unixUser: 'yunapp-123456789abc', runtimeType: 'node' };
const domain = { id: domainId, websiteId: website.id, serverId: website.serverId, primaryDomain: 'example.test' };
const input = () => ({ domainId, canManage: true, domains: { status: 'ready', items: [domain] }, websites: { status: 'ready', items: [website] } });
test('Domain URL resolves to explicit Website ID, never Domain ID', () => {
  const result = resolveCronAccess(input()); assert.equal(result.state, 'ready'); assert.equal(result.scope.websiteId, website.id); assert.notEqual(result.scope.websiteId, domainId);
});
for (const runtimeType of ['static', 'node', 'php']) {
  test(`supported service runtime ${runtimeType}`, () => {
    const value = input(); value.websites.items = [{ ...website, runtimeType }]; assert.equal(resolveCronAccess(value).state, 'ready');
  });
}
for (const runtimeType of ['python', 'docker', null]) {
  test(`unsupported service runtime ${runtimeType} stays visible`, () => {
    const value = input(); value.websites.items = [{ ...website, runtimeType }]; assert.equal(resolveCronAccess(value).state, 'unsupported');
  });
}
for (const status of ['loading', 'stale', 'error']) {
  test(`${status} inventory cannot initialize a cron client`, () => {
    const value = input(); value.domains.status = status; assert.equal(resolveCronAccess(value).state, 'unavailable');
  });
}
for (const status of ['unauthorized', 'forbidden']) {
  test(`${status} explicitly drops access`, () => {
    const value = input(); value.websites.status = status; assert.equal(resolveCronAccess(value).state, 'forbidden');
  });
}
test('management permission is required', () => assert.equal(resolveCronAccess({ ...input(), canManage: false }).state, 'forbidden'));
test('duplicate domain or Website is rejected', () => {
  for (const collection of ['domains', 'websites']) { const value = input(); value[collection].items.push(value[collection].items[0]); assert.equal(resolveCronAccess(value).state, 'not_found'); }
});
test('missing Website binding never falls back to application matching', () => {
  const value = input(); value.domains.items = [{ ...domain, websiteId: null }]; assert.equal(resolveCronAccess(value).state, 'unbound');
});
test('server and Unix binding mismatches are rejected', () => {
  for (const patch of [{ serverId: domainId }, { unixUser: 'root' }, { applicationId: null }]) {
    const value = input(); value.websites.items = [{ ...website, ...patch }]; assert.equal(resolveCronAccess(value).state, 'inconsistent');
  }
});
test('missing requested Website cannot fall back to another one', () => {
  const value = input(); value.websites.items = [{ ...website, id: domainId }]; assert.equal(resolveCronAccess(value).state, 'not_found');
});
