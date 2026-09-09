import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionReducer, initialCollection, knownCount } from '../src/workspace/resource-model.js';
import { certificateState, externalSiteUrl, matchingApplications, selectedApplication, parentTrail, siteJobs, jobFromResponse, formatBytes, siteHref } from '../src/workspace/site-model.js';
const domain = { id: 'domain', serverId: 'local', primaryDomain: 'example.com', targetType: 'proxy', target: { upstreamPort: 4301 }, certificateId: 'cert', httpsMode: 'managed' };

test('unknown counts are not falsely rendered as zero', () => {
  assert.equal(knownCount(initialCollection()), null);
  assert.equal(knownCount(collectionReducer(initialCollection(), { type: 'success', items: [] })), 0);
});
test('404 is unavailable API, never an authentication label', () => {
  const state = collectionReducer(initialCollection(), { type: 'failure', error: { status: 404 } });
  assert.equal(state.status, 'unsupported');
});
test('network failures preserve known data but access revocation clears it', () => {
  const ready = collectionReducer(initialCollection(), { type: 'success', items: [domain], now: 1 });
  assert.equal(collectionReducer(ready, { type: 'failure', error: new TypeError() }).status, 'stale');
  for (const status of [401, 403]) assert.deepEqual(collectionReducer(ready, { type: 'failure', error: { status } }).items, []);
  assert.equal(collectionReducer(ready, { type: 'failure', error: { name: 'AbortError' } }), ready);
});
test('a malformed success payload cannot silently become empty data', () => {
  const ready = collectionReducer(initialCollection(), { type: 'success', items: [domain] });
  const next = collectionReducer(ready, { type: 'success', items: {} });
  assert.equal(next.status, 'stale'); assert.deepEqual(next.items, [domain]);
});
test('SSL distinguishes unavailable, requested, staging, missing validity and expiry', () => {
  assert.equal(certificateState(domain, null).state, 'unknown');
  assert.equal(certificateState(domain, []).state, 'pending');
  assert.equal(certificateState(domain, [{ id: 'cert', state: 'active', staging: true }]).state, 'staging');
  assert.equal(certificateState(domain, [{ id: 'cert', state: 'active' }]).state, 'unknown');
  assert.equal(certificateState(domain, [{ id: 'cert', state: 'active', validTo: '2020-01-01' }], Date.parse('2026-09-09')).state, 'expired');
});
test('application matching never crosses servers or silently selects ambiguous records', () => {
  const app = { id: 'app', serverId: 'local', type: 'node', runtime: { port: 4301 } };
  const remote = { ...app, id: 'remote', serverId: 'remote' };
  const second = { ...app, id: 'second' };
  assert.deepEqual(matchingApplications(domain, [app, remote]), [app]);
  assert.equal(selectedApplication(domain, [app, second]), null);
  assert.equal(selectedApplication(domain, [app, remote], 'remote'), null);
  assert.equal(selectedApplication(domain, [app, second], 'second'), second);
  assert.equal(selectedApplication(domain, [app]), app);
});
test('static targets are not guessed into an application relationship', () => {
  assert.deepEqual(matchingApplications({ ...domain, targetType: 'static' }, [{ serverId: 'local', type: 'static' }]), []);
});
test('breadcrumb cycles terminate without guessing suffix parentage', () => {
  const parent = { id: 'parent', parentDomainId: 'domain', primaryDomain: 'parent.test' };
  assert.deepEqual(parentTrail({ ...domain, parentDomainId: 'parent' }, [domain, parent]), [parent]);
  assert.deepEqual(parentTrail(domain, [parent]), []);
});
test('site jobs are resource scoped, not every job on the same server', () => {
  const selected = { id: 'app' };
  const own = { id: 'own', serverId: 'local', resourceType: 'application', resourceId: 'app' };
  const other = { ...own, id: 'other', resourceId: 'not-this-app' };
  assert.deepEqual(siteJobs(domain, selected, [own, other]), [own]);
});
test('queued job acceptance is distinct from completed success', () => {
  const job = { id: 'job', status: 'queued' };
  assert.equal(jobFromResponse({ job }).status, 'queued');
  for (const value of [null, { id: 'job' }, { job: {} }]) assert.throws(() => jobFromResponse(value));
});
test('external links cannot introduce script schemes, credentials or arbitrary paths', () => {
  assert.equal(externalSiteUrl(domain), 'https://example.com/');
  for (const primaryDomain of ['javascript:alert(1)', 'evil.test/@example.com', 'x.test#fragment', 'a@b.test']) assert.equal(externalSiteUrl({ ...domain, primaryDomain }), null);
});
test('resource URLs encode IDs and byte formatting preserves missing data', () => {
  assert.equal(siteHref('a/b'), '/websites/a%2Fb/overview');
  assert.equal(formatBytes(null), '—'); assert.equal(formatBytes(0), '0 B');
});
