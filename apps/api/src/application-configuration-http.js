import { ApplicationRegistryError } from './application-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const PREVIEW_FIELDS = new Set(['runtime']);
const APPLY_FIELDS = new Set(['runtime', 'expectedRevision', 'previewDigest', 'confirmation']);

function exactBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((key) => !fields.has(key))) {
    throw new ApplicationRegistryError('node_configuration_input_invalid', `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

async function ensureApplicationIdle(jobRegistry, applicationId) {
  const jobs = await jobRegistry.listJobs({ resourceType: 'application', resourceId: applicationId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new ApplicationRegistryError('application_job_conflict', 'An Application operation is already queued or running', 409);
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountApplicationConfigurationRoutes(app, { applicationRegistry, jobRegistry, localServerId = null } = {}) {
  if (!app || typeof app.post !== 'function'
    || !applicationRegistry || typeof applicationRegistry.previewNodeConfiguration !== 'function'
    || typeof applicationRegistry.updateNodeConfiguration !== 'function' || typeof applicationRegistry.getApplication !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function') {
    throw new Error('Application configuration dependencies are required');
  }

  app.post('/api/applications/:applicationId/configuration-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, PREVIEW_FIELDS);
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application || (localServerId && application.serverId !== localServerId)) {
      throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    }
    await ensureApplicationIdle(jobRegistry, request.params.applicationId);
    return response.json({ data: await applicationRegistry.previewNodeConfiguration(request.params.applicationId, body.runtime) });
  }));

  app.post('/api/applications/:applicationId/configuration', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, APPLY_FIELDS);
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application || (localServerId && application.serverId !== localServerId)) {
      throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    }
    await ensureApplicationIdle(jobRegistry, request.params.applicationId);
    return response.json({ data: await applicationRegistry.updateNodeConfiguration({
      applicationId: request.params.applicationId,
      expectedRevision: body.expectedRevision,
      runtime: body.runtime,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    }) });
  }));
}

export const applicationConfigurationHttpInternals = Object.freeze({ exactBody, ensureApplicationIdle });
