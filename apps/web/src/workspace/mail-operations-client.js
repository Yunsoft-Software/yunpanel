import { panelRequest } from '../api.js';

function requiredId(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
  return value;
}

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : '';
}

export function getRoundcubePreview() {
  return panelRequest('/roundcube/config-preview');
}

export function prepareRoundcube() {
  return panelRequest('/roundcube/config-prepare', { method: 'POST', body: {} });
}

export function applyRoundcube(preview) {
  if (!preview?.readyToApply || typeof preview.sha256 !== 'string'
    || typeof preview.configuration?.sha256 !== 'string' || typeof preview.fpm?.sha256 !== 'string') {
    throw new Error('Current Roundcube preview is required');
  }
  return panelRequest('/roundcube/config-apply', {
    method: 'POST',
    body: {
      previewSha256: preview.sha256,
      configSha256: preview.configuration.sha256,
      fpmSha256: preview.fpm.sha256,
    },
  });
}

export function getMailQueue(serverId, { limit = 100, search = '', queue = '' } = {}) {
  requiredId(serverId, 'serverId');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit is invalid');
  return panelRequest(`/servers/${encodeURIComponent(serverId)}/mail/queue${queryString({ limit, q: search, queue })}`);
}

export function getMailServiceLogs(serverId, serviceId, { limit = 100, search = '' } = {}) {
  requiredId(serverId, 'serverId');
  if (!['postfix', 'dovecot', 'rspamd'].includes(serviceId)) throw new Error('Unsupported mail log service');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit is invalid');
  return panelRequest(`/servers/${encodeURIComponent(serverId)}/logs/${serviceId}${queryString({ limit, q: search })}`);
}

export const mailOperationsClientInternals = Object.freeze({ requiredId, queryString });
