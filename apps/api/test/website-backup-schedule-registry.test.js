import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebsiteBackupScheduleRegistry } from '../src/website-backup-schedule-registry.js';
import { normalizeWebsiteBackupScheduleAuthorization } from '../src/website-backup-schedule-authorization.js';

const websiteId = '11111111-1111-4111-8111-111111111111', serverId = '22222222-2222-4222-8222-222222222222';
const repositoryId = '33333333-3333-4333-8333-333333333333', creatorId = '44444444-4444-4444-8444-444444444444';
const operationId = '55555555-5555-4555-8555-555555555555';
const input = { websiteId, serverId, repositoryId, creatorId, creatorRole: 'owner', expression: '0 2 * * *', timeZone: 'Europe/Istanbul' };

test('backup schedule is private and durable; advancing one due slot cannot be repeated after reopening', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-backup-schedule-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'schedules.json'), now = () => Date.parse('2026-10-09T20:00:00Z');
  const first = createWebsiteBackupScheduleRegistry({ filePath, now });
  const saved = await first.save(input); assert.equal(saved.nextRunAt, '2026-10-09T23:00:00.000Z');
  assert.equal((await lstat(filePath)).mode & 0o777, 0o600); assert.notEqual(saved.id, websiteId);
  const reopened = createWebsiteBackupScheduleRegistry({ filePath, now });
  assert.equal((await reopened.getByWebsite(websiteId)).id, saved.id);
  assert.equal((await reopened.list({ serverId, dueAt: '2026-10-09T23:00:00Z' })).length, 1);
  await reopened.advance({ id: saved.id, expectedRevision: 1, expectedRunAt: saved.nextRunAt, operationId });
  assert.equal((await reopened.get(saved.id)).nextRunAt, '2026-10-10T23:00:00.000Z');
  await assert.rejects(first.advance({ id: saved.id, expectedRevision: 1, expectedRunAt: saved.nextRunAt, operationId }), error => error.code === 'backup_schedule_revision_conflict');
  const changed = await first.save({ ...input, expression: '0 3 * * *' }); assert.equal(changed.id, saved.id); assert.equal(changed.revision, 2);
  await first.suspend({ id: changed.id, expectedRevision: 2, code: 'actor_revoked' });
  assert.equal((await first.get(changed.id)).enabled, false);
  assert.equal((await first.list({ dueAt: '2026-10-12T00:00:00Z' })).length, 0);
});
test('corrupt schedule store and user-supplied session substitution fail closed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-backup-schedule-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'schedules.json'), store = createWebsiteBackupScheduleRegistry({ filePath });
  await store.save(input); const state = JSON.parse(await readFile(filePath, 'utf8')); state.schedules[0].creatorRole = 'customer'; await writeFile(filePath, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(store.list(), error => error.code === 'backup_schedule_store_invalid');
  const grant = { kind: 'website_backup_schedule', scheduleId: operationId, scheduleRevision: 1, websiteId, serverId, userId: creatorId, actorId: creatorId, role: 'owner' };
  assert.deepEqual(normalizeWebsiteBackupScheduleAuthorization(grant), grant);
  assert.throws(() => normalizeWebsiteBackupScheduleAuthorization({ ...grant, sessionId: 'invented-session' }), error => error.code === 'website_backup_schedule_authorization_invalid');
});
