import { panelRequest } from '../api.js';

function requiredId(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
  return value;
}

function positiveRevision(value, field = 'expectedRevision', { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} is invalid`);
  return value;
}

function mailDomainPath(mailDomainId) {
  return `/mail-domains/${encodeURIComponent(requiredId(mailDomainId, 'mailDomainId'))}`;
}

function mailboxPath(mailboxId) {
  return `/mailboxes/${encodeURIComponent(requiredId(mailboxId, 'mailboxId'))}`;
}

function aliasPath(mailAliasId) {
  return `/mail-aliases/${encodeURIComponent(requiredId(mailAliasId, 'mailAliasId'))}`;
}

export function listMailDomains() {
  return panelRequest('/mail-domains');
}

export function getMailDomain(mailDomainId) {
  return panelRequest(mailDomainPath(mailDomainId));
}

export function createMailDomain({ name, webDomainId, managementMode = 'local' } = {}) {
  if (typeof name !== 'string' || !name) throw new Error('name is required');
  if (webDomainId !== null && (typeof webDomainId !== 'string' || !webDomainId)) throw new Error('webDomainId is invalid');
  if (!['local', 'external'].includes(managementMode)) throw new Error('managementMode is invalid');
  return panelRequest('/mail-domains', { method: 'POST', body: { name, webDomainId, managementMode } });
}

export function previewMailConfiguration(mailDomainId, { expectedRevision, status } = {}) {
  positiveRevision(expectedRevision);
  if (!['enabled', 'disabled'].includes(status)) throw new Error('status is invalid');
  return panelRequest(`${mailDomainPath(mailDomainId)}/config-preview`, {
    method: 'POST', body: { expectedRevision, status },
  });
}

export function applyMailConfiguration(mailDomainId, { expectedRevision, status, preview } = {}) {
  positiveRevision(expectedRevision);
  if (!['enabled', 'disabled'].includes(status)) throw new Error('status is invalid');
  if (!preview || typeof preview.previewDigest !== 'string'
    || typeof preview.configuration?.sha256 !== 'string' || typeof preview.confirmation !== 'string') {
    throw new Error('Current mail configuration preview is required');
  }
  return panelRequest(`${mailDomainPath(mailDomainId)}/config-apply`, {
    method: 'POST',
    body: {
      expectedRevision,
      status,
      previewDigest: preview.previewDigest,
      configurationSha256: preview.configuration.sha256,
      confirmation: preview.confirmation,
    },
  });
}

export function listMailboxes(mailDomainId = null) {
  const query = mailDomainId ? `?mailDomainId=${encodeURIComponent(mailDomainId)}` : '';
  return panelRequest(`/mailboxes${query}`);
}

export function getMailbox(mailboxId) {
  return panelRequest(mailboxPath(mailboxId));
}

export function createMailbox({ mailDomainId, address, password } = {}) {
  requiredId(mailDomainId, 'mailDomainId');
  if (typeof address !== 'string' || !address) throw new Error('address is required');
  if (typeof password !== 'string' || !password) throw new Error('password is required');
  return panelRequest('/mailboxes', { method: 'POST', body: { mailDomainId, address, password } });
}

export function setMailboxEnabled(mailboxId, { expectedRevision, enabled } = {}) {
  positiveRevision(expectedRevision);
  if (typeof enabled !== 'boolean') throw new Error('enabled is invalid');
  return panelRequest(mailboxPath(mailboxId), { method: 'PATCH', body: { expectedRevision, enabled } });
}

export function rotateMailboxPassword(mailboxId, { expectedRevision, password } = {}) {
  positiveRevision(expectedRevision);
  if (typeof password !== 'string' || !password) throw new Error('password is required');
  return panelRequest(`${mailboxPath(mailboxId)}/password`, { method: 'POST', body: { expectedRevision, password } });
}

export function getMailboxQuota(mailboxId) {
  return panelRequest(`${mailboxPath(mailboxId)}/quota`);
}

export function getMailboxUsage(mailboxId) {
  return panelRequest(`${mailboxPath(mailboxId)}/usage`);
}

export function setMailboxQuota(mailboxId, { expectedRevision, quotaBytes } = {}) {
  positiveRevision(expectedRevision, 'expectedRevision', { allowZero: true });
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error('quotaBytes is invalid');
  return panelRequest(`${mailboxPath(mailboxId)}/quota`, { method: 'PUT', body: { expectedRevision, quotaBytes } });
}

export function clearMailboxQuota(mailboxId, { expectedRevision } = {}) {
  positiveRevision(expectedRevision);
  return panelRequest(`${mailboxPath(mailboxId)}/quota`, {
    method: 'DELETE',
    body: { expectedRevision, confirmation: `clear-mailbox-quota:${mailboxId}` },
  });
}

export function getMailboxForwarding(mailboxId) {
  return panelRequest(`${mailboxPath(mailboxId)}/forwarding`);
}

export function setMailboxForwarding(mailboxId, {
  expectedRevision,
  mode,
  destinations,
  enabled = true,
} = {}) {
  positiveRevision(expectedRevision, 'expectedRevision', { allowZero: true });
  if (!['copy', 'redirect'].includes(mode)) throw new Error('forwarding mode is invalid');
  if (!Array.isArray(destinations) || destinations.length < 1) throw new Error('forwarding destinations are required');
  if (typeof enabled !== 'boolean') throw new Error('enabled is invalid');
  return panelRequest(`${mailboxPath(mailboxId)}/forwarding`, {
    method: 'PUT', body: { expectedRevision, mode, destinations, enabled },
  });
}

export function clearMailboxForwarding(mailboxId, { expectedRevision } = {}) {
  positiveRevision(expectedRevision);
  return panelRequest(`${mailboxPath(mailboxId)}/forwarding`, {
    method: 'DELETE',
    body: { expectedRevision, confirmation: `clear-mailbox-forwarding:${mailboxId}` },
  });
}

export function listMailAliases(mailDomainId = null) {
  const query = mailDomainId ? `?mailDomainId=${encodeURIComponent(mailDomainId)}` : '';
  return panelRequest(`/mail-aliases${query}`);
}

export function createMailAlias({ mailDomainId, source, destinations } = {}) {
  requiredId(mailDomainId, 'mailDomainId');
  if (typeof source !== 'string' || !source || !Array.isArray(destinations) || destinations.length < 1) {
    throw new Error('mail alias input is invalid');
  }
  return panelRequest('/mail-aliases', { method: 'POST', body: { mailDomainId, source, destinations } });
}

export function updateMailAlias(mailAliasId, { expectedRevision, destinations, enabled } = {}) {
  positiveRevision(expectedRevision);
  if (!Array.isArray(destinations) || destinations.length < 1 || typeof enabled !== 'boolean') {
    throw new Error('mail alias update is invalid');
  }
  return panelRequest(aliasPath(mailAliasId), {
    method: 'PATCH', body: { expectedRevision, destinations, enabled },
  });
}

export function deleteMailAlias(mailAliasId, { expectedRevision, source } = {}) {
  positiveRevision(expectedRevision);
  if (typeof source !== 'string' || !source) throw new Error('mail alias source is required');
  return panelRequest(aliasPath(mailAliasId), {
    method: 'DELETE', body: { expectedRevision, confirmation: `delete-mail-alias:${source}` },
  });
}

export function getMailDiagnostics(mailDomainId) {
  return panelRequest(`${mailDomainPath(mailDomainId)}/diagnostics`);
}

export function getMailDkim(mailDomainId) {
  return panelRequest(`${mailDomainPath(mailDomainId)}/dkim`);
}

export function createMailDkim(mailDomainId, { expectedRevision, selector } = {}) {
  positiveRevision(expectedRevision, 'expectedRevision', { allowZero: true });
  if (typeof selector !== 'string' || !selector) throw new Error('selector is required');
  return panelRequest(`${mailDomainPath(mailDomainId)}/dkim`, {
    method: 'POST', body: { expectedRevision, selector },
  });
}

export function rotateMailDkim(mailDomainId, { expectedRevision, selector } = {}) {
  positiveRevision(expectedRevision);
  if (typeof selector !== 'string' || !selector) throw new Error('selector is required');
  return panelRequest(`${mailDomainPath(mailDomainId)}/dkim/rotate`, {
    method: 'POST', body: { expectedRevision, selector },
  });
}

export function getMailDkimRetirement(mailDomainId) {
  return panelRequest(`${mailDomainPath(mailDomainId)}/dkim/retirement`);
}

export function previewMailDkimApply(mailDomainId, { expectedKeyRevision } = {}) {
  positiveRevision(expectedKeyRevision, 'expectedKeyRevision', { allowZero: true });
  return panelRequest(`${mailDomainPath(mailDomainId)}/dkim/config-preview`, {
    method: 'POST', body: { expectedKeyRevision },
  });
}

export function applyMailDkim(mailDomainId, { expectedKeyRevision, preview } = {}) {
  positiveRevision(expectedKeyRevision, 'expectedKeyRevision', { allowZero: true });
  if (!preview || typeof preview.previewDigest !== 'string'
    || typeof preview.configuration?.sha256 !== 'string' || typeof preview.confirmation !== 'string') {
    throw new Error('Current DKIM configuration preview is required');
  }
  return panelRequest(`${mailDomainPath(mailDomainId)}/dkim/config-apply`, {
    method: 'POST',
    body: {
      expectedKeyRevision,
      previewDigest: preview.previewDigest,
      configurationSha256: preview.configuration.sha256,
      confirmation: preview.confirmation,
    },
  });
}

export const mailClientInternals = Object.freeze({ requiredId, positiveRevision, mailDomainPath, mailboxPath, aliasPath });
