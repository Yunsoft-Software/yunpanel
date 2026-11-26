import { normalizeDomainSet } from '@yunpanel/shared';

export const DEFAULT_CERTIFICATE_RETENTION_DAYS = 30;

export class CertificateMaterialGcError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CertificateMaterialGcError';
    this.code = code;
    this.status = status;
  }
}

function normalizeCertName(certName) {
  if (typeof certName !== 'string') return null;
  try {
    return normalizeDomainSet(certName, []).primary;
  } catch {
    return certName.trim().toLowerCase();
  }
}

function candidateSummary(cert, reason = null) {
  return Object.freeze({
    id: cert.id,
    domainId: cert.domainId,
    serverId: cert.serverId,
    certName: cert.certName,
    source: cert.source,
    purpose: cert.purpose,
    state: cert.state,
    retiredAt: cert.retiredAt ?? null,
    materialPurgedAt: cert.materialPurgedAt ?? null,
    materialDigest: cert.materialDigest ?? null,
    ...(reason ? { reason } : {}),
  });
}

export function createCertificateMaterialGc({
  certificateRegistry,
  domainRegistry = null,
  certificateMaterialManager,
  acmeManager = null,
  defaultRetentionDays = DEFAULT_CERTIFICATE_RETENTION_DAYS,
  now = () => Date.now(),
} = {}) {
  if (!certificateRegistry || typeof certificateRegistry.listCertificates !== 'function'
    || typeof certificateRegistry.markMaterialPurged !== 'function') {
    throw new CertificateMaterialGcError('invalid_certificate_registry', 'Certificate registry is required for GC', 500);
  }
  if (!certificateMaterialManager || typeof certificateMaterialManager.removeCustom !== 'function') {
    throw new CertificateMaterialGcError('invalid_certificate_material_manager', 'Certificate material manager is required for GC', 500);
  }
  if (!Number.isInteger(defaultRetentionDays) || defaultRetentionDays < 0) {
    throw new CertificateMaterialGcError('invalid_retention_days', 'Retention days must be a non-negative integer');
  }

  function validateRetentionDays(retentionDays) {
    const days = retentionDays ?? defaultRetentionDays;
    if (!Number.isInteger(days) || days < 0) {
      throw new CertificateMaterialGcError('invalid_retention_days', 'Retention days must be a non-negative integer');
    }
    return days;
  }

  async function inspectGcCandidates({ retentionDays = defaultRetentionDays } = {}) {
    const days = validateRetentionDays(retentionDays);
    const retentionMs = days * 24 * 60 * 60 * 1000;
    const currentTime = typeof now === 'function' ? now() : now;

    const certificates = await certificateRegistry.listCertificates();
    const domains = domainRegistry && typeof domainRegistry.listDomains === 'function'
      ? await domainRegistry.listDomains()
      : [];

    const domainBoundCertIds = new Set(domains.map((d) => d.certificateId).filter(Boolean));

    // Active certificates: anything not retired
    const activeCerts = certificates.filter((c) => c.state !== 'retired');

    // Build lookup sets for active certificates to detect sharing
    const activeAcmeNames = new Set();
    const activeMaterialDigests = new Set();
    const activePaths = new Set();

    for (const active of activeCerts) {
      if (active.source === 'acme' && active.certName) {
        const name = normalizeCertName(active.certName);
        if (name) activeAcmeNames.add(name);
      }
      if (active.materialDigest) {
        activeMaterialDigests.add(active.materialDigest);
      }
      if (active.certificatePath) activePaths.add(active.certificatePath);
      if (active.fullchainPath) activePaths.add(active.fullchainPath);
      if (active.privateKeyPath) activePaths.add(active.privateKeyPath);
    }

    const eligible = [];
    const retained = [];
    const sharedActive = [];
    const sharedRetained = [];
    const alreadyPurged = [];
    const notRetired = [];

    // First pass: identify non-eligible retired and active certs
    const retiredCerts = [];
    for (const cert of certificates) {
      if (cert.state !== 'retired') {
        notRetired.push(candidateSummary(cert));
        continue;
      }
      if (cert.materialPurgedAt !== null) {
        alreadyPurged.push(candidateSummary(cert));
        continue;
      }
      if (domainBoundCertIds.has(cert.id)) {
        sharedActive.push(candidateSummary(cert, 'referenced_by_domain'));
        continue;
      }

      // Check sharing with active certificates
      const isAcmeSharedActive = cert.source === 'acme' && activeAcmeNames.has(normalizeCertName(cert.certName));
      const isDigestSharedActive = cert.materialDigest && activeMaterialDigests.has(cert.materialDigest);
      const isPathSharedActive = (cert.certificatePath && activePaths.has(cert.certificatePath))
        || (cert.fullchainPath && activePaths.has(cert.fullchainPath))
        || (cert.privateKeyPath && activePaths.has(cert.privateKeyPath));

      if (isAcmeSharedActive || isDigestSharedActive || isPathSharedActive) {
        sharedActive.push(candidateSummary(cert, 'shared_with_active_certificate'));
        continue;
      }

      retiredCerts.push(cert);
    }

    // Second pass: check retention window and cross-retired sharing
    for (const cert of retiredCerts) {
      const retiredAtMs = Date.parse(cert.retiredAt);
      const isExpired = Number.isFinite(retiredAtMs) && (currentTime - retiredAtMs) >= retentionMs;

      if (!isExpired) {
        retained.push(candidateSummary(cert, 'retention_window_active'));
        continue;
      }

      // Check if this expired retired cert shares material with another UNEXPIRED retired cert
      const certAcmeName = cert.source === 'acme' ? normalizeCertName(cert.certName) : null;
      let sharesWithUnexpired = false;

      for (const other of retiredCerts) {
        if (other.id === cert.id) continue;
        const otherRetiredAtMs = Date.parse(other.retiredAt);
        const otherExpired = Number.isFinite(otherRetiredAtMs) && (currentTime - otherRetiredAtMs) >= retentionMs;
        if (otherExpired) continue;

        // other is still retained (unexpired)
        const isAcmeShare = certAcmeName && other.source === 'acme' && normalizeCertName(other.certName) === certAcmeName;
        const isDigestShare = cert.materialDigest && other.materialDigest && cert.materialDigest === other.materialDigest;
        const isPathShare = (cert.certificatePath && cert.certificatePath === other.certificatePath)
          || (cert.fullchainPath && cert.fullchainPath === other.fullchainPath)
          || (cert.privateKeyPath && cert.privateKeyPath === other.privateKeyPath);

        if (isAcmeShare || isDigestShare || isPathShare) {
          sharesWithUnexpired = true;
          break;
        }
      }

      if (sharesWithUnexpired) {
        sharedRetained.push(candidateSummary(cert, 'shared_with_retained_certificate'));
      } else {
        eligible.push(candidateSummary(cert));
      }
    }

    return Object.freeze({
      inspectedAt: new Date(currentTime).toISOString(),
      retentionDays: days,
      totalCertificates: certificates.length,
      eligibleCount: eligible.length,
      retainedCount: retained.length,
      sharedActiveCount: sharedActive.length,
      sharedRetainedCount: sharedRetained.length,
      alreadyPurgedCount: alreadyPurged.length,
      notRetiredCount: notRetired.length,
      eligible: Object.freeze(eligible),
      retained: Object.freeze(retained),
      sharedActive: Object.freeze(sharedActive),
      sharedRetained: Object.freeze(sharedRetained),
      alreadyPurged: Object.freeze(alreadyPurged),
    });
  }

  async function sweep({ retentionDays = defaultRetentionDays, dryRun = false } = {}) {
    const inspection = await inspectGcCandidates({ retentionDays });
    const candidates = inspection.eligible;

    if (dryRun || candidates.length === 0) {
      return Object.freeze({
        sweptCount: dryRun ? candidates.length : 0,
        sweptCertificates: dryRun ? candidates : Object.freeze([]),
        alreadyPurgedCount: inspection.alreadyPurgedCount,
        skippedCount: inspection.retainedCount + inspection.sharedActiveCount + inspection.sharedRetainedCount,
        dryRun: Boolean(dryRun),
      });
    }

    const currentTime = typeof now === 'function' ? now() : now;
    const purgedAt = new Date(currentTime).toISOString();
    const swept = [];
    const cleanedAcmeNames = new Set();

    for (const candidate of candidates) {
      if (candidate.source === 'custom') {
        await certificateMaterialManager.removeCustom(candidate.id);
      } else if (candidate.source === 'acme') {
        const safeName = normalizeCertName(candidate.certName);
        if (safeName && !cleanedAcmeNames.has(safeName)) {
          let cleaned = false;
          if (acmeManager && typeof acmeManager.deleteCertificate === 'function') {
            try {
              await acmeManager.deleteCertificate({ certName: safeName });
              cleaned = true;
            } catch (error) {
              if (error?.code !== 'certbot_not_installed') {
                throw error;
              }
            }
          }
          if (!cleaned && typeof certificateMaterialManager.removeAcme === 'function') {
            await certificateMaterialManager.removeAcme(safeName);
          }
          cleanedAcmeNames.add(safeName);
        }
      }

      await certificateRegistry.markMaterialPurged(candidate.id, { purgedAt });
      swept.push(candidate);
    }

    return Object.freeze({
      sweptCount: swept.length,
      sweptCertificates: Object.freeze(swept),
      purgedAt,
      alreadyPurgedCount: inspection.alreadyPurgedCount,
      skippedCount: inspection.retainedCount + inspection.sharedActiveCount + inspection.sharedRetainedCount,
      dryRun: false,
    });
  }

  return Object.freeze({
    inspectGcCandidates,
    sweep,
  });
}
