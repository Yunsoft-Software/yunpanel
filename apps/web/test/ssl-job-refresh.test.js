import assert from 'node:assert/strict';
import test from 'node:test';
import { createSslJobRefresh } from '../src/workspace/ssl-job-refresh.js';
const job = (status = 'queued', patch = {}) => ({ id: 'job-a', operation: 'ssl.renew', resourceType: 'certificate',
  resourceId: 'certificate-a', serverId: 'server-a', status, ...patch });
for (const status of ['succeeded', 'failed', 'cancelled']) {
  test(`${status} refreshes once independently of the drawer`, () => {
    const update = createSslJobRefresh();
    assert.equal(update([job()]), false); assert.equal(update([job('running')]), false);
    assert.equal(update([job(status)]), true); assert.equal(update([job(status)]), false);
    assert.equal(update([job('running')]), false); assert.equal(update([job(status)]), false);
  });
}
test('an already completed tracked job invalidates once, not on every poll', () => {
  const update = createSslJobRefresh();
  assert.equal(update([job('succeeded')]), true); assert.equal(update([job('succeeded')]), false);
});
test('issuance and renewal both invalidate dependent inventories but unrelated jobs do not', () => {
  const update = createSslJobRefresh();
  assert.equal(update([job('succeeded', { operation: 'ssl.issue' })]), true);
  assert.equal(update([job('succeeded', { id: 'job-b', operation: 'domain.stage', resourceType: 'domain' })]), false);
});
test('same-ID certificate or server substitution does not produce a new terminal event', () => {
  const update = createSslJobRefresh(); update([job()]);
  assert.equal(update([job('succeeded', { resourceId: 'other' })]), false);
  assert.equal(update([job('succeeded', { serverId: 'other' })]), false);
  assert.equal(update([job('succeeded')]), true);
});
test('new job ID is a new event and dropping tracked jobs releases deduplication state', () => {
  const update = createSslJobRefresh(); assert.equal(update([job('succeeded')]), true);
  assert.equal(update([job('succeeded'), job('succeeded', { id: 'job-b' })]), true);
  assert.equal(update([]), false); assert.equal(update([job('succeeded')]), true);
});
test('malformed status, identity or resource type cannot trigger refresh', () => {
  for (const patch of [{ id: '' }, { status: 'unknown' }, { resourceId: null }, { serverId: null }, { resourceType: 'domain' }]) {
    assert.equal(createSslJobRefresh()([job('succeeded', patch)]), false);
  }
});
