import { assertUuid } from '@yunpanel/shared';

const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const FIELD_RANGES = Object.freeze([
  Object.freeze({ name: 'minute', min: 0, max: 59 }),
  Object.freeze({ name: 'hour', min: 0, max: 23 }),
  Object.freeze({ name: 'dayOfMonth', min: 1, max: 31 }),
  Object.freeze({ name: 'month', min: 1, max: 12 }),
  Object.freeze({ name: 'dayOfWeek', min: 0, max: 7 }),
]);

export class CronTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CronTemplateError';
    this.code = code;
  }
}

function boundedNumber(value, range) {
  if (!/^\d{1,2}$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= range.min && parsed <= range.max ? parsed : null;
}

function cronAtom(value, range) {
  const [base, stepText, ...extra] = value.split('/');
  if (extra.length > 0 || !base) return false;
  if (stepText !== undefined) {
    if (!/^\d{1,2}$/u.test(stepText)) return false;
    const step = Number.parseInt(stepText, 10);
    if (step < 1 || step > (range.max - range.min + 1)) return false;
  }
  if (base === '*') return true;
  if (base.includes('-')) {
    const parts = base.split('-');
    if (parts.length !== 2) return false;
    const left = boundedNumber(parts[0], range);
    const right = boundedNumber(parts[1], range);
    return left !== null && right !== null && left <= right;
  }
  return stepText === undefined && boundedNumber(base, range) !== null;
}

function cronField(value, range) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false;
  const atoms = value.split(',');
  return atoms.length >= 1 && atoms.length <= 32
    && atoms.every((atom) => cronAtom(atom, range));
}

export function normalizeCronSchedule(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n\u0000]/u.test(value)) {
    throw new CronTemplateError('cron_schedule_invalid', 'schedule must be a five-field cron expression');
  }
  const fields = value.trim().split(/\s+/u);
  if (fields.length !== FIELD_RANGES.length
    || fields.some((field, index) => !cronField(field, FIELD_RANGES[index]))) {
    throw new CronTemplateError(
      'cron_schedule_invalid',
      'schedule must be a valid numeric five-field cron expression',
    );
  }
  return fields.join(' ');
}

export function normalizeCronCommand(value) {
  if (typeof value !== 'string') {
    throw new CronTemplateError('cron_command_invalid', 'command must be a string');
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CronTemplateError(
      'cron_command_invalid',
      'command must be a printable string up to 4096 characters',
    );
  }
  return normalized;
}

function cronUser(value) {
  if (typeof value !== 'string' || !APP_USER_PATTERN.test(value)) {
    throw new CronTemplateError('cron_user_invalid', 'Cron user must be a managed Website Unix identity');
  }
  return value;
}

function escapeCronPercent(value) {
  let output = '';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      output += character;
      backslashes += 1;
      continue;
    }
    if (character === '%' && backslashes % 2 === 0) output += '\\';
    output += character;
    backslashes = 0;
  }
  return output;
}

export function cronTaskFileName(taskId) {
  return `yunpanel-${assertUuid(taskId, 'cronTaskId')}`;
}

export function renderCronTaskFile({
  taskId,
  user,
  schedule,
  command,
  enabled = true,
} = {}) {
  assertUuid(taskId, 'cronTaskId');
  const account = cronUser(user);
  const normalizedSchedule = normalizeCronSchedule(schedule);
  const normalizedCommand = normalizeCronCommand(command);
  if (typeof enabled !== 'boolean') {
    throw new CronTemplateError('cron_enabled_invalid', 'enabled must be a boolean');
  }
  const taskLine = `${normalizedSchedule} ${account} ${escapeCronPercent(normalizedCommand)}`;
  return [
    '# Managed by YunPanel. Manual edits are overwritten.',
    'SHELL=/bin/sh',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'MAILTO=""',
    enabled ? taskLine : `# disabled: ${taskLine}`,
    '',
  ].join('\n');
}

export const cronTemplateInternals = Object.freeze({
  appUserPattern: APP_USER_PATTERN,
  fieldRanges: FIELD_RANGES,
  cronAtom,
  cronField,
  escapeCronPercent,
});
