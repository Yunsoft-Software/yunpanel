import { panelRequest } from '../api.js';

function domainDnsPath(domainId, suffix = '') {
  if (typeof domainId !== 'string' || !domainId) throw new Error('domainId is required');
  return `/domains/${encodeURIComponent(domainId)}/dns${suffix}`;
}

function operationPath(domainId, kind, operationId) {
  if (typeof operationId !== 'string' || !operationId) throw new Error('operationId is required');
  const collection = kind === 'reapply' ? '/reapply-operations' : kind === 'dnssec' ? '/dnssec/operations' : null;
  if (!collection) throw new Error('Unsupported DNS operation kind');
  return `${domainDnsPath(domainId, collection)}/${encodeURIComponent(operationId)}`;
}

export function getDnsZone(domainId) {
  return panelRequest(domainDnsPath(domainId, '/zone'));
}

export function getDnsSecondaryStatus(domainId) {
  return panelRequest(domainDnsPath(domainId, '/secondary'));
}

export function saveManualDnsRecord(domainId, input) {
  return panelRequest(domainDnsPath(domainId, '/records'), { method: 'POST', body: input });
}

export function deleteManualDnsRecord(domainId, input) {
  return panelRequest(domainDnsPath(domainId, '/records/delete'), { method: 'POST', body: input });
}

export function previewDnsReapply(domainId) {
  return panelRequest(domainDnsPath(domainId, '/reapply-preview'), { method: 'POST', body: {} });
}

export function applyDnsReapply(domainId, preview) {
  if (!preview?.previewDigest || !preview?.confirmation) throw new Error('Current DNS reapply preview is required');
  return panelRequest(domainDnsPath(domainId, '/reapply'), {
    method: 'POST',
    body: { previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
}

export function listDnsReapplyOperations(domainId) {
  return panelRequest(domainDnsPath(domainId, '/reapply-operations'));
}

export function getDnsReapplyOperation(domainId, operationId) {
  return panelRequest(operationPath(domainId, 'reapply', operationId));
}

export function getDnssecStatus(domainId) {
  return panelRequest(domainDnsPath(domainId, '/dnssec'));
}

export function previewDnssec(domainId, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('DNSSEC target must be boolean');
  return panelRequest(domainDnsPath(domainId, '/dnssec/preview'), { method: 'POST', body: { enabled } });
}

export function applyDnssec(domainId, preview) {
  if (typeof preview?.targetEnabled !== 'boolean' || !preview?.previewDigest || !preview?.confirmation) {
    throw new Error('Current DNSSEC preview is required');
  }
  return panelRequest(domainDnsPath(domainId, '/dnssec/apply'), {
    method: 'POST',
    body: {
      enabled: preview.targetEnabled,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
}

export function listDnssecOperations(domainId) {
  return panelRequest(domainDnsPath(domainId, '/dnssec/operations'));
}

export function getDnssecOperation(domainId, operationId) {
  return panelRequest(operationPath(domainId, 'dnssec', operationId));
}

export async function waitForDnsOperation({ domainId, kind, operation, attempts = 90, intervalMs = 1000, signal } = {}) {
  if (!operation || typeof operation.id !== 'string') throw new Error('DNS operation is invalid');
  const getter = kind === 'reapply' ? getDnsReapplyOperation : kind === 'dnssec' ? getDnssecOperation : null;
  if (!getter) throw new Error('Unsupported DNS operation kind');
  let current = operation;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!['pending', 'applying'].includes(current.status)) return current;
    if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The request was aborted.', 'AbortError'));
      }, { once: true });
    });
    current = await getter(domainId, current.id);
  }
  const error = new Error('DNS operation is still applying. Refresh the operation status before retrying.');
  error.code = 'dns_operation_timeout';
  throw error;
}

export const dnsClientInternals = Object.freeze({ domainDnsPath, operationPath });
