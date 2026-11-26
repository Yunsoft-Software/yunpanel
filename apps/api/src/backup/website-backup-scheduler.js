import { createHash } from 'node:crypto';

export function backupScheduleOperationId(schedule) {
  const value = createHash('sha256').update(`${schedule.id}:${schedule.revision}:${schedule.nextRunAt}`).digest('hex').slice(0, 32).split('');
  value[12] = '4'; value[16] = '8';
  const hex = value.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createWebsiteBackupScheduler({ scheduleRegistry, operationService, authorizeSchedule, serverId,
  now = Date.now, onError = () => {}, intervalMs = 60_000,
} = {}) {
  if (![scheduleRegistry?.list, scheduleRegistry?.advance, scheduleRegistry?.suspend, operationService?.queueScheduled, authorizeSchedule].every(value => typeof value === 'function')) throw new TypeError('Backup scheduler dependencies are invalid');
  let running = null, timer = null, stopped = true;
  async function sweep() {
    if (running) return running;
    running = (async () => {
      const due = await scheduleRegistry.list({ serverId, dueAt: now() });
      const outcomes = [];
      for (const schedule of due) {
        const grant = { kind: 'website_backup_schedule', scheduleId: schedule.id, scheduleRevision: schedule.revision, websiteId: schedule.websiteId,
          serverId: schedule.serverId, userId: schedule.creatorId, actorId: schedule.creatorId, role: schedule.creatorRole };
        if (await authorizeSchedule(grant) !== true) {
          await scheduleRegistry.suspend({ id: schedule.id, expectedRevision: schedule.revision, code: 'backup_schedule_actor_revoked' });
          outcomes.push({ scheduleId: schedule.id, status: 'suspended' }); continue;
        }
        try {
          const operation = await operationService.queueScheduled(schedule, backupScheduleOperationId(schedule));
          // Advance only after the operation is linked to an actual durable job.
          if (!operation?.jobId) throw Object.assign(new Error('Scheduled operation has no durable job'), { code: 'backup_schedule_enqueue_unverified' });
          await scheduleRegistry.advance({ id: schedule.id, expectedRevision: schedule.revision, expectedRunAt: schedule.nextRunAt, operationId: operation.id });
          outcomes.push({ scheduleId: schedule.id, operationId: operation.id, status: 'queued' });
        } catch (error) {
          if (['website_backup_operation_conflict', 'website_job_conflict', 'site_mutation_locked', 'process_store_locked', 'backup_schedule_revision_conflict'].includes(error.code)) {
            outcomes.push({ scheduleId: schedule.id, status: 'waiting' }); continue;
          }
          if (['website_backup_schedule_actor_forbidden', 'website_backup_target_invalid'].includes(error.code)) await scheduleRegistry.suspend({ id: schedule.id, expectedRevision: schedule.revision, code: error.code });
          try { onError({ code: error.code ?? 'backup_schedule_failed', scheduleId: schedule.id }); } catch {}
          outcomes.push({ scheduleId: schedule.id, status: 'failed', code: error.code ?? 'backup_schedule_failed' });
        }
      }
      return outcomes;
    })().finally(() => { running = null; });
    return running;
  }
  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try { await sweep(); } catch { try { onError({ code: 'backup_schedule_store_unavailable' }); } catch {} }
      finally { schedule(); }
    }, intervalMs);
    timer.unref?.();
  }
  function start() { if (!stopped) return; stopped = false; schedule(); }
  async function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; if (running) await running; }
  return Object.freeze({ sweep, start, stop, status: () => ({ active: !stopped, running: Boolean(running) }) });
}
