import { panelRequest } from '../api.js';

function serverDnsPath(serverId, suffix = '') {
  if (typeof serverId !== 'string' || !serverId) throw new Error('serverId is required');
  return `/servers/${encodeURIComponent(serverId)}/dns${suffix}`;
}

export function getServerDnsIdentity(serverId) {
  return panelRequest(serverDnsPath(serverId, '/identity'));
}

export function previewServerDnsIdentity(serverId, settings) {
  return panelRequest(serverDnsPath(serverId, '/identity/preview'), { method: 'POST', body: { settings } });
}

export function applyServerDnsIdentity(serverId, preview) {
  if (!preview || !Number.isSafeInteger(preview.currentRevision) || !preview.previewDigest || !preview.confirmation || !preview.settings) {
    throw new Error('Current server DNS identity preview is required');
  }
  return panelRequest(serverDnsPath(serverId, '/identity/apply'), {
    method: 'POST',
    body: {
      expectedRevision: preview.currentRevision,
      settings: preview.settings,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
}

export function getPowerDnsAuthoritative(serverId) {
  return panelRequest(serverDnsPath(serverId, '/authoritative'));
}

export function previewPowerDnsAuthoritative(serverId) {
  return panelRequest(serverDnsPath(serverId, '/authoritative/preview'), { method: 'POST', body: {} });
}

export function applyPowerDnsAuthoritative(serverId, preview) {
  if (!preview?.previewDigest || !preview?.confirmation) throw new Error('Current PowerDNS preview is required');
  return panelRequest(serverDnsPath(serverId, '/authoritative/apply'), {
    method: 'POST',
    body: { previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
}

export function inspectDnsDelegation(serverId, domain) {
  if (typeof domain !== 'string' || !domain.trim()) throw new Error('Delegation domain is required');
  return panelRequest(`${serverDnsPath(serverId, '/delegation')}?domain=${encodeURIComponent(domain.trim())}`);
}

export const networkDnsClientInternals = Object.freeze({ serverDnsPath });
