import { OPERATIONS } from '@yunpanel/protocol';
import { compareTlsPresentation } from './certificate-registry.js';

const DEFAULT_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function verifyRenewalOutcome({ certificate, before = null, job, liveTls = null, dryRun = false }) {
  if (!job || typeof job !== 'object') {
    throw new Error('job is required');
  }
  if (!certificate || typeof certificate !== 'object') {
    throw new Error('certificate is required');
  }

  if (job.status !== 'succeeded') {
    return Object.freeze({
      outcome: job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'cancelled' : 'job_not_terminal',
      status: job.status,
      verified: false,
      error: job.error?.message ?? job.error ?? null,
    });
  }

  if (!job.result || typeof job.result !== 'object') {
    return Object.freeze({
      outcome: 'unverified',
      reason: 'job_result_missing',
      verified: false,
    });
  }

  if (dryRun) {
    if (job.result.status === 'validated' && certificate.state === 'active') {
      return Object.freeze({
        outcome: 'tested',
        dryRun: true,
        verified: true,
      });
    }
    return Object.freeze({
      outcome: 'syncing',
      dryRun: true,
      verified: false,
    });
  }

  if (job.result.status !== 'renewed') {
    return Object.freeze({
      outcome: 'unverified',
      reason: 'job_status_not_renewed',
      verified: false,
    });
  }

  // Check persistent state synchronization
  const resultFingerprint = typeof job.result.fingerprint256 === 'string'
    ? job.result.fingerprint256.toUpperCase()
    : null;
  const certFingerprint = typeof certificate.fingerprint256 === 'string'
    ? certificate.fingerprint256.toUpperCase()
    : null;

  if (
    certificate.state !== 'active'
    || !certFingerprint
    || certFingerprint !== resultFingerprint
    || Date.parse(certificate.validTo) !== Date.parse(job.result.validTo)
    || Date.parse(certificate.validFrom) !== Date.parse(job.result.validFrom)
  ) {
    return Object.freeze({
      outcome: 'syncing',
      reason: 'persistent_state_not_synchronized',
      verified: false,
    });
  }

  // Check if renewal resulted in unchanged certificate
  if (before && typeof before === 'object' && before.fingerprint256) {
    const beforeFingerprint = before.fingerprint256.toUpperCase();
    if (beforeFingerprint === certFingerprint) {
      if (liveTls) {
        const liveMatch = compareTlsPresentation(certificate, liveTls);
        return Object.freeze({
          outcome: 'unchanged',
          verified: liveMatch.matches,
          liveMatches: liveMatch.matches,
          fingerprint256: certFingerprint,
          validFrom: certificate.validFrom,
          validTo: certificate.validTo,
        });
      }
      return Object.freeze({
        outcome: 'unchanged',
        verified: true,
        fingerprint256: certFingerprint,
        validFrom: certificate.validFrom,
        validTo: certificate.validTo,
      });
    }
  }

  // Renewal resulted in a new certificate material: verify live TLS presentation
  if (!liveTls) {
    return Object.freeze({
      outcome: 'pending_live_tls_verification',
      reason: 'live_tls_presentation_missing',
      verified: false,
      storedFingerprint: certFingerprint,
    });
  }

  const livePresentationMatch = compareTlsPresentation(certificate, liveTls);
  if (livePresentationMatch.matches) {
    return Object.freeze({
      outcome: 'renewed_and_live_verified',
      verified: true,
      fingerprint256: certFingerprint,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
    });
  }

  // Live TLS did not match new certificate. Check if it still matches pre-renewal certificate
  if (before && before.fingerprint256) {
    const beforeMatch = compareTlsPresentation(before, liveTls);
    if (beforeMatch.matches) {
      return Object.freeze({
        outcome: 'pending_service_reload',
        reason: 'live_tls_presents_previous_certificate',
        verified: false,
        beforeFingerprint: before.fingerprint256.toUpperCase(),
        newFingerprint: certFingerprint,
      });
    }
  }

  return Object.freeze({
    outcome: 'live_tls_mismatch',
    reason: livePresentationMatch.reason,
    verified: false,
    expected: livePresentationMatch.expected,
    actual: livePresentationMatch.actual,
  });
}

export async function verifyCertificateRenewalOutcome({
  certificateId,
  certificateRegistry,
  jobRegistry,
  jobId,
  before = null,
  liveTls = null,
  tlsInspector = null,
  dryRun = false,
}) {
  if (!certificateRegistry || !jobRegistry) throw new Error('certificateRegistry and jobRegistry are required');
  if (typeof certificateId !== 'string' || !certificateId) throw new Error('certificateId is required');
  if (typeof jobId !== 'string' || !jobId) throw new Error('jobId is required');

  const [certificate, job] = await Promise.all([
    certificateRegistry.getCertificate(certificateId),
    jobRegistry.getJob(jobId),
  ]);

  if (!certificate) throw new Error(`Certificate ${certificateId} not found`);
  if (!job) throw new Error(`Job ${jobId} not found`);

  let resolvedLiveTls = liveTls;
  if (!resolvedLiveTls && typeof tlsInspector === 'function') {
    resolvedLiveTls = await tlsInspector({
      certificate,
      certName: certificate.certName,
      domains: certificate.domains,
      serverId: certificate.serverId,
    });
  }

  return verifyRenewalOutcome({
    certificate,
    before,
    job,
    liveTls: resolvedLiveTls,
    dryRun,
  });
}

export async function runCertificateRenewalSweep({
  certificateRegistry,
  jobRegistry,
  dnsProviderCredentialRegistry = null,
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

  for (const certSnapshot of certificates) {
    if (certSnapshot.state !== 'active' || certSnapshot.staging || certSnapshot.renewalMode !== 'automatic' || !certSnapshot.validTo) continue;
    if (certSnapshot.challenge?.type === 'dns-01') {
      if (!dnsProviderCredentialRegistry || typeof dnsProviderCredentialRegistry.getForZone !== 'function') continue;
      let credential;
      try { credential = await dnsProviderCredentialRegistry.getForZone(certSnapshot.challenge.dnsZoneId); }
      catch { continue; }
      if (!credential?.configured || credential.id !== certSnapshot.challenge.credentialId
        || credential.provider !== certSnapshot.challenge.provider) continue;
    }
    const expiresAt = Date.parse(certSnapshot.validTo);
    if (!Number.isFinite(expiresAt) || expiresAt > threshold) continue;

    // Concurrency defense: re-check current certificate state from registry
    const currentCertificate = await certificateRegistry.getCertificate(certSnapshot.id);
    if (!currentCertificate || currentCertificate.state !== 'active') continue;

    const existingJobs = await jobRegistry.listJobs({
      resourceType: 'certificate',
      resourceId: certSnapshot.id,
    });
    if (existingJobs.some((job) => (
      job.operation === OPERATIONS.SSL_RENEW
      && (job.status === 'queued' || job.status === 'running')
    ))) continue;

    await certificateRegistry.setState(certSnapshot.id, 'renewing');
    let job;
    try {
      job = await jobRegistry.enqueue({
        serverId: certSnapshot.serverId,
        type: 'ssl.renew',
        operation: OPERATIONS.SSL_RENEW,
        payload: {
          certName: certSnapshot.certName,
          dryRun: false,
          ...(certSnapshot.challenge?.type === 'dns-01' ? { challenge: certSnapshot.challenge } : {}),
        },
        resourceType: 'certificate',
        resourceId: certSnapshot.id,
      });
    } catch (enqueueError) {
      // Another sweep can enqueue after both observed the same active state.
      // Only a proved live renewal for this exact certificate/server is benign.
      if (enqueueError?.code === 'certificate_job_conflict' && enqueueError.status === 409) {
        const concurrentJobs = await jobRegistry.listJobs({ resourceType: 'certificate', resourceId: certSnapshot.id });
        if (concurrentJobs.some(candidate => candidate.resourceType === 'certificate'
          && candidate.resourceId === certSnapshot.id && candidate.serverId === certSnapshot.serverId
          && candidate.operation === OPERATIONS.SSL_RENEW && ['queued', 'running'].includes(candidate.status))) continue;
      }
      await certificateRegistry.setState(certSnapshot.id, 'active').catch(() => {});
      throw enqueueError;
    }
    queued.push(job);
  }

  return queued;
}

export function startCertificateRenewalScheduler({
  certificateRegistry,
  jobRegistry,
  dnsProviderCredentialRegistry = null,
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
      const jobs = await runCertificateRenewalSweep({
        certificateRegistry, jobRegistry, dnsProviderCredentialRegistry, renewBeforeMs,
      });
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

export const certificateRenewalSchedulerInternals = Object.freeze({
  verifyRenewalOutcome,
  verifyCertificateRenewalOutcome,
});
