export function backupScheduleDraft(schedule) {
  const expression = schedule?.expression ?? '0 2 * * *';
  const parts = expression.trim().split(/\s+/);
  const regular = parts.length === 5 && /^(\d|[1-5]\d)$/.test(parts[0]) && /^(\d|1\d|2[0-3])$/.test(parts[1]) && parts[2] === '*' && parts[3] === '*';
  const frequency = regular && parts[4] === '*' ? 'daily' : regular && /^[0-6]$/.test(parts[4]) ? 'weekly' : 'custom';
  return { enabled: schedule?.enabled ?? true, frequency, time: regular ? `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}` : '02:00',
    weekday: frequency === 'weekly' ? parts[4] : '1', expression, timeZone: schedule?.timeZone ?? 'Europe/Istanbul' };
}

export function backupScheduleRequest(draft) {
  if (!draft || typeof draft.enabled !== 'boolean') throw new Error('Otomatik yedekleme tercihini kontrol edin.');
  let expression = draft.expression;
  if (['daily', 'weekly'].includes(draft.frequency)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) || (draft.frequency === 'weekly' && !/^[0-6]$/.test(draft.weekday))) throw new Error('Yedekleme saatini ve gününü kontrol edin.');
    const [hour, minute] = draft.time.split(':').map(Number);
    expression = `${minute} ${hour} * * ${draft.frequency === 'weekly' ? draft.weekday : '*'}`;
  } else if (draft.frequency !== 'custom' || typeof expression !== 'string' || !expression.trim()) throw new Error('Özel zamanlama boş bırakılamaz.');
  return { expression, timeZone: draft.timeZone, enabled: draft.enabled };
}

export function backupRetentionRequest(values) {
  const policy = {};
  for (const key of ['keepLast', 'keepDaily', 'keepWeekly']) {
    const text = String(values[key]);
    if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 100) throw new Error('Saklanacak yedek sayıları 1 ile 100 arasında olmalı.');
    policy[key] = Number(text);
  }
  return policy;
}
