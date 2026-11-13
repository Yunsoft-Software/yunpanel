import { existsSync, readFileSync } from 'node:fs';
import { assertApplicationWebsiteIdle } from './application-website-job-guard.js';
import express from 'express';
import { OPERATIONS } from '@yunpanel/protocol';
import { ApplicationValidationError, normalizeGitDeploymentTarget } from '@yunpanel/shared';
import {
  createApplicationEnvironmentRegistry,
  ApplicationEnvironmentRegistryError,
} from './application-environment-registry.js';
import { createApplicationDeployQueue } from './application-deploy-queue.js';
import { createApplicationRegistry, ApplicationRegistryError } from './application-registry.js';
import { certificatePublicView, createCertificateRegistry, CertificateRegistryError } from './certificate-registry.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import { createJobRegistry, jobPublicView, JobRegistryError } from './job-registry.js';
import { DurableJobRegistryError } from './durable-job-registry.js';
import { JobReconciliationError, reconcileCompletedJob } from './job-reconciliation.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createServerRegistry, RegistryError } from './server-registry.js';

export const API_VERSION = '0.3.0';
export const SCHEMA_VERSION = 3;
export const DEFAULT_STALE_THRESHOLD_MS = 60 * 1000;

export const FRESHNESS_STATUSES = Object.freeze({
  HEALTHY: 'healthy',
  STALE: 'stale',
  UNKNOWN: 'unknown',
});

export const DEPLOYMENT_COMPARISON_STATUSES = Object.freeze({
  SYNCHRONIZED: 'synchronized',
  VERSION_MISMATCH: 'version_mismatch',
  STALE_CACHE: 'stale_cache',
  SCHEMA_MISMATCH: 'schema_mismatch',
  UNKNOWN: 'unknown',
});

const SENSITIVE_PATH_PATTERN = /(?:\/[^\s"'/]+)*\/(?:root|home|etc\/shadow|etc\/yunpanel|\.gemini|\.ssh|credentials)(?:\/[^\s"']*)?/gi;

function isSensitiveDiagnosticKey(key) {
  if (typeof key !== 'string') return false;
  const lower = key.toLowerCase();

  if (lower.startsWith('safe') || lower.includes('safekey') || lower.includes('safe_key')) {
    return false;
  }

  if (lower.endsWith('path') || lower.endsWith('file') || lower.endsWith('dir') || lower.endsWith('url')) {
    return false;
  }

  if (lower.endsWith('header')) {
    return false;
  }

  if (/(?:password|passwd|pwd|secret|credential)/i.test(lower)) {
    return true;
  }
  if (/(?:^|_|-)token|token(?:$|_|-)|api_token|authtoken|accesstoken/i.test(lower)) {
    return true;
  }
  if (/(?:auth_key|api_key|private_key|secret_key|master_key|access_key|signing_key)/i.test(lower)) {
    return true;
  }
  if (/(?:authkey|apikey|privatekey|secretkey|masterkey|accesskey|signingkey)/i.test(lower)) {
    return true;
  }
  if (lower === 'key' || lower === 'token' || lower === 'cookie') {
    return true;
  }
  if (/(?:^|_|-)auth(?:$|_|-)/i.test(lower)) {
    return true;
  }

  return false;
}

export function sanitizeDiagnosticInfo(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let sanitized = value.replace(SENSITIVE_PATH_PATTERN, '[REDACTED_PATH]');
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnosticInfo);
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveDiagnosticKey(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = sanitizeDiagnosticInfo(v);
      }
    }
    return result;
  }
  return value;
}

const DEFAULT_BUILD_MANIFEST_PATH = '/usr/lib/yunpanel/build-info.json';
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i;
const BUILD_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{3,128}$/;

function isKnownDiagnosticToken(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'unknown';
}

function normalizeBuildToken(value) {
  if (!isKnownDiagnosticToken(value)) return null;
  const trimmed = value.trim();
  return BUILD_TOKEN_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeCommitHash(value) {
  if (!isKnownDiagnosticToken(value)) return null;
  const trimmed = value.trim().toLowerCase();
  return COMMIT_HASH_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeBuildTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function hasExplicitEnvString(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function inspectBuildManifestFile(manifestPath) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    return {
      state: 'absent',
      exists: false,
      valid: false,
      dirty: false,
      manifest: null,
      warning: null,
    };
  }
  if (!existsSync(manifestPath)) {
    return {
      state: 'absent',
      exists: false,
      valid: false,
      dirty: false,
      manifest: null,
      warning: null,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        state: 'corrupt',
        exists: true,
        valid: false,
        dirty: false,
        manifest: null,
        warning: 'Package build-info.json manifest is corrupt or invalid; runtime build provenance is unverified.',
      };
    }
    const dirty = raw.dirty === true;
    const rawVerified = raw.buildVerified === true;
    const buildId = normalizeBuildToken(raw.buildId);
    const assetId = normalizeBuildToken(raw.assetId);
    const commit = normalizeCommitHash(raw.commit);
    const buildTime = normalizeBuildTime(raw.buildTime);

    if (dirty || !rawVerified || !buildId || !assetId || !commit || !buildTime) {
      return {
        state: dirty ? 'dirty' : 'unverified',
        exists: true,
        valid: false,
        dirty,
        manifest: null,
        warning: dirty
          ? 'Package build-info.json manifest was built from a dirty working tree; runtime build provenance is unverified.'
          : 'Package build-info.json manifest is incomplete or unverified; runtime build provenance is unverified.',
      };
    }

    return {
      state: 'verified',
      exists: true,
      valid: true,
      dirty: false,
      manifest: { buildId, assetId, commit, buildTime },
      warning: null,
    };
  } catch {
    return {
      state: 'corrupt',
      exists: true,
      valid: false,
      dirty: false,
      manifest: null,
      warning: 'Package build-info.json manifest is corrupt or unreadable; runtime build provenance is unverified.',
    };
  }
}

export function evaluateDeploymentEvidence({
  deployedCommit,
  sourceCommit,
  isDirtyTree = false,
  buildId,
  deployedAt,
  metadataConflict = false,
  manifestInvalid = false,
  extraWarnings = [],
} = {}) {
  const knownDeployedCommit = isKnownDiagnosticToken(deployedCommit) ? deployedCommit.trim() : null;
  const knownSourceCommit = isKnownDiagnosticToken(sourceCommit) ? sourceCommit.trim() : null;
  const dirty = Boolean(isDirtyTree);
  const commitMismatch = Boolean(knownSourceCommit && knownDeployedCommit && knownSourceCommit !== knownDeployedCommit);
  const diverged = dirty || commitMismatch;
  const provenanceBlocked = Boolean(metadataConflict || manifestInvalid);
  const verified = !diverged && !provenanceBlocked && Boolean(knownDeployedCommit && knownSourceCommit && knownDeployedCommit === knownSourceCommit);
  const status = diverged ? 'diverged' : (verified ? 'synchronized' : 'unverified');
  const warnings = Array.isArray(extraWarnings) ? [...extraWarnings] : [];

  if (dirty) {
    warnings.push('Uncommitted changes detected in local source workspace: runtime code may differ from repository tree.');
  }
  if (commitMismatch) {
    warnings.push(`Local source HEAD (${knownSourceCommit}) does not match deployed runtime commit (${knownDeployedCommit}). Deploy pipeline execution required for changes to take effect.`);
  }

  let summary;
  if (diverged) {
    summary = 'RUNTIME DIVERGENCE: Source code modifications have NOT been deployed to the live runtime environment.';
  } else if (verified) {
    summary = 'RUNTIME SYNCHRONIZED: Live runtime build matches current source commit.';
  } else if (metadataConflict) {
    summary = 'RUNTIME UNVERIFIED: Environment deployment metadata conflicts with immutable package build-info.json; source/runtime equality is not proven.';
  } else if (manifestInvalid) {
    summary = 'RUNTIME UNVERIFIED: Package build-info.json manifest is corrupt, dirty, or unverified; source/runtime equality is not proven.';
  } else {
    summary = 'RUNTIME UNVERIFIED: Build or source commit metadata is unavailable; source/runtime equality is not proven.';
  }

  return {
    deployed: {
      buildId: buildId ?? null,
      commit: deployedCommit ?? null,
      deployedAt: deployedAt ?? null,
    },
    source: {
      commit: knownSourceCommit,
      isDirtyTree: dirty,
    },
    status,
    verified,
    diverged,
    warnings,
    summary,
  };
}

export function resolveDeploymentDiagnostics(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());

  const defaultManifestPath = options.env === undefined ? DEFAULT_BUILD_MANIFEST_PATH : null;
  const manifestPath = options.manifestPath !== undefined
    ? options.manifestPath
    : (env.YUNPANEL_BUILD_MANIFEST_PATH ?? defaultManifestPath);
  const manifestInspection = inspectBuildManifestFile(manifestPath);

  const rawEnvBuildId = hasExplicitEnvString(env.YUNPANEL_BUILD_ID) ? String(env.YUNPANEL_BUILD_ID).trim() : null;
  const envBuildId = normalizeBuildToken(rawEnvBuildId);
  const rawEnvCommitSource = env.YUNPANEL_COMMIT_HASH ?? env.YUNPANEL_BUILD_COMMIT ?? env.GIT_COMMIT;
  const rawEnvCommit = hasExplicitEnvString(rawEnvCommitSource) ? String(rawEnvCommitSource).trim() : null;
  const envCommit = normalizeCommitHash(rawEnvCommit);
  const rawEnvBuildTimeSource = env.YUNPANEL_BUILD_TIME ?? env.BUILD_TIMESTAMP;
  const rawEnvBuildTime = hasExplicitEnvString(rawEnvBuildTimeSource) ? String(rawEnvBuildTimeSource).trim() : null;
  const envBuildTime = normalizeBuildTime(rawEnvBuildTime);
  const rawEnvAssetId = hasExplicitEnvString(env.YUNPANEL_ASSET_ID) ? String(env.YUNPANEL_ASSET_ID).trim() : null;
  const envAssetId = normalizeBuildToken(rawEnvAssetId);

  let buildId;
  let commit;
  let buildTime;
  let assetId;
  let metadataConflict = false;
  let manifestInvalid = false;
  const extraWarnings = [];

  if (manifestInspection.state === 'verified') {
    const { manifest } = manifestInspection;
    buildId = normalizeBuildToken(options.buildId) ?? manifest.buildId;
    commit = normalizeCommitHash(options.commit) ?? manifest.commit;
    buildTime = normalizeBuildTime(options.buildTime) ?? manifest.buildTime;
    assetId = normalizeBuildToken(options.assetId) ?? manifest.assetId;

    const conflictingFields = [];
    if (options.buildId === undefined && rawEnvBuildId !== null && envBuildId !== manifest.buildId) {
      conflictingFields.push('buildId');
    }
    if (options.commit === undefined && rawEnvCommit !== null && envCommit !== manifest.commit) {
      conflictingFields.push('commit');
    }
    if (options.assetId === undefined && rawEnvAssetId !== null && envAssetId !== manifest.assetId) {
      conflictingFields.push('assetId');
    }
    if (options.buildTime === undefined && rawEnvBuildTime !== null && envBuildTime !== manifest.buildTime) {
      conflictingFields.push('buildTime');
    }

    if (conflictingFields.length > 0) {
      metadataConflict = true;
      extraWarnings.push(
        `Environment deployment metadata (${conflictingFields.join(', ')}) conflicts with immutable package build-info.json; authoritative package manifest values are retained and runtime provenance is marked unverified.`,
      );
    }
  } else if (manifestInspection.exists) {
    manifestInvalid = true;
    buildId = normalizeBuildToken(options.buildId) ?? 'unknown';
    commit = normalizeCommitHash(options.commit) ?? 'unknown';
    buildTime = normalizeBuildTime(options.buildTime) ?? null;
    assetId = normalizeBuildToken(options.assetId) ?? 'unknown';
    if (manifestInspection.warning) {
      extraWarnings.push(manifestInspection.warning);
    }
  } else {
    buildId = normalizeBuildToken(options.buildId) ?? envBuildId ?? 'unknown';
    commit = normalizeCommitHash(options.commit) ?? envCommit ?? 'unknown';
    buildTime = normalizeBuildTime(options.buildTime) ?? envBuildTime ?? null;
    assetId = normalizeBuildToken(options.assetId) ?? envAssetId ?? 'unknown';
  }

  const isDirtyTree = options.isDirtyTree !== undefined
    ? Boolean(options.isDirtyTree)
    : (env.YUNPANEL_DIRTY_TREE === 'true' || env.YUNPANEL_DIRTY_TREE === '1');
  const dirty = Boolean(isDirtyTree || manifestInspection.dirty || options.dirty === true);

  const buildVerified = !dirty
    && !metadataConflict
    && !manifestInvalid
    && commit !== 'unknown'
    && buildId !== 'unknown'
    && assetId !== 'unknown'
    && buildTime !== null;
  const environment = options.environment ?? env.NODE_ENV ?? 'production';

  const sourceCommit = normalizeCommitHash(options.sourceCommit ?? env.YUNPANEL_SOURCE_COMMIT ?? null);

  const evidence = evaluateDeploymentEvidence({
    deployedCommit: commit,
    sourceCommit,
    isDirtyTree,
    buildId,
    deployedAt: buildTime,
    metadataConflict,
    manifestInvalid,
    extraWarnings,
  });

  const sourceDiffWarning = options.sourceDiffWarning ?? (
    evidence.warnings.length > 0 ? evidence.warnings[0] : null
  );

  const rawInfo = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId,
    commit,
    buildTime,
    assetId,
    dirty,
    metadataConflict,
    manifestInvalid,
    buildVerified,
    environment,
    sourceInfo: {
      sourceCommit,
      dirty,
      isDirtyTree,
      sourceMatchesDeployed: buildVerified && evidence.verified === true && !evidence.diverged,
      warning: sourceDiffWarning,
    },
    evidence,
    lastCheckedAt: now.toISOString(),
  };

  return sanitizeDiagnosticInfo(rawInfo);
}

export function evaluateFreshnessState(options = {}) {
  const {
    lastCheckedAt,
    staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
    now = Date.now(),
    checkSuccessful = true,
  } = options;

  const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.parse(now));

  if (!lastCheckedAt) {
    return {
      status: FRESHNESS_STATUSES.UNKNOWN,
      healthy: false,
      lastCheckedAt: null,
      elapsedMs: null,
      thresholdMs: staleThresholdMs,
      stale: false,
      unknown: true,
      message: 'Freshness status is unknown: check has never run or timestamp is absent.',
    };
  }

  const lastCheckedMs = typeof lastCheckedAt === 'number' ? lastCheckedAt : Date.parse(lastCheckedAt);
  if (Number.isNaN(lastCheckedMs)) {
    return {
      status: FRESHNESS_STATUSES.UNKNOWN,
      healthy: false,
      lastCheckedAt: null,
      elapsedMs: null,
      thresholdMs: staleThresholdMs,
      stale: false,
      unknown: true,
      message: 'Freshness status is unknown: invalid check timestamp.',
    };
  }

  const elapsedMs = Math.max(0, currentMs - lastCheckedMs);

  if (elapsedMs > staleThresholdMs) {
    return {
      status: FRESHNESS_STATUSES.STALE,
      healthy: false,
      lastCheckedAt: new Date(lastCheckedMs).toISOString(),
      elapsedMs,
      thresholdMs: staleThresholdMs,
      stale: true,
      unknown: false,
      message: `Diagnostic check is stale: last checked ${Math.round(elapsedMs / 1000)}s ago (threshold: ${Math.round(staleThresholdMs / 1000)}s).`,
    };
  }

  if (!checkSuccessful) {
    return {
      status: 'unhealthy',
      healthy: false,
      lastCheckedAt: new Date(lastCheckedMs).toISOString(),
      elapsedMs,
      thresholdMs: staleThresholdMs,
      stale: false,
      unknown: false,
      message: 'Diagnostic check executed recently but reported unhealthy status.',
    };
  }

  return {
    status: FRESHNESS_STATUSES.HEALTHY,
    healthy: true,
    lastCheckedAt: new Date(lastCheckedMs).toISOString(),
    elapsedMs,
    thresholdMs: staleThresholdMs,
    stale: false,
    unknown: false,
    message: 'Diagnostic check is fresh and healthy.',
  };
}

function parseOptionalBooleanParam(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

export function compareDeploymentVersions(backendDeployment, frontendClient = {}) {
  const backend = backendDeployment || resolveDeploymentDiagnostics();
  const normalizedBackendBuildId = normalizeBuildToken(backend.buildId);
  const normalizedBackendAssetId = normalizeBuildToken(backend.assetId);
  const normalizedBackendCommit = normalizeCommitHash(backend.commit);
  const normalizedBackendBuildTime = normalizeBuildTime(backend.buildTime);

  const backendSummary = {
    version: backend.version,
    schemaVersion: backend.schemaVersion,
    buildId: backend.buildId,
    assetId: backend.assetId,
    commit: normalizedBackendCommit ?? (backend.commit ?? null),
    buildTime: normalizedBackendBuildTime ?? (backend.buildTime ?? null),
  };

  if (!frontendClient || typeof frontendClient !== 'object' || Object.keys(frontendClient).length === 0) {
    return {
      status: DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN,
      compatible: false,
      staleCache: false,
      requiresRefresh: false,
      hardRefreshRequired: false,
      backend: backendSummary,
      frontend: null,
      message: 'Frontend client version information was not supplied.',
    };
  }

  const {
    version: frontendVersion,
    buildId: frontendBuildId,
    assetId: frontendAssetId,
    schemaVersion: frontendSchemaVersion,
    commit: frontendCommit,
    buildTime: frontendBuildTime,
    dirty: frontendDirtyRaw,
    buildVerified: frontendBuildVerifiedRaw,
  } = frontendClient;

  const normalizedFrontendBuildId = normalizeBuildToken(frontendBuildId);
  const normalizedFrontendAssetId = normalizeBuildToken(frontendAssetId);
  const normalizedFrontendCommit = normalizeCommitHash(frontendCommit);
  const normalizedFrontendBuildTime = normalizeBuildTime(frontendBuildTime);
  const frontendDirty = parseOptionalBooleanParam(frontendDirtyRaw) === true;
  const frontendVerified = parseOptionalBooleanParam(frontendBuildVerifiedRaw) === true;

  const frontendSummary = {
    version: frontendVersion ?? null,
    schemaVersion: frontendSchemaVersion !== undefined && frontendSchemaVersion !== null ? Number(frontendSchemaVersion) : null,
    buildId: frontendBuildId ?? null,
    assetId: frontendAssetId ?? null,
    commit: normalizedFrontendCommit ?? (frontendCommit ?? null),
    buildTime: normalizedFrontendBuildTime ?? (frontendBuildTime ?? null),
  };

  if (frontendSchemaVersion !== undefined && frontendSchemaVersion !== null && Number(frontendSchemaVersion) !== backend.schemaVersion) {
    return {
      status: DEPLOYMENT_COMPARISON_STATUSES.SCHEMA_MISMATCH,
      compatible: false,
      staleCache: false,
      requiresRefresh: true,
      hardRefreshRequired: true,
      backend: backendSummary,
      frontend: frontendSummary,
      message: `Data schema version mismatch: frontend expects schema ${frontendSchemaVersion}, but backend serves schema ${backend.schemaVersion}.`,
    };
  }

  if (frontendVersion && frontendVersion !== backend.version) {
    return {
      status: DEPLOYMENT_COMPARISON_STATUSES.VERSION_MISMATCH,
      compatible: false,
      staleCache: false,
      requiresRefresh: true,
      hardRefreshRequired: true,
      backend: backendSummary,
      frontend: frontendSummary,
      message: `API version mismatch: frontend version ${frontendVersion} differs from backend ${backend.version}.`,
    };
  }

  const assetMismatch = Boolean(
    normalizedFrontendAssetId && normalizedBackendAssetId && normalizedFrontendAssetId !== normalizedBackendAssetId,
  );
  const buildMismatch = Boolean(
    normalizedFrontendBuildId && normalizedBackendBuildId && normalizedFrontendBuildId !== normalizedBackendBuildId,
  );
  const commitMismatch = Boolean(
    normalizedFrontendCommit && normalizedBackendCommit && normalizedFrontendCommit !== normalizedBackendCommit,
  );
  const buildTimeMismatch = Boolean(
    normalizedFrontendBuildTime && normalizedBackendBuildTime && normalizedFrontendBuildTime !== normalizedBackendBuildTime,
  );

  if (assetMismatch || buildMismatch || commitMismatch || buildTimeMismatch) {
    const mismatchDetail = (commitMismatch || buildTimeMismatch) && !assetMismatch && !buildMismatch
      ? `Stale frontend asset cache detected: client commit/buildTime (${normalizedFrontendCommit || normalizedFrontendBuildTime}) differs from current deployed (${normalizedBackendCommit || normalizedBackendBuildTime}).`
      : `Stale frontend asset cache detected: client is running ${frontendAssetId || frontendBuildId}, current deployed is ${backend.assetId || backend.buildId}.`;
    return {
      status: DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE,
      compatible: false,
      staleCache: true,
      requiresRefresh: true,
      hardRefreshRequired: true,
      backend: backendSummary,
      frontend: frontendSummary,
      message: mismatchDetail,
    };
  }

  const backendProvenanceVerified = Boolean(
    backend.buildVerified === true
    && backend.dirty !== true
    && backend.metadataConflict !== true
    && backend.manifestInvalid !== true
    && normalizedBackendBuildId
    && normalizedBackendAssetId
    && normalizedBackendCommit
    && normalizedBackendBuildTime,
  );

  const frontendProvenanceVerified = Boolean(
    !frontendDirty
    && frontendVerified
    && normalizedFrontendBuildId
    && normalizedFrontendAssetId
    && normalizedFrontendCommit
    && normalizedFrontendBuildTime,
  );

  if (!backendProvenanceVerified || !frontendProvenanceVerified) {
    return {
      status: DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN,
      compatible: false,
      staleCache: false,
      requiresRefresh: false,
      hardRefreshRequired: false,
      backend: backendSummary,
      frontend: frontendSummary,
      message: 'Deployment synchronization cannot be verified because backend or frontend build provenance metadata is incomplete or unverified.',
    };
  }

  return {
    status: DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED,
    compatible: true,
    staleCache: false,
    requiresRefresh: false,
    hardRefreshRequired: false,
    backend: backendSummary,
    frontend: frontendSummary,
    message: 'Frontend and backend deployment versions are fully synchronized.',
  };
}

export function requireDeploymentDiagnosticsAccess(request, response, next) {
  const auth = request.auth;
  if (!auth?.user || !auth?.access || !auth?.security) {
    return response.status(401).json({ error: { code: 'unauthorized', message: 'Authenticated panel context is required.' } });
  }

  if (auth.user.status && auth.user.status !== 'active') {
    return response.status(403).json({ error: { code: 'forbidden', message: 'Inactive account cannot access diagnostics.' } });
  }

  if (
    auth.user.role === 'owner'
    && auth.access.mode === 'management'
    && auth.security.managementAllowed === true
  ) {
    return next();
  }

  if (
    auth.user.role === 'read_only'
    && auth.access.mode === 'read_only'
    && Array.isArray(auth.access.permissions)
    && (auth.access.permissions.includes('servers.read') || auth.access.permissions.includes('*'))
  ) {
    return next();
  }

  return response.status(403).json({ error: { code: 'forbidden', message: 'Site-scoped role cannot access global server management.' } });
}

function bearerToken(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function ensureResourceJobIdle(jobRegistry, resourceType, resourceId) {
  const jobs = await jobRegistry.listJobs({ resourceType, resourceId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new JobRegistryError(`${resourceType}_job_conflict`, `A ${resourceType} operation is already queued or running`, 409);
  }
}

function domainWithinZone(hostname, zoneName) {
  return hostname === zoneName || hostname.endsWith(`.${zoneName}`);
}

function coveredByZoneWildcard(hostname, zoneName) {
  if (hostname === zoneName) return true;
  if (!hostname.endsWith(`.${zoneName}`)) return false;
  return !hostname.slice(0, -(zoneName.length + 1)).includes('.');
}

async function resolveCertificateIssueIntent({
  body,
  domain,
  dnsHostingRegistry,
  dnsProviderCredentialRegistry,
  localServerId,
}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((field) => !['email', 'staging', 'challenge', 'domains', 'assignToMail'].includes(field))
    || (body.staging !== undefined && typeof body.staging !== 'boolean')
    || (body.assignToMail !== undefined && typeof body.assignToMail !== 'boolean')) {
    throw new CertificateRegistryError('invalid_certificate_request', 'Certificate request fields are invalid');
  }

  let requestedNames = null;
  if (body.domains !== undefined) {
    if (!Array.isArray(body.domains) || body.domains.length < 1 || body.domains.length > 21) {
      throw new CertificateRegistryError('invalid_certificate_domains', 'Certificate names must contain between 1 and 21 domains');
    }
    const allowedBases = [domain.primaryDomain, ...domain.aliases];
    const normalized = [];
    for (const d of body.domains) {
      if (typeof d !== 'string' || !d.trim()) {
        throw new CertificateRegistryError('invalid_certificate_domain', 'Each domain name must be a non-empty string');
      }
      const item = d.trim().toLowerCase();
      const isWildcard = item.startsWith('*.');
      const baseCandidate = isWildcard ? item.slice(2) : item;
      const matchesBase = allowedBases.some((base) => {
        if (baseCandidate === base) return true;
        if (baseCandidate.endsWith(`.${base}`)) return true;
        return false;
      });
      if (!matchesBase) {
        throw new CertificateRegistryError('certificate_domain_mismatch', `Requested domain ${item} does not belong to ${domain.primaryDomain} or its aliases`, 409);
      }
      normalized.push(item);
    }
    const unique = [...new Set(normalized)];
    if (!unique.includes(domain.primaryDomain)) {
      unique.unshift(domain.primaryDomain);
    } else if (unique[0] !== domain.primaryDomain) {
      const idx = unique.indexOf(domain.primaryDomain);
      unique.splice(idx, 1);
      unique.unshift(domain.primaryDomain);
    }
    requestedNames = unique;
  }

  const routeDomains = requestedNames ?? [domain.primaryDomain, ...domain.aliases];
  const hasWildcard = routeDomains.some((name) => name.startsWith('*.'));
  if (hasWildcard && body.challenge?.type !== 'dns-01') {
    throw new CertificateRegistryError('wildcard_not_supported', 'Wildcard certificates require DNS-01', 409);
  }

  if (body.challenge === undefined || (body.challenge?.type === 'http-01' && Object.keys(body.challenge).length === 1)) {
    return { certificateNames: routeDomains, challenge: { type: 'http-01' } };
  }
  const challenge = body.challenge;
  const fields = new Set(['type', 'dnsZoneId', 'wildcard']);
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)
    || challenge.type !== 'dns-01' || typeof challenge.dnsZoneId !== 'string' || typeof challenge.wildcard !== 'boolean'
    || Object.keys(challenge).length !== fields.size || Object.keys(challenge).some((field) => !fields.has(field))) {
    throw new CertificateRegistryError('invalid_certificate_challenge', 'DNS certificate challenge fields are invalid');
  }
  if (!dnsHostingRegistry || !dnsProviderCredentialRegistry || !localServerId || domain.serverId !== localServerId) {
    throw new CertificateRegistryError('local_dns_challenge_required', 'DNS certificate challenges require this local managed Server', 409);
  }
  const zone = await dnsHostingRegistry.getZone(challenge.dnsZoneId);
  if (!zone) throw new CertificateRegistryError('dns_zone_not_found', 'DNS zone was not found', 404);
  if (routeDomains.some((hostname) => !domainWithinZone(hostname.startsWith('*.') ? hostname.slice(2) : hostname, zone.zoneName))) {
    throw new CertificateRegistryError('certificate_dns_zone_mismatch', 'DNS zone does not contain every current Domain hostname', 409);
  }
  const credential = await dnsProviderCredentialRegistry.getForZone(zone.id);
  if (!credential?.configured || credential.provider !== 'cloudflare') {
    throw new CertificateRegistryError('dns_provider_credential_required', 'A supported DNS provider credential is required', 409);
  }
  const names = challenge.wildcard
    ? [zone.zoneName, `*.${zone.zoneName}`, ...routeDomains.filter((hostname) => !coveredByZoneWildcard(hostname, zone.zoneName))]
    : routeDomains;
  const certificateNames = [...new Set(names)];
  if (certificateNames.length > 21) {
    throw new CertificateRegistryError('invalid_certificate_domains', 'Certificate names exceed the supported limit');
  }
  return {
    certificateNames,
    challenge: {
      type: 'dns-01',
      provider: credential.provider,
      credentialId: credential.id,
      dnsZoneId: zone.id,
      propagationSeconds: 30,
    },
  };
}

async function resolveDomainTls(domain, certificateRegistry, certificateMaterialManager, localServerId) {
  if (!domain.certificateId) return null;
  const certificate = await certificateRegistry.getCertificate(domain.certificateId);
  if (!certificate || certificate.state !== 'active') throw new CertificateRegistryError('certificate_not_active', 'Attached certificate is not active', 409);
  if (certificate.staging) throw new CertificateRegistryError('staging_certificate_not_allowed', 'Staging certificates cannot be attached to production HTTPS config', 409);
  if (certificate.domains.join('\n') !== [domain.primaryDomain, ...domain.aliases].join('\n')) {
    throw new CertificateRegistryError('certificate_domain_mismatch', 'Attached certificate does not cover the current Domain routing names', 409);
  }
  if (certificateMaterialManager && domain.serverId === localServerId) {
    let inspected;
    try {
      inspected = await certificateMaterialManager.inspectStored({
        certificate,
        domains: [domain.primaryDomain, ...domain.aliases],
      });
    } catch (error) {
      throw new CertificateRegistryError(
        error?.code ?? 'certificate_material_unavailable',
        error?.message ?? 'Certificate material is unavailable',
        error?.status ?? 409,
      );
    }
    if (inspected.fingerprint256 !== certificate.fingerprint256) {
      throw new CertificateRegistryError('certificate_metadata_mismatch', 'Stored certificate metadata does not match its material', 409);
    }
  }
  return { fullchainPath: certificate.fullchainPath, privateKeyPath: certificate.privateKeyPath };
}

async function latestNodeStatusJob(jobRegistry, applicationId) {
  const jobs = await jobRegistry.listJobs({ resourceType: 'application', resourceId: applicationId });
  return jobs
    .filter((job) => job.operation === OPERATIONS.APP_NODE_STATUS || job.operation === OPERATIONS.APP_PYTHON_STATUS)
    .sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0))[0] ?? null;
}

function deploymentGitTarget(body, defaultBranch) {
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'gitTarget'))) {
    throw new ApplicationRegistryError('invalid_deployment_request', 'Deployment accepts only an optional gitTarget');
  }
  try {
    return normalizeGitDeploymentTarget(body?.gitTarget, { defaultBranch });
  } catch (error) {
    if (error instanceof ApplicationValidationError) throw new ApplicationRegistryError(error.code, error.message);
    throw error;
  }
}

function requestedEnvironmentRevision(query) {
  if (!query || Object.keys(query).length === 0) return null;
  if (Object.keys(query).length !== 1 || typeof query.revision !== 'string' || !/^(?:0|[1-9][0-9]{0,14})$/.test(query.revision)) {
    throw new ApplicationEnvironmentRegistryError('invalid_environment_revision', 'Expected environment revision query is invalid');
  }
  const revision = Number(query.revision);
  if (!Number.isSafeInteger(revision)) throw new ApplicationEnvironmentRegistryError('invalid_environment_revision', 'Expected environment revision query is invalid');
  return revision;
}

function environmentImportInput(body) {
  const fields = ['confirmation', 'content', 'expectedRevision', 'mode', 'secret'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.length || Object.keys(body).some((key) => !fields.includes(key))) {
    throw new ApplicationEnvironmentRegistryError('invalid_environment_import', 'Environment import request fields are invalid');
  }
  return body;
}

async function ensureEnvironmentMutable(application, jobRegistry, websiteRegistry = null) {
  await assertApplicationWebsiteIdle({ applicationId: application.id, websiteRegistry, jobRegistry, serverId: application.serverId });
  await ensureResourceJobIdle(jobRegistry, 'application', application.id);
  if (application.activeDeploymentId) {
    throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
  }
}

export function createApp({
  environment = process.env.NODE_ENV,
  registry = createServerRegistry(),
  domainRegistry = createDomainRegistry(),
  jobRegistry = createJobRegistry(),
  certificateRegistry = createCertificateRegistry(),
  certificateMaterialManager = null,
  localServerId = null,
  dnsHostingRegistry = null,
  dnsProviderCredentialRegistry = null,
  applicationRegistry = createApplicationRegistry(),
  applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
  }),
  applicationDeployQueue = null,
  websiteRegistry = null,
  customerLookup = null,
  deploymentDiagnosticsOptions = null,
  buildManifestPath = undefined,
} = {}) {
  const app = express();
  const resolveAppDeploymentDiagnostics = () => resolveDeploymentDiagnostics({
    ...(environment !== undefined ? { environment } : {}),
    ...(buildManifestPath !== undefined ? { manifestPath: buildManifestPath } : {}),
    ...(deploymentDiagnosticsOptions ?? {}),
  });
  const reconciliationJobs = new Map();
  const queueDeploy = applicationDeployQueue ?? createApplicationDeployQueue({
    applicationRegistry,
    applicationEnvironmentRegistry,
    jobRegistry,
  });

  const inLocalScope = (resource) => Boolean(resource)
    && (localServerId === null || resource.serverId === localServerId || resource.id === localServerId);
  const localOnly = (resources) => localServerId === null
    ? resources
    : resources.filter((resource) => inLocalScope(resource));
  const requireRequestedLocalServer = (serverId) => {
    if (localServerId !== null && serverId !== localServerId) {
      throw new RegistryError('local_server_required', 'Only this panel host can be managed', 404);
    }
    return serverId;
  };
  const requireServer = async (serverId) => {
    const server = await registry.getServer(requireRequestedLocalServer(serverId));
    if (!server || (localServerId !== null && server.executionMode !== 'local')) {
      throw new RegistryError('server_not_found', 'Server not found', 404);
    }
    return server;
  };
  const requireApplication = async (applicationId) => {
    const application = await applicationRegistry.getApplication(applicationId);
    if (!inLocalScope(application)) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    return application;
  };

  const isWebsiteIdAllowedForRequest = async (websiteId, request) => {
    if (!websiteId) return false;
    const user = request?.auth?.user;
    if (!user) return false;
    const role = user.role;
    if (role === 'owner' || role === 'read_only') return true;
    const isReseller = role === 'reseller' || user.hosting?.kind === 'reseller';
    const isCustomer = role === 'customer' || user.hosting?.kind === 'customer';
    const allowed = new Set(user.websiteIds ?? []);

    if (allowed.has(websiteId)) {
      if (websiteRegistry) {
        try {
          const site = await websiteRegistry.getWebsite(websiteId);
          if (isReseller && site && site.resellerId !== undefined && site.resellerId !== user.id) {
            return false;
          }
          if (isCustomer && site && site.customerId && site.customerId !== user.id) {
            return false;
          }
        } catch {}
      }
      return true;
    }

    if (isReseller && websiteRegistry) {
      try {
        const site = await websiteRegistry.getWebsite(websiteId);
        if (site) {
          if (site.resellerId && site.resellerId === user.id) {
            return true;
          }
          if (site.customerId && typeof customerLookup === 'function') {
            const cust = await Promise.resolve(customerLookup(site.customerId));
            if (cust && cust.resellerId === user.id) {
              return true;
            }
          }
        }
      } catch {}
    }

    return false;
  };

  const requireDomain = async (domainId, request = null) => {
    const domain = await domainRegistry.getDomain(domainId);
    if (!inLocalScope(domain)) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    const role = request?.auth?.user?.role;
    if (role && !['owner', 'read_only'].includes(role)) {
      if (!domain.websiteId) {
        throw new DomainRegistryError('forbidden', 'Access denied to this domain', 403);
      }
      const allowed = await isWebsiteIdAllowedForRequest(domain.websiteId, request);
      if (!allowed) {
        throw new DomainRegistryError('forbidden', 'Access denied to this domain', 403);
      }
    }
    return domain;
  };
  const requireCertificate = async (certificateId, request = null) => {
    const certificate = await certificateRegistry.getCertificate(certificateId);
    if (!inLocalScope(certificate)) throw new CertificateRegistryError('certificate_not_found', 'Certificate not found', 404);
    const user = request?.auth?.user;
    const role = user?.role;
    const isScoped = (role && !['owner', 'read_only'].includes(role))
      || user?.hosting?.kind === 'reseller'
      || user?.hosting?.kind === 'customer';
    if (isScoped) {
      const domain = certificate.domainId ? await domainRegistry.getDomain(certificate.domainId).catch(() => null) : null;
      if (!inLocalScope(domain) || !domain.websiteId) {
        throw new CertificateRegistryError('forbidden', 'Access denied to this certificate', 403);
      }
      const allowed = await isWebsiteIdAllowedForRequest(domain.websiteId, request);
      if (!allowed) {
        throw new CertificateRegistryError('forbidden', 'Access denied to this certificate', 403);
      }
    }
    return certificate;
  };
  const requireJob = async (jobId) => {
    const job = await jobRegistry.getJob(jobId);
    if (!inLocalScope(job)) throw new JobRegistryError('job_not_found', 'Job not found', 404);
    return job;
  };

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (request, response) => response.json({ status: 'ok', service: 'yunpanel-api', version: API_VERSION }));

  const developmentList = (loader) => async (request, response) => {
    if (environment !== 'development') return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    return response.json({ data: await loader() });
  };
  app.get('/api/dev/servers', developmentList(async () => localOnly(await registry.listServers())));
  app.get('/api/dev/domains', developmentList(async () => localOnly(await domainRegistry.listDomains())));
  app.get('/api/dev/jobs', developmentList(async () => localOnly(await jobRegistry.listJobs()).map(jobPublicView)));
  app.get('/api/dev/certificates', developmentList(async () => (
    localOnly(await certificateRegistry.listCertificates())).map((certificate) => certificatePublicView(certificate))));
  app.get('/api/dev/applications', developmentList(async () => localOnly(await applicationRegistry.listApplications())));

  app.get('/api/servers', requirePanelRouteAccess, async (request, response) => response.json({ data: localOnly(await registry.listServers()) }));
  app.get('/api/servers/:serverId', requirePanelRouteAccess, async (request, response) => {
    return response.json({ data: await requireServer(request.params.serverId) });
  });
  app.post('/api/servers/:serverId/system/packages/inspect', requirePanelRouteAccess, async (request, response) => {
    const server = await requireServer(request.params.serverId);
    await ensureResourceJobIdle(jobRegistry, 'system', server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: 'system.packages.inspect',
      operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
      payload: {},
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  });
  app.post('/api/servers/:serverId/system/upgrade', requirePanelRouteAccess, async (request, response) => {
    const server = await requireServer(request.params.serverId);
    if (request.body?.confirmation !== 'upgrade-yunpanel') {
      throw new RegistryError('upgrade_confirmation_required', 'Explicit YunPanel upgrade confirmation is required', 400);
    }
    await ensureResourceJobIdle(jobRegistry, 'system', server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: 'system.upgrade',
      operation: OPERATIONS.SYSTEM_UPGRADE,
      payload: {},
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  });

  app.get('/api/applications', requirePanelRouteAccess, async (request, response) => response.json({ data: localOnly(await applicationRegistry.listApplications()) }));
  app.get('/api/applications/:applicationId', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    return response.json({ data: application });
  });
  app.get('/api/applications/:applicationId/environment', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    return response.json({
      data: await applicationEnvironmentRegistry.listVariables(application.id),
      environment: await applicationEnvironmentRegistry.environmentStatus(application.id, { currentReleaseId: application.currentReleaseId }),
      secretStoreConfigured: applicationEnvironmentRegistry.secretStoreConfigured,
    });
  });
  app.get('/api/applications/:applicationId/environment/status', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    return response.json({
      data: await applicationEnvironmentRegistry.environmentStatus(application.id, { currentReleaseId: application.currentReleaseId }),
    });
  });
  app.post('/api/applications/:applicationId/environment/import', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    if (application.type !== 'node') throw new ApplicationRegistryError('environment_import_not_supported', 'Environment import is available only for Node applications', 409);
    await ensureEnvironmentMutable(application, jobRegistry, websiteRegistry);
    return response.json({ data: await applicationEnvironmentRegistry.importVariables({
      applicationId: application.id,
      ...environmentImportInput(request.body),
    }) });
  });
  app.get('/api/applications/:applicationId/deployment-credential', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    return response.json({
      data: await applicationEnvironmentRegistry.deploymentCredential(application.id),
      secretStoreConfigured: applicationEnvironmentRegistry.secretStoreConfigured,
    });
  });
  app.put('/api/applications/:applicationId/deployment-credential', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    await ensureEnvironmentMutable(application, jobRegistry, websiteRegistry);
    return response.json({ data: await applicationEnvironmentRegistry.setDeploymentCredential({
      applicationId: application.id,
      credential: request.body,
    }) });
  });
  app.delete('/api/applications/:applicationId/deployment-credential', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    await ensureEnvironmentMutable(application, jobRegistry, websiteRegistry);
    const confirmation = `delete-deployment-credential:${application.id}`;
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 1 || request.body.confirmation !== confirmation) {
      throw new ApplicationEnvironmentRegistryError('git_credential_confirmation_required', `Confirm credential deletion with ${confirmation}`);
    }
    await applicationEnvironmentRegistry.deleteDeploymentCredential(application.id);
    return response.status(204).end();
  });
  app.get('/api/applications/:applicationId/github-webhook', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    return response.json({
      data: await applicationEnvironmentRegistry.webhookSecret(application.id),
      secretStoreConfigured: applicationEnvironmentRegistry.secretStoreConfigured,
    });
  });
  app.put('/api/applications/:applicationId/github-webhook', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    await ensureEnvironmentMutable(application, jobRegistry, websiteRegistry);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 1 || typeof request.body.secret !== 'string') {
      throw new ApplicationEnvironmentRegistryError('invalid_github_webhook_secret', 'GitHub webhook secret request is invalid');
    }
    return response.json({ data: await applicationEnvironmentRegistry.setWebhookSecret({
      applicationId: application.id,
      secret: request.body.secret,
    }) });
  });
  app.delete('/api/applications/:applicationId/github-webhook', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    await ensureEnvironmentMutable(application, jobRegistry, websiteRegistry);
    const confirmation = `delete-github-webhook:${application.id}`;
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 1 || request.body.confirmation !== confirmation) {
      throw new ApplicationEnvironmentRegistryError('github_webhook_confirmation_required', `Confirm webhook deletion with ${confirmation}`);
    }
    await applicationEnvironmentRegistry.deleteWebhookSecret(application.id);
    return response.status(204).end();
  });
  app.put('/api/applications/:applicationId/environment/:key', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    await ensureEnvironmentMutable(application, jobRegistry, websiteRegistry);
    const variable = await applicationEnvironmentRegistry.setVariable({
      applicationId: application.id,
      key: request.params.key,
      value: request.body?.value,
      secret: request.body?.secret === true,
    });
    return response.json({ data: variable });
  });
  app.delete('/api/applications/:applicationId/environment/:key', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    await ensureEnvironmentMutable(application, jobRegistry, websiteRegistry);
    await applicationEnvironmentRegistry.deleteVariable(application.id, request.params.key);
    return response.status(204).end();
  });
  app.post('/api/applications', requirePanelRouteAccess, async (request, response) => {
    const type = request.body?.type ?? 'static';
    const requestedServerId = request.body?.serverId ?? null;
    if (localServerId !== null && requestedServerId !== null && requestedServerId !== localServerId) {
      throw new ApplicationRegistryError('local_server_required', 'Applications can be created only on this panel host', 404);
    }
    const serverId = localServerId ?? requestedServerId;
    let application;
    if (type === 'static') {
      application = await applicationRegistry.createApplication({
        serverId,
        name: request.body?.name,
        repositoryUrl: request.body?.repositoryUrl,
        branch: request.body?.branch ?? 'main',
        build: request.body?.build ?? {},
        retention: request.body?.retention ?? 5,
      });
    } else if (type === 'node') {
      application = await applicationRegistry.createNodeApplication({
        serverId,
        name: request.body?.name,
        repositoryUrl: request.body?.repositoryUrl,
        branch: request.body?.branch ?? 'main',
        runtime: request.body?.runtime,
        retention: request.body?.retention ?? 5,
      });
    } else if (type === 'python') {
      application = await applicationRegistry.createPythonApplication({
        serverId,
        name: request.body?.name,
        repositoryUrl: request.body?.repositoryUrl,
        branch: request.body?.branch ?? 'main',
        runtime: request.body?.runtime,
        retention: request.body?.retention ?? 5,
      });
    } else {
      throw new ApplicationRegistryError('invalid_application_type', 'Application type must be static, node, or python');
    }
    return response.status(201).json({ data: application });
  });
  app.post('/api/applications/:applicationId/deploy', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    const gitTarget = deploymentGitTarget(request.body, application.branch);
    const queued = await queueDeploy({ applicationId: application.id, gitTarget });
    return response.status(202).json({ data: { application: queued.application, job: queued.job } });
  });
  app.post('/api/applications/:applicationId/rollback', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    if (!['static', 'node', 'python'].includes(application.type)) throw new ApplicationRegistryError('rollback_not_supported', 'Rollback is not implemented for this application type yet', 409);
    await ensureResourceJobIdle(jobRegistry, 'application', application.id);
    await assertApplicationWebsiteIdle({ applicationId: application.id, websiteRegistry, jobRegistry, serverId: application.serverId });
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);

    const releaseId = request.body?.releaseId ?? application.previousReleaseId;
    if (!releaseId) throw new ApplicationRegistryError('rollback_release_required', 'No previous release is available for rollback', 409);

    const nodeRollback = application.type === 'node';
    const pythonRollback = application.type === 'python';
    const environment = (nodeRollback || pythonRollback) ? await applicationEnvironmentRegistry.environmentStatus(application.id) : null;
    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: pythonRollback ? 'app.python.rollback' : (nodeRollback ? 'app.node.rollback' : 'app.static.rollback'),
      operation: pythonRollback ? OPERATIONS.APP_PYTHON_ROLLBACK : (nodeRollback ? OPERATIONS.APP_NODE_ROLLBACK : OPERATIONS.APP_STATIC_ROLLBACK),
      payload: (nodeRollback || pythonRollback)
        ? {
            applicationId: application.id,
            releaseId,
            currentReleaseId: application.currentReleaseId,
            runtime: application.releases.find((release) => release.releaseId === releaseId)?.runtime
              ?? application.activeRuntime
              ?? application.runtime,
            environmentRevision: environment.savedRevision,
          }
        : {
            applicationId: application.id,
            releaseId,
            currentReleaseId: application.currentReleaseId,
          },
      resourceType: 'application',
      resourceId: application.id,
    });
    try {
      return response.status(202).json({ data: { application: await applicationRegistry.markRollingBack(application.id, job.id, releaseId), job } });
    } catch (error) {
      await jobRegistry.cancel(job.id).catch(() => {});
      throw error;
    }
  });
  app.post('/api/applications/:applicationId/restart', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    if (!['node', 'python'].includes(application.type)) throw new ApplicationRegistryError('restart_not_supported', 'Restart is only supported for Node and Python applications', 409);
    if (!application.currentReleaseId) throw new ApplicationRegistryError('application_not_deployed', 'Application has no active release to restart', 409);
    await ensureResourceJobIdle(jobRegistry, 'application', application.id);
    await assertApplicationWebsiteIdle({ applicationId: application.id, websiteRegistry, jobRegistry, serverId: application.serverId });
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);

    const environment = await applicationEnvironmentRegistry.environmentStatus(application.id);
    const isPython = application.type === 'python';
    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: isPython ? 'app.python.restart' : 'app.node.restart',
      operation: isPython ? OPERATIONS.APP_PYTHON_RESTART : OPERATIONS.APP_NODE_RESTART,
      payload: {
        applicationId: application.id,
        releaseId: application.currentReleaseId,
        runtime: application.activeRuntime ?? application.runtime,
        environmentRevision: environment.savedRevision,
        ...(!isPython && application.runtimeAdapter==='passenger'?{runtimeAdapter:'passenger'}:{}),
      },
      resourceType: 'application',
      resourceId: application.id,
    });
    return response.status(202).json({ data: job });
  });
  app.get('/api/applications/:applicationId/status', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    if (!['node', 'python'].includes(application.type)) throw new ApplicationRegistryError('status_not_supported', 'Process status is only supported for Node and Python applications', 409);
    return response.json({ data: await latestNodeStatusJob(jobRegistry, application.id) });
  });
  app.post('/api/applications/:applicationId/status/refresh', requirePanelRouteAccess, async (request, response) => {
    const application = await requireApplication(request.params.applicationId);
    if (!['node', 'python'].includes(application.type)) throw new ApplicationRegistryError('status_not_supported', 'Process status is only supported for Node and Python applications', 409);
    if (!application.currentReleaseId) throw new ApplicationRegistryError('application_not_deployed', 'Application has no active release to inspect', 409);
    await ensureResourceJobIdle(jobRegistry, 'application', application.id);
    await assertApplicationWebsiteIdle({ applicationId: application.id, websiteRegistry, jobRegistry, serverId: application.serverId });
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);

    const isPython = application.type === 'python';
    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: isPython ? 'app.python.status' : 'app.node.status',
      operation: isPython ? OPERATIONS.APP_PYTHON_STATUS : OPERATIONS.APP_NODE_STATUS,
      payload: {
        applicationId: application.id,
        releaseId: application.currentReleaseId,
        runtime: application.activeRuntime ?? application.runtime,
      },
      resourceType: 'application',
      resourceId: application.id,
    });
    return response.status(202).json({ data: job });
  });

  app.get('/api/domains', requirePanelRouteAccess, async (request, response) => {
    let domains = localOnly(await domainRegistry.listDomains());
    const role = request.auth?.user?.role;
    if (role && !['owner', 'read_only'].includes(role)) {
      const filtered = [];
      for (const domain of domains) {
        if (domain.websiteId && (await isWebsiteIdAllowedForRequest(domain.websiteId, request))) {
          filtered.push(domain);
        }
      }
      domains = filtered;
    }
    return response.json({ data: domains });
  });
  app.get('/api/domains/:domainId', requirePanelRouteAccess, async (request, response) => {
    const domain = await requireDomain(request.params.domainId, request);
    return response.json({ data: domain });
  });
  app.post('/api/domains', requirePanelRouteAccess, async (request, response) => {
    let parentDomainId = request.body?.parentDomainId ?? null;
    let websiteId = request.body?.websiteId ?? null;
    if (parentDomainId && !websiteId) {
      const parent = await domainRegistry.getDomain(parentDomainId).catch(() => null);
      if (parent?.websiteId) websiteId = parent.websiteId;
    }
    const role = request.auth?.user?.role;
    if (role && !['owner', 'read_only'].includes(role)) {
      if (!websiteId) {
        throw new DomainRegistryError('forbidden', 'Domains must be created within an assigned website', 403);
      }
      const allowed = await isWebsiteIdAllowedForRequest(websiteId, request);
      if (!allowed) {
        throw new DomainRegistryError('forbidden', 'Domains must be created within an assigned website', 403);
      }
    }
    const requestedServerId = request.body?.serverId ?? null;
    if (localServerId !== null && requestedServerId !== null && requestedServerId !== localServerId) {
      throw new DomainRegistryError('local_server_required', 'Domains can be created only on this panel host', 404);
    }
    const domain = await domainRegistry.createDomain({
      serverId: localServerId ?? requestedServerId,
      primaryDomain: request.body?.primaryDomain,
      parentDomainId,
      websiteId,
      aliases: request.body?.aliases ?? [],
      targetType: request.body?.targetType,
      target: request.body?.target,
      httpsMode: request.body?.httpsMode ?? 'off',
      httpsRedirect: request.body?.httpsRedirect,
      canonicalRedirect: request.body?.canonicalRedirect ?? false,
      nginxSettings: request.body?.nginxSettings,
    });
    return response.status(201).json({ data: domain });
  });
  // Shared by the stage/activate routes and the automation API, so both publish identically.
  async function enqueueDomainStage(domain) {
    await ensureResourceJobIdle(jobRegistry, 'domain', domain.id);
    const tls = await resolveDomainTls(domain, certificateRegistry, certificateMaterialManager, localServerId);
    const payload = {
      domainRevision: domain.desiredRevision,
      primaryDomain: domain.primaryDomain,
      aliases: domain.aliases,
      targetType: domain.targetType,
      target: domain.target,
      nginxSettings: domain.nginxSettings,
      canonicalRedirect: domain.canonicalRedirect,
      httpsRedirect: domain.httpsRedirect,
    };
    if (tls) payload.tls = tls;
    return jobRegistry.enqueue({ serverId: domain.serverId, type: 'domain.stage', operation: OPERATIONS.DOMAIN_STAGE, payload, resourceType: 'domain', resourceId: domain.id });
  }
  async function enqueueDomainActivate(domain) {
    if (domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum) throw new DomainRegistryError('staged_revision_required', 'Current desired domain revision must be staged before activation', 409);
    await ensureResourceJobIdle(jobRegistry, 'domain', domain.id);
    return jobRegistry.enqueue({
      serverId: domain.serverId,
      type: 'domain.activate',
      operation: OPERATIONS.DOMAIN_ACTIVATE,
      payload: {
        primaryDomain: domain.primaryDomain,
        previousPrimaryDomain: domain.appliedPrimaryDomain !== domain.primaryDomain ? domain.appliedPrimaryDomain : null,
        checksum: domain.stagedChecksum,
      },
      resourceType: 'domain',
      resourceId: domain.id,
    });
  }
  app.domainPublication = Object.freeze({ stage: enqueueDomainStage, activate: enqueueDomainActivate });
  app.post('/api/domains/:domainId/stage', requirePanelRouteAccess, async (request, response) => {
    const domain = await requireDomain(request.params.domainId, request);
    return response.status(202).json({ data: await enqueueDomainStage(domain) });
  });
  app.post('/api/domains/:domainId/activate', requirePanelRouteAccess, async (request, response) => {
    const domain = await requireDomain(request.params.domainId, request);
    return response.status(202).json({ data: await enqueueDomainActivate(domain) });
  });
  app.post('/api/domains/:domainId/certificates/issue', requirePanelRouteAccess, async (request, response) => {
    let domain = await requireDomain(request.params.domainId, request);
    if (domain.httpsMode !== 'managed') {
      if (typeof domainRegistry.previewDomainUpdate === 'function' && typeof domainRegistry.updateDomain === 'function') {
        try {
          const preview = await domainRegistry.previewDomainUpdate({ domainId: domain.id, changes: { httpsMode: 'managed', httpsRedirect: true } });
          await domainRegistry.updateDomain({ domainId: domain.id, changes: { httpsMode: 'managed', httpsRedirect: true }, previewDigest: preview.previewDigest });
          domain = await requireDomain(request.params.domainId, request);
        } catch {
          // If domain update cannot be performed synchronously, fall back to managed mode check
        }
      }
    }
    const intent = await resolveCertificateIssueIntent({
      body: request.body,
      domain,
      dnsHostingRegistry,
      dnsProviderCredentialRegistry,
      localServerId,
    });
    if (intent.challenge.type === 'http-01' && (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision)) {
      throw new CertificateRegistryError('http_domain_not_active', 'Current domain revision must be active before HTTP-01 certificate issuance', 409);
    }

    const certificate = await certificateRegistry.createForDomain({
      domainId: domain.id,
      serverId: domain.serverId,
      domains: [domain.primaryDomain, ...domain.aliases],
      certificateNames: intent.certificateNames,
      challenge: intent.challenge,
      email: request.body?.email,
      staging: request.body?.staging === true,
      replaceExisting: domain.certificateId === null,
    });
    try {
      const job = await jobRegistry.enqueue({
        serverId: domain.serverId,
        type: 'ssl.issue',
        operation: OPERATIONS.SSL_ISSUE,
        payload: {
          domains: certificate.certificateNames,
          email: certificate.email,
          staging: certificate.staging,
          ...(certificate.challenge.type === 'dns-01' ? { challenge: certificate.challenge } : {}),
        },
        resourceType: 'certificate',
        resourceId: certificate.id,
      });
      await certificateRegistry.setState(certificate.id, 'issuing');
      const certRecord = await certificateRegistry.getCertificate(certificate.id);
      return response.status(202).json({
        data: {
          certificate: {
            ...certificatePublicView(certRecord),
            email: certRecord?.email ?? null,
          },
          job: jobPublicView(job),
        },
      });
    } catch (error) {
      await certificateRegistry.markFailed(certificate.id, error.code ?? 'certificate_enqueue_failed');
      throw error;
    }
  });

  app.get('/api/certificates', requirePanelRouteAccess, async (request, response) => {
    let certificates = localOnly(await certificateRegistry.listCertificates());
    const user = request.auth?.user;
    const role = user?.role;
    const isScoped = (role && !['owner', 'read_only'].includes(role))
      || user?.hosting?.kind === 'reseller'
      || user?.hosting?.kind === 'customer';
    if (isScoped) {
      const domains = localOnly(await domainRegistry.listDomains());
      const allowedDomainIds = new Set();
      for (const domain of domains) {
        if (domain.websiteId && (await isWebsiteIdAllowedForRequest(domain.websiteId, request))) {
          allowedDomainIds.add(domain.id);
        }
      }
      certificates = certificates.filter((certificate) => certificate.domainId && allowedDomainIds.has(certificate.domainId));
    }
    return response.json({ data: certificates.map((certificate) => certificatePublicView(certificate)) });
  });
  app.get('/api/certificates/:certificateId', requirePanelRouteAccess, async (request, response) => {
    const certificate = await requireCertificate(request.params.certificateId, request);
    return response.json({ data: certificatePublicView(certificate) });
  });
  app.post('/api/certificates/:certificateId/renew', requirePanelRouteAccess, async (request, response) => {
    const certificate = await requireCertificate(request.params.certificateId, request);
    if (certificate.source !== 'acme' || certificate.renewalMode !== 'automatic') {
      throw new CertificateRegistryError('certificate_not_renewable', 'Only managed ACME certificates can be renewed', 409);
    }
    if (certificate.challenge?.type === 'dns-01') {
      if (!localServerId || certificate.serverId !== localServerId || !dnsProviderCredentialRegistry) {
        throw new CertificateRegistryError('local_dns_challenge_required', 'DNS certificate renewal requires this local managed Server', 409);
      }
      const credential = await dnsProviderCredentialRegistry.getForZone(certificate.challenge.dnsZoneId);
      if (!credential?.configured || credential.id !== certificate.challenge.credentialId
        || credential.provider !== certificate.challenge.provider) {
        throw new CertificateRegistryError('dns_provider_credential_required', 'The certificate DNS provider credential is unavailable', 409);
      }
    }
    if (certificate.state !== 'active') throw new CertificateRegistryError('certificate_not_active', 'Only active certificates can be renewed', 409);
    await ensureResourceJobIdle(jobRegistry, 'certificate', certificate.id);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).some((field) => field !== 'dryRun')
      || (request.body.dryRun !== undefined && typeof request.body.dryRun !== 'boolean')) {
      throw new CertificateRegistryError('invalid_certificate_renewal_request', 'Certificate renewal request fields are invalid');
    }
    const dryRun = request.body.dryRun === true;
    const job = await jobRegistry.enqueue({
      serverId: certificate.serverId,
      type: 'ssl.renew',
      operation: OPERATIONS.SSL_RENEW,
      payload: {
        certName: certificate.certName,
        dryRun,
        forceRenewal: !dryRun,
        ...(certificate.challenge?.type === 'dns-01' ? { challenge: certificate.challenge } : {}),
      },
      resourceType: 'certificate',
      resourceId: certificate.id,
    });
    if (!dryRun) await certificateRegistry.setState(certificate.id, 'renewing');
    return response.status(202).json({ data: jobPublicView(job) });
  });

  app.get('/api/jobs', requirePanelRouteAccess, async (request, response) => {
    await Promise.allSettled(reconciliationJobs.values());
    if (localServerId !== null && request.query.serverId && request.query.serverId !== localServerId) {
      throw new JobRegistryError('local_server_required', 'Jobs can be listed only for this panel host', 404);
    }
    const jobs = await jobRegistry.listJobs({
      serverId: localServerId ?? request.query.serverId ?? null,
      resourceType: request.query.resourceType || null,
      resourceId: request.query.resourceId || null,
      status: request.query.status || null,
    });
    return response.json({ data: localOnly(jobs).map(jobPublicView) });
  });
  app.get('/api/jobs/:jobId', requirePanelRouteAccess, async (request, response) => {
    await reconciliationJobs.get(request.params.jobId)?.catch(() => {});
    const job = await requireJob(request.params.jobId);
    return response.json({ data: jobPublicView(job) });
  });
  app.post('/api/jobs/:jobId/cancel', requirePanelRouteAccess, async (request, response) => {
    await requireJob(request.params.jobId);
    const job = await jobRegistry.cancel(request.params.jobId);
    if (job.resourceType === 'application') {
      const application = await applicationRegistry.getApplication(job.resourceId);
      if (application?.activeDeploymentId === job.id) await applicationRegistry.markFailed(job.resourceId, job.id, 'operation_cancelled');
    }
    return response.json({ data: jobPublicView(job) });
  });

  // Deployment version, diagnostics and cache freshness endpoints (PROD-10)
  app.get(
    ['/api/system/diagnostics/version', '/api/diagnostics/deployment', '/api/diagnostics/version'],
    requireDeploymentDiagnosticsAccess,
    (request, response) => {
      const deployment = resolveAppDeploymentDiagnostics();
      const rawFrontendCommit = request.query.frontendCommit ?? request.query.commit;
      const rawFrontendBuildTime = request.query.frontendBuildTime ?? request.query.buildTime;
      const frontendQuery = {
        version: request.query.frontendVersion || request.query.version || undefined,
        buildId: request.query.frontendBuildId || request.query.buildId || undefined,
        assetId: request.query.frontendAssetId || request.query.assetId || undefined,
        schemaVersion: request.query.frontendSchemaVersion || request.query.schemaVersion || undefined,
        commit: typeof rawFrontendCommit === 'string' && rawFrontendCommit.trim() ? rawFrontendCommit.trim() : undefined,
        buildTime: typeof rawFrontendBuildTime === 'string' && rawFrontendBuildTime.trim() ? rawFrontendBuildTime.trim() : undefined,
        dirty: parseOptionalBooleanParam(request.query.frontendDirty ?? request.query.dirty),
        buildVerified: parseOptionalBooleanParam(request.query.frontendBuildVerified ?? request.query.buildVerified),
      };

      const hasFrontendInfo = Object.values(frontendQuery).some((v) => v !== undefined);
      const comparison = hasFrontendInfo ? compareDeploymentVersions(deployment, frontendQuery) : null;
      const freshness = evaluateFreshnessState({
        lastCheckedAt: deployment.lastCheckedAt,
        staleThresholdMs: Number(request.query.staleThresholdMs) || DEFAULT_STALE_THRESHOLD_MS,
      });

      return response.json({
        data: {
          ...deployment,
          comparison,
          freshness,
        },
      });
    },
  );

  app.post(
    ['/api/system/diagnostics/version/compare', '/api/diagnostics/deployment/compare'],
    requireDeploymentDiagnosticsAccess,
    (request, response) => {
      const deployment = resolveAppDeploymentDiagnostics();
      const frontend = request.body || {};
      const comparison = compareDeploymentVersions(deployment, frontend);
      const freshness = evaluateFreshnessState({
        lastCheckedAt: request.body?.lastCheckedAt || deployment.lastCheckedAt,
        staleThresholdMs: Number(request.body?.staleThresholdMs) || DEFAULT_STALE_THRESHOLD_MS,
      });

      return response.json({
        data: {
          ...deployment,
          comparison,
          freshness,
        },
      });
    },
  );

  app.use((request, response) => response.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof DurableJobRegistryError) {
      return response.status(503).json({ error: { code: error.code, message: error.message } });
    }
    if (
      error instanceof RegistryError
      || error instanceof DomainRegistryError
      || error instanceof JobRegistryError
      || error instanceof JobReconciliationError
      || error instanceof CertificateRegistryError
      || error instanceof ApplicationRegistryError
      || error instanceof ApplicationEnvironmentRegistryError
    ) {
      return response.status(error.status ?? 409).json({ error: { code: error.code, message: error.message } });
    }
    const isJsonSyntaxError = error instanceof SyntaxError && error.status === 400;
    return response.status(isJsonSyntaxError ? 400 : 500).json({
      error: {
        code: isJsonSyntaxError ? 'invalid_json' : 'internal_error',
        message: isJsonSyntaxError ? 'Invalid JSON body' : 'Unexpected server error',
      },
    });
  });

  return app;
}
