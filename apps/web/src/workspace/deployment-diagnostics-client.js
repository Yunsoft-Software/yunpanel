export const FRONTEND_VERSION = '0.3.0';
export const FRONTEND_SCHEMA_VERSION = 3;

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i;
const BUILD_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{3,128}$/;

function normalizeBuildToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown' || !BUILD_TOKEN_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeCommitHash(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === 'unknown' || !COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeBuildTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function resolveFrontendBuildIdentity(rawInfo) {
  let parsed = rawInfo;
  if (typeof rawInfo === 'string') {
    try {
      parsed = JSON.parse(rawInfo);
    } catch {
      parsed = null;
    }
  }

  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.dirty === true
    || parsed.buildVerified !== true
  ) {
    return {
      version: FRONTEND_VERSION,
      schemaVersion: FRONTEND_SCHEMA_VERSION,
      buildId: 'unknown',
      assetId: 'unknown',
      commit: 'unknown',
      buildTime: null,
      dirty: Boolean(parsed?.dirty),
      buildVerified: false,
    };
  }

  const buildId = normalizeBuildToken(parsed.buildId);
  const assetId = normalizeBuildToken(parsed.assetId);
  const commit = normalizeCommitHash(parsed.commit);
  const buildTime = normalizeBuildTime(parsed.buildTime);

  if (!buildId || !assetId || !commit || !buildTime) {
    return {
      version: FRONTEND_VERSION,
      schemaVersion: FRONTEND_SCHEMA_VERSION,
      buildId: 'unknown',
      assetId: 'unknown',
      commit: 'unknown',
      buildTime: null,
      dirty: false,
      buildVerified: false,
    };
  }

  return {
    version: typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : FRONTEND_VERSION,
    schemaVersion: Number.isInteger(Number(parsed.schemaVersion)) && Number(parsed.schemaVersion) > 0
      ? Number(parsed.schemaVersion)
      : FRONTEND_SCHEMA_VERSION,
    buildId,
    assetId,
    commit,
    buildTime,
    dirty: false,
    buildVerified: true,
  };
}

const injectedBuildInfo = typeof __YUNPANEL_FRONTEND_BUILD_INFO__ !== 'undefined'
  ? __YUNPANEL_FRONTEND_BUILD_INFO__
  : undefined;

const resolvedFrontendIdentity = resolveFrontendBuildIdentity(injectedBuildInfo);

export const FRONTEND_BUILD_ID = resolvedFrontendIdentity.buildId;
export const FRONTEND_ASSET_ID = resolvedFrontendIdentity.assetId;
export const FRONTEND_COMMIT = resolvedFrontendIdentity.commit;
export const FRONTEND_BUILD_TIME = resolvedFrontendIdentity.buildTime;
export const FRONTEND_DIRTY = resolvedFrontendIdentity.dirty;
export const FRONTEND_BUILD_VERIFIED = resolvedFrontendIdentity.buildVerified;

export async function fetchDeploymentDiagnostics({
  endpoint = '/api/panel/system/diagnostics/version',
  includeFrontendComparison = true,
  frontendIdentity = null,
  headers = {},
  fetchFn = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : globalThis.fetch,
} = {}) {
  const baseOrigin = (typeof window !== 'undefined' && window.location?.origin)
    ? window.location.origin
    : 'http://localhost';
  const url = new URL(endpoint, baseOrigin);
  if (includeFrontendComparison) {
    const identity = frontendIdentity
      ? resolveFrontendBuildIdentity(frontendIdentity)
      : resolvedFrontendIdentity;
    url.searchParams.set('frontendVersion', identity.version);
    url.searchParams.set('frontendBuildId', identity.buildId);
    url.searchParams.set('frontendAssetId', identity.assetId);
    url.searchParams.set('frontendSchemaVersion', String(identity.schemaVersion));
    url.searchParams.set('frontendCommit', identity.commit);
    url.searchParams.set('frontendBuildTime', identity.buildTime ?? '');
    url.searchParams.set('frontendDirty', String(Boolean(identity.dirty)));
    url.searchParams.set('frontendBuildVerified', String(Boolean(identity.buildVerified)));
  }
  const res = await fetchFn(url.toString(), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...headers },
  });
  if (!res.ok) {
    throw new Error(`Tanılama bilgisi alınamadı (HTTP ${res.status}).`);
  }
  const json = await res.json();
  return json.data ?? json;
}

export async function compareDeploymentWithServer(frontendInfo, {
  endpoint = '/api/panel/system/diagnostics/version/compare',
  csrfToken = null,
  headers = {},
  fetchFn = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : globalThis.fetch,
} = {}) {
  const payload = frontendInfo && typeof frontendInfo === 'object'
    ? {
      ...frontendInfo,
      version: frontendInfo.version ?? FRONTEND_VERSION,
      schemaVersion: frontendInfo.schemaVersion ?? FRONTEND_SCHEMA_VERSION,
      buildId: frontendInfo.buildId ?? 'unknown',
      assetId: frontendInfo.assetId ?? 'unknown',
      commit: frontendInfo.commit ?? 'unknown',
      buildTime: frontendInfo.buildTime ?? null,
      dirty: Boolean(frontendInfo.dirty),
      buildVerified: frontendInfo.buildVerified === true,
    }
    : { ...resolvedFrontendIdentity };

  const requestHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...headers,
  };
  if (csrfToken) {
    requestHeaders['x-csrf-token'] = csrfToken;
  }
  const res = await fetchFn(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: requestHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Sürüm karşılaştırması alınamadı (HTTP ${res.status}).`);
  }
  const json = await res.json();
  return json.data ?? json;
}
