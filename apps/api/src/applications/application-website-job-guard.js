import { OPERATIONS } from '@yunpanel/protocol';
import { ApplicationRegistryError } from './application-registry.js';

export async function assertApplicationWebsiteIdle({ applicationId, websiteRegistry, jobRegistry, serverId = null }) {
  if (!websiteRegistry || !jobRegistry) return;
  let websites, jobs;
  try {
    websites = await websiteRegistry.listWebsites({ serverId });
    jobs = await jobRegistry.listJobs(serverId ? { serverId } : {});
  } catch { throw new ApplicationRegistryError('application_website_job_state_unavailable', 'Site işlem kilidi doğrulanamadı', 503); }
  if (!Array.isArray(websites)) throw new ApplicationRegistryError('application_website_job_state_unavailable', 'Site işlem kilidi doğrulanamadı', 503);
  const owned = new Set(websites.filter(site => site.applicationId === applicationId).map(site => site.id));
  if (!Array.isArray(jobs) || jobs.some(job => ['queued', 'running'].includes(job.status)
    && (owned.has(job.resourceType === 'website' ? job.resourceId : job.payload?.websiteId)
      || job.operation === OPERATIONS.WEBSITE_BACKUP_ACTION && job.payload?.applicationId === applicationId))) {
    throw new ApplicationRegistryError('application_website_job_conflict', 'Site işlemi bitene kadar uygulama değiştirilemez', 409);
  }
}
