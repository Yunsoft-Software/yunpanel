import { OPERATIONS } from '@yunpanel/protocol';
import { ApplicationRegistryError } from './application-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const ACTIONS = new Set(['enable', 'disable', 'start', 'stop']);
const BODY_FIELDS = new Set(['action', 'confirmation']);

function exactBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== BODY_FIELDS.size
    || Object.keys(body).some((key) => !BODY_FIELDS.has(key))
    || !ACTIONS.has(body.action)) {
    throw new ApplicationRegistryError('node_process_input_invalid', 'Request must contain exactly a supported action and confirmation');
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

export function mountApplicationProcessRoutes(app, { applicationRegistry, jobRegistry } = {}) {
  if (!app || typeof app.post !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new Error('Application process dependencies are required');
  }

  app.post('/api/applications/:applicationId/process', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(request.body);
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    if (application.type !== 'node') {
      throw new ApplicationRegistryError('node_process_not_supported', 'Process control is available only for Node applications', 409);
    }
    if (!application.currentReleaseId || !application.activeRuntime) {
      throw new ApplicationRegistryError('application_not_deployed', 'Application has no active release to control', 409);
    }
    if (application.activeDeploymentId) {
      throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
    }
    await ensureApplicationIdle(jobRegistry, application.id);
    const expectedConfirmation = `node-process:${application.id}:${application.currentReleaseId}:${body.action}`;
    if (body.confirmation !== expectedConfirmation) {
      throw new ApplicationRegistryError('node_process_confirmation_required', 'Exact Node process confirmation is required');
    }

    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: 'app.node.process',
      operation: OPERATIONS.APP_NODE_PROCESS,
      payload: {
        applicationId: application.id,
        releaseId: application.currentReleaseId,
        runtime: application.activeRuntime,
        action: body.action,
      },
      resourceType: 'application',
      resourceId: application.id,
    });
    return response.status(202).json({ data: job });
  }));
}

export const applicationProcessHttpInternals = Object.freeze({ actions: Object.freeze([...ACTIONS]), exactBody, ensureApplicationIdle });
