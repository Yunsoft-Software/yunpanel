import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProcessStoreLock } from './process-store-lock.js';
import { compileBackupSchedule } from './backup-schedule-time.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
function policy(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key => !['keepLast', 'keepDaily', 'keepWeekly', 'keepMonthly', 'keepYearly'].includes(key))
    || Object.values(value).some(count => !Number.isSafeInteger(count) || count < 1 || count > 1000)) throw fail('backup_schedule_retention_invalid', 'Saklama kuralları geçersiz');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

export function createWebsiteBackupScheduleRegistry({ filePath, now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw fail('backup_schedule_store_invalid', 'Kalıcı yedekleme zamanlama deposu gerekiyor');
  const lock = createProcessStoreLock({ filePath });
  async function read() {
    try {
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 8 * 1024 * 1024) throw fail('backup_schedule_store_invalid', 'Zamanlama deposu güvenli biçimde okunamadı');
      const state = JSON.parse(await readFile(filePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.schedules)) throw fail('backup_schedule_store_invalid', 'Zamanlama deposu geçersiz');
      const ids = new Set(), websites = new Set();
      for (const record of state.schedules) {
        if (![record.id, record.websiteId, record.serverId, record.repositoryId, record.creatorId].every(id => typeof id === 'string' && UUID.test(id))
          || record.creatorRole !== 'owner' || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.enabled !== 'boolean'
          || !Number.isSafeInteger(record.creatorRevision) || record.creatorRevision < 1 || !Number.isSafeInteger(record.creatorPasswordChangedAt) || record.creatorPasswordChangedAt < 0
          || ids.has(record.id) || websites.has(record.websiteId) || !Number.isFinite(Date.parse(record.nextRunAt))) throw fail('backup_schedule_store_invalid', 'Zamanlama kaydı geçersiz');
        compileBackupSchedule(record.expression, record.timeZone); ids.add(record.id); websites.add(record.websiteId);
        policy(record.retentionPolicy);
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, schedules: [] };
      if (error.code?.startsWith('backup_schedule_')) throw error;
      throw fail('backup_schedule_store_invalid', 'Zamanlama deposu okunamadı');
    }
  }
  async function write(state) {
    const parent = path.dirname(filePath); await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, filePath); }
    finally { await rm(temporary, { force: true }); }
  }
  async function getByWebsite(websiteId) { return lock.withLock(async () => structuredClone((await read()).schedules.find(record => record.websiteId === websiteId) ?? null)); }
  async function get(id) { return lock.withLock(async () => structuredClone((await read()).schedules.find(record => record.id === id) ?? null)); }
  async function list({ serverId = null, dueAt = null } = {}) {
    return lock.withLock(async () => structuredClone((await read()).schedules.filter(record => (!serverId || record.serverId === serverId)
      && (dueAt == null || (record.enabled && Date.parse(record.nextRunAt) <= new Date(dueAt).getTime())))));
  }
  async function save({ websiteId, serverId, repositoryId, creatorId, creatorRole, creatorRevision = 1, creatorPasswordChangedAt = 0, expression, timeZone = 'Europe/Istanbul', enabled = true, retentionPolicy = null }) {
    if (![websiteId, serverId, repositoryId, creatorId].every(id => typeof id === 'string' && UUID.test(id)) || creatorRole !== 'owner' || typeof enabled !== 'boolean'
      || !Number.isSafeInteger(creatorRevision) || creatorRevision < 1 || !Number.isSafeInteger(creatorPasswordChangedAt) || creatorPasswordChangedAt < 0) throw fail('backup_schedule_identity_invalid', 'Zamanlama sahibi ve hedefi doğrulanamadı');
    const schedule = compileBackupSchedule(expression, timeZone);
    const normalizedPolicy = policy(retentionPolicy);
    const nextRunAt = schedule.nextRun(now());
    return lock.withLock(async () => {
      const state = await read(), previous = state.schedules.find(record => record.websiteId === websiteId), timestamp = new Date(now()).toISOString();
      const record = { id: previous?.id ?? randomUUID(), websiteId, serverId, repositoryId, creatorId, creatorRole, creatorRevision, creatorPasswordChangedAt,
        expression: schedule.expression, timeZone: schedule.timeZone, enabled, revision: (previous?.revision ?? 0) + 1,
        retentionPolicy: normalizedPolicy,
        nextRunAt, lastRunAt: previous?.lastRunAt ?? null, lastOperationId: previous?.lastOperationId ?? null,
        error: null, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
      if (previous) state.schedules[state.schedules.indexOf(previous)] = record; else state.schedules.push(record);
      await write(state); return structuredClone(record);
    });
  }
  async function advance({ id, expectedRevision, expectedRunAt, operationId }) {
    return lock.withLock(async () => {
      const state = await read(), record = state.schedules.find(candidate => candidate.id === id);
      if (!record || record.revision !== expectedRevision || record.nextRunAt !== expectedRunAt || !UUID.test(operationId ?? '')) throw fail('backup_schedule_revision_conflict', 'Zamanlama değişti; aynı çalışma tekrar oluşturulmadı');
      record.lastRunAt = expectedRunAt; record.lastOperationId = operationId;
      record.nextRunAt = compileBackupSchedule(record.expression, record.timeZone).nextRun(Math.max(now(), Date.parse(expectedRunAt)));
      record.error = null; record.updatedAt = new Date(now()).toISOString();
      await write(state); return structuredClone(record);
    });
  }
  async function suspend({ id, expectedRevision, code }) {
    return lock.withLock(async () => {
      const state = await read(), record = state.schedules.find(candidate => candidate.id === id);
      if (!record || record.revision !== expectedRevision) throw fail('backup_schedule_revision_conflict', 'Zamanlama değişti');
      record.enabled = false; record.revision++; record.error = { code, message: 'Otomatik yedekleme erişim veya hedef kontrolü nedeniyle durduruldu' };
      record.updatedAt = new Date(now()).toISOString(); await write(state); return structuredClone(record);
    });
  }
  return Object.freeze({ get, getByWebsite, list, save, advance, suspend,
    getNextScheduledRun: async ({ websiteId }) => { const record = await getByWebsite(websiteId); return record?.enabled ? record.nextRunAt : null; } });
}
