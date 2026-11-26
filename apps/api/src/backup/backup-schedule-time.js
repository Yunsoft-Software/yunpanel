import { normalizeCronSchedule } from '@yunpanel/config-templates';

const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const invalid = () => Object.assign(new Error('Yedekleme zamanlaması veya saat dilimi geçersiz'), { code: 'backup_schedule_invalid', status: 400 });

function numbers(field, [minimum, maximum]) {
  const values = new Set();
  for (const atom of field.split(',')) {
    const [base, stepValue] = atom.split('/'), step = Number(stepValue ?? 1);
    const [first, last] = base === '*' ? [minimum, maximum] : base.includes('-') ? base.split('-').map(Number) : [Number(base), Number(base)];
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return values;
}

export function compileBackupSchedule(expression, timeZone = 'Europe/Istanbul') {
  let normalized, formatter;
  try {
    normalized = normalizeCronSchedule(expression);
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatter.format(new Date());
  } catch { throw invalid(); }
  const fields = normalized.split(' '), sets = fields.map((field, index) => numbers(field, ranges[index]));
  function matches(value) {
    const date = new Date(value); if (!Number.isFinite(date.getTime())) throw invalid();
    const parts = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const dayOfWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    if (!sets[0].has(parts.minute) || !sets[1].has(parts.hour) || !sets[3].has(parts.month)) return false;
    const dom = sets[2].has(parts.day), dow = sets[4].has(dayOfWeek) || (dayOfWeek === 0 && sets[4].has(7));
    // Traditional cron combines two restricted day fields with OR.
    return fields[2].startsWith('*') || fields[4].startsWith('*') ? dom && dow : dom || dow;
  }
  function nextRun(after) {
    const time = new Date(after).getTime(); if (!Number.isFinite(time)) throw invalid();
    let candidate = Math.floor(time / 60_000) * 60_000 + 60_000;
    for (let count = 0; count < 366 * 24 * 60; count++, candidate += 60_000) if (matches(candidate)) return new Date(candidate).toISOString();
    throw Object.assign(new Error('Bir yıl içinde geçerli çalışma zamanı bulunamadı'), { code: 'backup_schedule_no_occurrence', status: 400 });
  }
  return Object.freeze({ expression: normalized, timeZone: formatter.resolvedOptions().timeZone, matches, nextRun });
}
