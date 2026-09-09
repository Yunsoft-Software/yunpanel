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
