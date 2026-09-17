import { requestJson } from './session-client.js';

const MANAGEMENT_ROOT = '/api/panel';

export function panelRequest(path, options = {}) {
  return requestJson(`${MANAGEMENT_ROOT}${path}`, options);
}

function managedServiceServerPath(serverId) {
  if (typeof serverId !== 'string' || !serverId) throw new Error('serverId is required');
  return `/servers/${encodeURIComponent(serverId)}/services`;
}

function managedServicePath(serverId, serviceId) {
  if (typeof serviceId !== 'string' || !serviceId) throw new Error('serviceId is required');
  return `${managedServiceServerPath(serverId)}/${encodeURIComponent(serviceId)}`;
}

export function getManagedServices(serverId) {
  return panelRequest(managedServiceServerPath(serverId));
}

export function inspectManagedServices(serverId) {
  return panelRequest(`${managedServiceServerPath(serverId)}/inspect`, { method: 'POST', body: {} });
}

export function installManagedService(serverId, serviceId) {
  return panelRequest(`${managedServicePath(serverId, serviceId)}/install`, {
    method: 'POST',
    body: { confirmation: `install:${serviceId}` },
  });
}

export function controlManagedService(serverId, serviceId, action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unsupported managed service action');
  return panelRequest(`${managedServicePath(serverId, serviceId)}/control`, {
    method: 'POST',
    body: { action, confirmation: `control:${serviceId}:${action}` },
  });
}

function databaseServerPath(serverId) {
  if (typeof serverId !== 'string' || !serverId) throw new Error('serverId is required');
  return `/servers/${encodeURIComponent(serverId)}/databases`;
}

function databasePath(serverId, name) {
  if (typeof name !== 'string' || !name) throw new Error('database name is required');
  return `${databaseServerPath(serverId)}/${encodeURIComponent(name)}`;
}

function databaseCredentialPath(serverId, credentialId) {
  databaseServerPath(serverId);
  if (typeof credentialId !== 'string' || !credentialId) throw new Error('credentialId is required');
  return `/servers/${encodeURIComponent(serverId)}/database-credentials/${encodeURIComponent(credentialId)}`;
}

function positiveRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

export function getDatabases(serverId) {
  return panelRequest(databaseServerPath(serverId));
}

export function getWebsiteDatabaseResources(serverId, websiteId) {
  databaseServerPath(serverId);
  if (typeof websiteId !== 'string' || !websiteId) throw new Error('websiteId is required');
  return panelRequest(`/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-resources`);
}

export function createPhpMyAdminHandoff(serverId, websiteId, credentialId) {
  databaseServerPath(serverId);
  if (typeof websiteId !== 'string' || !websiteId) throw new Error('websiteId is required');
  if (typeof credentialId !== 'string' || !credentialId) throw new Error('credentialId is required');
  return panelRequest(
    `/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/phpmyadmin-handoffs`,
    { method: 'POST', body: { credentialId } },
  );
}

export function rotateDatabaseCredential(serverId, credentialId, expectedRevision) {
  const path = databaseCredentialPath(serverId, credentialId);
  const revision = positiveRevision(expectedRevision, 'expectedRevision');
  return panelRequest(`${path}/password/rotate`, {
    method: 'POST',
    body: {
      expectedRevision: revision,
      confirmation: `rotate-database-password:${credentialId}:${revision}`,
    },
  });
}

export function previewDatabaseCredentialApply(serverId, credentialId) {
  return panelRequest(`${databaseCredentialPath(serverId, credentialId)}/apply-preview`);
}

export function applyDatabaseCredential(serverId, credentialId, preview) {
  const path = databaseCredentialPath(serverId, credentialId);
  if (!preview || typeof preview !== 'object') throw new Error('credential apply preview is required');
  return panelRequest(`${path}/apply`, {
    method: 'POST',
    body: {
      expectedCredentialRevision: positiveRevision(preview.expectedCredentialRevision, 'expectedCredentialRevision'),
      expectedBindingRevision: positiveRevision(preview.expectedBindingRevision, 'expectedBindingRevision'),
      expectedDesiredStateSha256: preview.desiredStateSha256,
      confirmation: preview.confirmation,
    },
  });
}

export function previewDatabaseCredentialDelete(serverId, credentialId) {
  return panelRequest(`${databaseCredentialPath(serverId, credentialId)}/delete-preview`);
}

export function queueDatabaseCredentialDelete(serverId, credentialId, preview) {
  const path = databaseCredentialPath(serverId, credentialId);
  if (!preview || typeof preview !== 'object') throw new Error('credential delete preview is required');
  return panelRequest(`${path}/delete`, {
    method: 'POST',
    body: {
      expectedCredentialRevision: positiveRevision(preview.expectedCredentialRevision, 'expectedCredentialRevision'),
      expectedBindingRevision: positiveRevision(preview.expectedBindingRevision, 'expectedBindingRevision'),
      expectedDesiredStateSha256: preview.desiredStateSha256,
      confirmation: preview.confirmation,
    },
  });
}

export function finalizeDatabaseCredentialDelete(serverId, credentialId, expectedRevision, deleteJobId) {
  const path = databaseCredentialPath(serverId, credentialId);
  const revision = positiveRevision(expectedRevision, 'expectedRevision');
  if (typeof deleteJobId !== 'string' || !deleteJobId) throw new Error('deleteJobId is required');
  return panelRequest(path, {
    method: 'DELETE',
    body: {
      expectedRevision: revision,
      deleteJobId,
      confirmation: `finalize-database-credential-delete:${credentialId}:${revision}:${deleteJobId}`,
    },
  });
}

export function inspectDatabases(serverId) {
  return panelRequest(`${databaseServerPath(serverId)}/inspect`, { method: 'POST', body: {} });
}

export function createDatabase(serverId, name) {
  if (typeof name !== 'string' || !name) throw new Error('database name is required');
  return panelRequest(databaseServerPath(serverId), {
    method: 'POST',
    body: { name, confirmation: `create:${name}` },
  });
}

export function createDatabaseBackup(serverId, name) {
  return panelRequest(`${databasePath(serverId, name)}/backup`, {
    method: 'POST',
    body: { confirmation: `backup:${name}` },
  });
}

export function getDatabaseDropPreview(serverId, name) {
  return panelRequest(`${databasePath(serverId, name)}/drop-preview`);
}

export function previewDatabaseRestore(serverId, name, backupId) {
  if (typeof backupId !== 'string' || !backupId) throw new Error('backupId is required');
  return panelRequest(`${databasePath(serverId, name)}/restore-preview`, {
    method: 'POST',
    body: { backupId },
  });
}

export function restoreDatabase(serverId, name, preview) {
  if (!preview || typeof preview !== 'object') throw new Error('database restore preview is required');
  return panelRequest(`${databasePath(serverId, name)}/restore`, {
    method: 'POST',
    body: {
      backupId: preview.backupId,
      expectedPreviewDigest: preview.previewDigest,
      expectedBackupSha256: preview.backupSha256,
      confirmation: preview.confirmation,
    },
  });
}

export function deleteDatabase(serverId, name) {
  return panelRequest(databasePath(serverId, name), {
    method: 'DELETE',
    body: { confirmation: `delete:${name}` },
  });
}

export async function waitForJob(jobId, { attempts = 300, intervalMs = 1000 } = {}) {
  let connectionFailures = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const job = await panelRequest(`/jobs/${jobId}`);
      connectionFailures = 0;
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed' || job.status === 'cancelled') {
        const error = new Error(job.error?.message ?? `Job ${job.status}`);
        error.code = job.error?.code ?? job.status;
        throw error;
      }
    } catch (error) {
      if (error.code && !String(error.code).startsWith('http_')) throw error;
      connectionFailures += 1;
      if (connectionFailures >= 30) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Operation timed out');
}

export async function runJob(path, options) {
  const job = await panelRequest(path, options);
  return waitForJob(job.id);
}

export const managedServiceApiInternals = Object.freeze({ managedServiceServerPath, managedServicePath });
export const databaseApiInternals = Object.freeze({ databaseServerPath, databasePath, databaseCredentialPath, positiveRevision });
