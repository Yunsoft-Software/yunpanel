import { OPERATIONS } from '@yunpanel/protocol';

const DEFAULT_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function runCertificateRenewalSweep({
  certificateRegistry,
  jobRegistry,
  now = () => Date.now(),
  renewBeforeMs = DEFAULT_RENEW_BEFORE_MS,
} = {}) {
  if (!certificateRegistry || !jobRegistry) throw new Error('certificateRegistry and jobRegistry are required');
  if (!Number.isInteger(renewBeforeMs) || renewBeforeMs < 24 * 60 * 60 * 1000) {
    throw new Error('renewBeforeMs must be at least one day');
  }

  const currentTime = now();
  const threshold = currentTime + renewBeforeMs;
  const certificates = await certificateRegistry.listCertificates();
  const queued = [];

  for (const certificate of certificates) {
    if (certificate.state !== 'active' || certificate.staging || certificate.renewalMode !== 'automatic' || !certificate.validTo) continue;
    const expiresAt = Date.parse(certificate.validTo);
    if (!Number.isFinite(expiresAt) || expiresAt > threshold) continue;

    const existingJobs = await jobRegistry.listJobs({
      resourceType: 'certificate',
      resourceId: certificate.id,
    });
    if (existingJobs.some((job) => (
      job.operation === OPERATIONS.SSL_RENEW
      && (job.status === 'queued' || job.status === 'running')
    ))) continue;

    const job = await jobRegistry.enqueue({
      serverId: certificate.serverId,
      type: 'ssl.renew',
      operation: OPERATIONS.SSL_RENEW,
      payload: { certName: certificate.certName, dryRun: false },
      resourceType: 'certificate',
      resourceId: certificate.id,
    });
    await certificateRegistry.setState(certificate.id, 'renewing');
    queued.push(job);
  }

  return queued;
}

export function startCertificateRenewalScheduler({
  certificateRegistry,
  jobRegistry,
  intervalMs = DEFAULT_INTERVAL_MS,
  renewBeforeMs = DEFAULT_RENEW_BEFORE_MS,
  logger = console,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5 * 60 * 1000) {
    throw new Error('Certificate renewal interval must be at least five minutes');
  }

  let stopped = false;
  let running = false;

  async function sweep() {
    if (stopped || running) return [];
    running = true;
    try {
      const jobs = await runCertificateRenewalSweep({ certificateRegistry, jobRegistry, renewBeforeMs });
      if (jobs.length > 0) logger.info(`[yunpanel-api] queued ${jobs.length} certificate renewal job(s)`);
      return jobs;
    } catch (error) {
      logger.error(`[yunpanel-api] certificate renewal sweep failed: ${error.code ?? error.message}`);
      return [];
    } finally {
      running = false;
    }
  }

  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();

  return {
    sweepNow: sweep,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
