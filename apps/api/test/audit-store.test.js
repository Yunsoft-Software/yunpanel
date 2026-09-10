import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AuditStoreError, createAuditStore } from '../src/audit-store.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = Date.parse('2026-09-10T19:30:00.000Z');
  return {
    db,
    store: createAuditStore({ db, now: () => clock }),
    advance(milliseconds) { clock += milliseconds; },
  };
}

test('common audit store records only bounded actor resource outcome metadata', (t) => {
  const { store } = fixture(t);
  const event = store.record({
    actorId: 'owner-1',
    action: 'user.updated',
    resourceType: 'user',
    resourceId: 'user-2',
    outcome: 'succeeded',
    code: 'user_updated',
  });
  assert.deepEqual(event, {
    id: 1,
    actorId: 'owner-1',
    action: 'user.updated',
    resourceType: 'user',
    resourceId: 'user-2',
    outcome: 'succeeded',
    code: 'user_updated',
    createdAt: Date.parse('2026-09-10T19:30:00.000Z'),
  });
});

test('audit schema has no generic detail field and rejects secret-bearing extra metadata', (t) => {
  const { db, store } = fixture(t);
  const columns = db.prepare('PRAGMA table_info(audit_events)').all().map((row) => row.name);
  assert.deepEqual(columns, ['id', 'actor_id', 'action', 'resource_type', 'resource_id', 'outcome', 'code', 'created_at']);
  const jobColumns = db.prepare('PRAGMA table_info(audit_job_links)').all().map((row) => row.name);
  assert.deepEqual(jobColumns, ['job_id', 'actor_id', 'action', 'resource_type', 'resource_id', 'created_at']);

  for (const extra of [
    { password: 'secret-password' },
    { token: 'secret-token' },
    { environment: { API_KEY: 'secret' } },
    { details: 'raw command output' },
    { message: '/root/private/path' },
  ]) {
    assert.throws(
      () => store.record({ action: 'login.failed', outcome: 'failed', ...extra }),
      (error) => error instanceof AuditStoreError && error.code === 'invalid_audit_event',
    );
  }
  assert.equal(store.list().total, 0);
});

test('private job links are idempotent and never appear in public audit history before completion', (t) => {
  const { db, store } = fixture(t);
  const input = {
    jobId: 'job-1', actorId: 'owner-1', action: 'job.domain.stage', resourceType: 'domain', resourceId: 'domain-1',
  };
  const first = store.linkJob(input);
  const repeated = store.linkJob(input);
  assert.deepEqual(repeated, first);
  assert.equal(store.list().total, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM audit_job_links').get().count, 1);

  assert.throws(
    () => store.linkJob({ ...input, actorId: 'owner-2' }),
    (error) => error instanceof AuditStoreError && error.code === 'audit_job_link_conflict',
  );
});

test('job terminal outcome consumes the private link and records bounded actor result', (t) => {
  const { db, store } = fixture(t);
  store.linkJob({ jobId: 'job-1', actorId: 'owner-1', action: 'job.domain.activate', resourceType: 'domain', resourceId: 'domain-1' });
  const failed = store.recordJobOutcome({ jobId: 'job-1', outcome: 'failed', code: 'raw secret /root/path' });
  assert.deepEqual(
    { actorId: failed.actorId, action: failed.action, resourceType: failed.resourceType, resourceId: failed.resourceId, outcome: failed.outcome, code: failed.code },
    { actorId: 'owner-1', action: 'job.domain.activate', resourceType: 'domain', resourceId: 'domain-1', outcome: 'failed', code: 'job_failed' },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM audit_job_links').get().count, 0);
  assert.equal(store.recordJobOutcome({ jobId: 'job-1', outcome: 'failed' }), null);
});

test('succeeded and cancelled job outcomes never persist a failure code', (t) => {
  const { store } = fixture(t);
  for (const [jobId, outcome] of [['job-1', 'succeeded'], ['job-2', 'cancelled']]) {
    store.linkJob({ jobId, actorId: 'owner-1', action: 'job.application.deploy', resourceType: 'application', resourceId: 'app-1' });
    const event = store.recordJobOutcome({ jobId, outcome, code: 'must_not_persist' });
    assert.equal(event.outcome, outcome);
    assert.equal(event.code, null);
  }
});

test('resource and actor filters are exact and paginated', (t) => {
  const { store, advance } = fixture(t);
  store.record({ actorId: 'owner-1', action: 'job.accepted', resourceType: 'job', resourceId: 'job-1', outcome: 'accepted' });
  advance(1);
  store.record({ actorId: 'owner-2', action: 'job.accepted', resourceType: 'job', resourceId: 'job-2', outcome: 'accepted' });
  advance(1);
  store.record({ actorId: 'owner-1', action: 'job.cancelled', resourceType: 'job', resourceId: 'job-1', outcome: 'cancelled' });

  const actorPage = store.list({ actorId: 'owner-1', limit: 1 });
  assert.equal(actorPage.total, 2);
  assert.equal(actorPage.events.length, 1);
  assert.equal(actorPage.events[0].action, 'job.cancelled');

  const resourcePage = store.list({ resourceType: 'job', resourceId: 'job-1' });
  assert.equal(resourcePage.total, 2);
  assert.deepEqual(resourcePage.events.map((event) => event.action), ['job.cancelled', 'job.accepted']);
});

test('resource filters require a complete pair and tokens remain canonical', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.record({ action: 'x', outcome: 'succeeded', resourceType: 'user' }), { code: 'invalid_audit_event' });
  assert.throws(() => store.list({ resourceType: 'user' }), { code: 'invalid_audit_filter' });
  assert.throws(() => store.record({ action: 'UPPER', outcome: 'succeeded' }), { code: 'invalid_audit_event' });
  assert.throws(() => store.record({ action: 'ok', outcome: 'unknown' }), { code: 'invalid_audit_event' });
  assert.throws(() => store.linkJob({ jobId: 'job-1', actorId: 'owner-1', action: 'job.ok', resourceType: 'job' }), { code: 'invalid_audit_job_link' });
});

test('recording prunes audit rows older than ninety days', (t) => {
  const { db, store, advance } = fixture(t);
  store.record({ action: 'owner.setup', outcome: 'succeeded' });
  store.linkJob({ jobId: 'old-job', actorId: 'owner-1', action: 'job.domain.stage', resourceType: 'domain', resourceId: 'domain-1' });
  advance(91 * 24 * 60 * 60_000);
  store.record({ action: 'login.succeeded', outcome: 'succeeded' });
  store.linkJob({ jobId: 'new-job', actorId: 'owner-1', action: 'job.domain.stage', resourceType: 'domain', resourceId: 'domain-1' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM audit_events').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM audit_job_links').get().count, 1);
  assert.equal(store.list().events[0].action, 'login.succeeded');
});

test('unknown audit schema version fails closed', (t) => {
  const { db } = fixture(t);
  db.exec('UPDATE audit_schema SET version = 99');
  assert.throws(
    () => createAuditStore({ db }),
    (error) => error instanceof AuditStoreError && error.code === 'unsupported_audit_schema',
  );
});
