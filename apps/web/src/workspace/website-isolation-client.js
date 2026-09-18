import { panelRequest } from '../api.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function websiteId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('website id is invalid');
  return value.toLowerCase();
}


function applicationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('application id is invalid');
  return value.toLowerCase();
}

export function getPassengerMigrationPreview(id, { signal } = {}) {
  const normalized = applicationId(id);
  return panelRequest(`/applications/${encodeURIComponent(normalized)}/passenger-migration-preview`, { signal });
}

export function applyPassengerMigration(id, preview, { signal } = {}) {
  const normalized = applicationId(id);
  if (!preview || preview.ready !== true
    || typeof preview.previewDigest !== 'string' || !SHA256_PATTERN.test(preview.previewDigest)
    || typeof preview.confirmation !== 'string' || preview.confirmation.length < 1) {
    throw new Error('Current Passenger migration preview is required');
  }
  return panelRequest(`/applications/${encodeURIComponent(normalized)}/passenger-migration`, {
    method: 'POST',
    signal,
    body: {
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
}

export function getWebsiteIsolationAudit(id, { signal } = {}) {
  const normalized = websiteId(id);
  return panelRequest(`/websites/${encodeURIComponent(normalized)}/isolation-audit`, { signal });
}

export function listWebsiteIsolationMigrations(id, { signal } = {}) {
  const normalized = websiteId(id);
  return panelRequest(`/websites/${encodeURIComponent(normalized)}/isolation-migrations`, { signal });
}

export function applyWebsiteIsolationMigration(id, migration, { signal } = {}) {
  const normalized = websiteId(id);
  if (migration?.applyAvailable !== true
    || typeof migration.previewDigest !== 'string' || !SHA256_PATTERN.test(migration.previewDigest)
    || typeof migration.confirmation !== 'string' || migration.confirmation.length < 1) {
    throw new Error('Current Website isolation migration preview is required');
  }
  return panelRequest(`/websites/${encodeURIComponent(normalized)}/isolation-migrations`, {
    method: 'POST',
    signal,
    body: {
      expectedPreviewDigest: migration.previewDigest,
      confirmation: migration.confirmation,
    },
  });
}

export function websiteIsolationRollbackConfirmation(operation) {
  const id = websiteId(operation?.id);
  if (typeof operation?.previewDigest !== 'string' || !SHA256_PATTERN.test(operation.previewDigest)) {
    throw new Error('Website isolation migration operation is invalid');
  }
  return `rollback-isolation-migration:${id}:${operation.previewDigest}`;
}

export function rollbackWebsiteIsolationMigration(id, operation, { signal } = {}) {
  const normalized = websiteId(id);
  if (websiteId(operation?.websiteId) !== normalized) throw new Error('Website isolation migration scope is invalid');
  const operationId = websiteId(operation?.id);
  return panelRequest(`/websites/${encodeURIComponent(normalized)}/isolation-migrations/${encodeURIComponent(operationId)}/rollback`, {
    method: 'POST',
    signal,
    body: { confirmation: websiteIsolationRollbackConfirmation(operation) },
  });
}

export const websiteIsolationClientInternals = Object.freeze({ websiteId, applicationId, sha256Pattern: SHA256_PATTERN });
