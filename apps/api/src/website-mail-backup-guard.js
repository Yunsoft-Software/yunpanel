import { OPERATIONS } from '@yunpanel/protocol';

export function createWebsiteMailBackupGuard({ jobRegistry, localServerId }) {
  return async (request, response, next) => {
    try {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
        || !/^\/api\/(?:mail|roundcube|servers\/[^/]+\/mail)/.test(request.path)) return next();
      const jobs = await jobRegistry.listJobs({ serverId: localServerId });
      if (!Array.isArray(jobs) || jobs.some(job => (job.operation === OPERATIONS.WEBSITE_BACKUP_ACTION
        || job.operation === OPERATIONS.WEBSITE_PHP_ACTION && job.payload?.actionId === 'wp.toolkit')
        && ['queued', 'running'].includes(job.status))) {
        return next(Object.assign(new Error('Site yedekleme veya geri yükleme işlemi bitene kadar posta değiştirilemez'), {
          code: 'website_mail_backup_job_conflict', status: 409,
        }));
      }
      return next();
    } catch { return next(Object.assign(new Error('Posta işlem kilidi doğrulanamadı'), { code: 'website_mail_backup_state_unavailable', status: 503 })); }
  };
}
