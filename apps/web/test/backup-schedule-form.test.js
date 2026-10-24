import test from 'node:test';
import assert from 'node:assert/strict';
import { backupScheduleDraft, backupScheduleRequest, backupRetentionRequest } from '../src/workspace/backup-schedule-form.js';

test('existing daily, weekly and custom backup schedules reopen without changing the expression or time zone', () => {
  for (const expression of ['0 2 * * *', '35 23 * * 4', '*/15 * * * *', '0 5 1 * *']) {
    const schedule = { expression, timeZone: 'Europe/Berlin', enabled: false };
    assert.deepEqual(backupScheduleRequest(backupScheduleDraft(schedule)), schedule);
  }
});
test('invalid time, weekday and retention are rejected rather than silently reverting to defaults', () => {
  assert.throws(() => backupScheduleRequest({ ...backupScheduleDraft(null), time: '24:00' }));
  assert.throws(() => backupScheduleRequest({ ...backupScheduleDraft(null), frequency: 'weekly', weekday: '7' }));
  for (const keepLast of ['', '0', '8junk', '1.5', '101']) assert.throws(() => backupRetentionRequest({ keepLast, keepDaily: '7', keepWeekly: '4' }));
  assert.deepEqual(backupRetentionRequest({ keepLast: '8', keepDaily: '7', keepWeekly: '4' }), { keepLast: 8, keepDaily: 7, keepWeekly: 4 });
});
