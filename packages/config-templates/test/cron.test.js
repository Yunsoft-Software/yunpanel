import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CronTemplateError,
  cronTaskFileName,
  cronTemplateInternals,
  normalizeCronCommand,
  normalizeCronSchedule,
  renderCronTaskFile,
} from '../src/index.js';

const taskId = '07b0be89-f855-4c61-8132-3a73eb39888b';

test('normalizes bounded numeric five-field cron schedules', () => {
  assert.equal(normalizeCronSchedule('*/5   0-23/2 * 1,6,12 0-5'), '*/5 0-23/2 * 1,6,12 0-5');
  assert.equal(normalizeCronSchedule('0 0 1 1 7'), '0 0 1 1 7');

  for (const value of [
    '* * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '*/0 * * * *',
    '5-2 * * * *',
    'JAN * * * *',
  ]) {
    assert.throws(
      () => normalizeCronSchedule(value),
      (error) => error instanceof CronTemplateError && error.code === 'cron_schedule_invalid',
    );
  }
});

test('renders a root-managed cron.d entry for the exact Website Unix user', () => {
  const rendered = renderCronTaskFile({
    taskId,
    user: 'yunapp-0123456789ab',
    schedule: '15 2 * * 1-5',
    command: 'php artisan reports:daily --format=%Y-%m-%d',
  });

  assert.equal(cronTaskFileName(taskId), `yunpanel-${taskId}`);
  assert.equal(rendered, [
    '# Managed by YunPanel. Manual edits are overwritten.',
    'SHELL=/bin/sh',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'MAILTO=""',
    '15 2 * * 1-5 yunapp-0123456789ab php artisan reports:daily --format=\\%Y-\\%m-\\%d',
    '',
  ].join('\n'));
});

test('preserves already escaped cron percent characters and comments disabled tasks', () => {
  assert.equal(cronTemplateInternals.escapeCronPercent('echo \\%F %T'), 'echo \\%F \\%T');
  const rendered = renderCronTaskFile({
    taskId,
    user: 'yunapp-0123456789ab',
    schedule: '0 * * * *',
    command: 'node worker.js',
    enabled: false,
  });
  assert.match(rendered, /# disabled: 0 \* \* \* \* yunapp-0123456789ab node worker\.js/);
});

test('rejects control characters, invalid Website users and invalid task identities', () => {
  assert.equal(normalizeCronCommand(' node worker.js '), 'node worker.js');
  assert.throws(
    () => normalizeCronCommand('echo ok\necho no'),
    (error) => error instanceof CronTemplateError && error.code === 'cron_command_invalid',
  );
  assert.throws(
    () => renderCronTaskFile({
      taskId,
      user: 'root',
      schedule: '* * * * *',
      command: 'echo no',
    }),
    (error) => error instanceof CronTemplateError && error.code === 'cron_user_invalid',
  );
  assert.throws(() => cronTaskFileName('not-a-uuid'));
});
