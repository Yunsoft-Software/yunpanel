import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBackupSchedule } from '../src/backup-schedule-time.js';

test('backup daily preset follows the selected IANA timezone and advances after the current minute', () => {
  const schedule = compileBackupSchedule('0 2 * * *', 'Europe/Istanbul');
  assert.equal(schedule.nextRun('2026-10-09T20:00:00Z'), '2026-10-09T23:00:00.000Z');
  assert.equal(schedule.matches('2026-10-09T23:00:00Z'), true);
  assert.equal(schedule.matches('2026-10-09T02:00:00Z'), false);
  assert.equal(schedule.nextRun('2026-10-09T23:00:00Z'), '2026-10-10T23:00:00.000Z');
});
test('cron ranges, lists and steps work, including both Sunday forms', () => {
  const schedule = compileBackupSchedule('*/15 9-17 * * 1,3,5', 'UTC');
  assert.equal(schedule.matches('2026-10-09T09:15:00Z'), true);
  assert.equal(schedule.matches('2026-10-10T09:15:00Z'), false);
  assert.equal(schedule.matches('2026-10-09T18:15:00Z'), false);
  for (const day of ['0', '7']) assert.equal(compileBackupSchedule(`0 2 * * ${day}`, 'UTC').matches('2026-10-11T02:00:00Z'), true);
});
test('restricted day-of-month and day-of-week use native cron OR semantics', () => {
  const schedule = compileBackupSchedule('0 2 15 * 1', 'UTC');
  assert.equal(schedule.matches('2026-10-12T02:00:00Z'), true);
  assert.equal(schedule.matches('2026-10-15T02:00:00Z'), true);
  assert.equal(schedule.matches('2026-10-16T02:00:00Z'), false);
});
test('a DST gap does not invent a local time that never occurs', () => {
  const schedule = compileBackupSchedule('30 2 * * *', 'Europe/Berlin');
  assert.equal(schedule.nextRun('2026-03-29T00:00:00Z'), '2026-03-30T00:30:00.000Z');
});
test('invalid schedules, unknown timezones and invalid clocks cannot become a saved plan', () => {
  for (const expression of ['* * * *', '60 2 * * *', '0 2 * * *\nrm -rf /', '@reboot']) assert.throws(() => compileBackupSchedule(expression), error => error.code === 'backup_schedule_invalid');
  assert.throws(() => compileBackupSchedule('0 2 * * *', 'Invalid/Zone'), error => error.code === 'backup_schedule_invalid');
  assert.throws(() => compileBackupSchedule('0 2 * * *').nextRun('invalid'), error => error.code === 'backup_schedule_invalid');
});
