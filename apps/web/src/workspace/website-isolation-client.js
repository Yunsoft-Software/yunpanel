import { panelRequest } from '../api.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function websiteId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('website id is invalid');
  return value.toLowerCase();
}

export function getWebsiteIsolationAudit(id, { signal } = {}) {
  const normalized = websiteId(id);
  return panelRequest(`/websites/${encodeURIComponent(normalized)}/isolation-audit`, { signal });
}

export const websiteIsolationClientInternals = Object.freeze({ websiteId });
