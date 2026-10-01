export const FRONTEND_BUILD_ID = 'build-web-20261001-0300';
export const FRONTEND_ASSET_ID = 'assets-web-20261001-0300';
export const FRONTEND_VERSION = '0.3.0';
export const FRONTEND_SCHEMA_VERSION = 3;

export async function fetchDeploymentDiagnostics({
  endpoint = '/api/system/diagnostics/version',
  includeFrontendComparison = true,
  fetchFn = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : globalThis.fetch,
} = {}) {
  const url = new URL(endpoint, (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : 'http://localhost');
  if (includeFrontendComparison) {
    url.searchParams.set('frontendVersion', FRONTEND_VERSION);
    url.searchParams.set('frontendBuildId', FRONTEND_BUILD_ID);
    url.searchParams.set('frontendAssetId', FRONTEND_ASSET_ID);
    url.searchParams.set('frontendSchemaVersion', String(FRONTEND_SCHEMA_VERSION));
  }
  const res = await fetchFn(url.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Diagnostics request failed with status ${res.status}`);
  }
  const json = await res.json();
  return json.data ?? json;
}

export async function compareDeploymentWithServer(frontendInfo, {
  endpoint = '/api/system/diagnostics/version/compare',
  fetchFn = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : globalThis.fetch,
} = {}) {
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(frontendInfo),
  });
  if (!res.ok) {
    throw new Error(`Comparison request failed with status ${res.status}`);
  }
  const json = await res.json();
  return json.data ?? json;
}
