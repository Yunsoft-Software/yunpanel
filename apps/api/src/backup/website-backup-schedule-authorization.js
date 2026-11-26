const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function normalizeWebsiteBackupScheduleAuthorization(value) {
  const fields = ['kind', 'scheduleId', 'scheduleRevision', 'websiteId', 'serverId', 'userId', 'actorId', 'role'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(field => !fields.includes(field)) || value.kind !== 'website_backup_schedule'
    || !['scheduleId', 'websiteId', 'serverId', 'userId'].every(field => typeof value[field] === 'string' && UUID.test(value[field]))
    || value.actorId !== value.userId || value.role !== 'owner' || !Number.isSafeInteger(value.scheduleRevision) || value.scheduleRevision < 1) {
    throw Object.assign(new Error('Scheduled backup authorization is invalid'), { code: 'website_backup_schedule_authorization_invalid', status: 403 });
  }
  return Object.freeze(Object.fromEntries(fields.map(field => [field, value[field]])));
}
