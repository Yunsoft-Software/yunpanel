import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { ApplicationValidationError, normalizeGitDeploymentTarget } from '@yunpanel/shared';
import { ApplicationRegistryError } from './application-registry.js';
import { ApplicationEnvironmentRegistryError } from './application-environment-registry.js';
import { WebsiteRegistryError } from './website-registry.js';
import { JobRegistryError } from './job-registry.js';
import { logHttpInternals, normalizeLogQuery, LogHttpError } from './log-http.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

export class ApplicationOperationsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApplicationOperationsHttpError';
    this.code = code;
    this.status = status;
  }
}

const PROCESS_ACTIONS = new Set(['enable', 'disable', 'start', 'stop', 'restart']);
const PROCESS_BODY_FIELDS = new Set(['action', 'confirmation']);
const CONFIG_PREVIEW_FIELDS = new Set(['runtime']);
const CONFIG_APPLY_FIELDS = new Set(['runtime', 'expectedRevision', 'previewDigest', 'confirmation']);
const JOURNAL_LEVELS = Object.freeze(['emerg', 'alert', 'crit', 'error', 'warning', 'notice', 'info', 'debug']);

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      if (
        error instanceof ApplicationOperationsHttpError
        || error instanceof ApplicationRegistryError
        || error instanceof ApplicationEnvironmentRegistryError
        || error instanceof WebsiteRegistryError
        || error instanceof JobRegistryError
        || error instanceof LogHttpError
      ) {
        return response.status(error.status ?? 400).json({
          error: { code: error.code, message: error.message },
        });
      }
      return next(error);
    }
  };
}

function exactBody(body, fields, errorCode, errorMessage) {
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((key) => !fields.has(key))
  ) {
    throw new ApplicationOperationsHttpError(errorCode, errorMessage);
  }
  return body;
}

function deploymentGitTarget(body, defaultBranch) {
  if (
    body !== undefined
    && (!body
      || typeof body !== 'object'
      || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'gitTarget'))
  ) {
    throw new ApplicationOperationsHttpError('invalid_deployment_request', 'Deployment accepts only an optional gitTarget');
  }
  try {
    return normalizeGitDeploymentTarget(body?.gitTarget, { defaultBranch });
  } catch (error) {
    if (error instanceof ApplicationValidationError) {
      throw new ApplicationOperationsHttpError(error.code, error.message);
    }
    throw error;
  }
}

function environmentImportInput(body) {
  const fields = ['confirmation', 'content', 'expectedRevision', 'mode', 'secret'];
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).length !== fields.length
    || Object.keys(body).some((key) => !fields.includes(key))
  ) {
    throw new ApplicationOperationsHttpError('invalid_environment_import', 'Environment import request fields are invalid');
  }
  return body;
}

async function ensureApplicationIdle(jobRegistry, applicationId) {
  if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') return;
  const jobs = await jobRegistry.listJobs({ resourceType: 'application', resourceId: applicationId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new ApplicationOperationsHttpError('application_job_conflict', 'An Application operation is already queued or running', 409);
  }
}

async function ensureEnvironmentMutable(application, jobRegistry) {
  await ensureApplicationIdle(jobRegistry, application.id);
  if (application.activeDeploymentId) {
    throw new ApplicationOperationsHttpError('deployment_in_progress', 'Application already has an active operation', 409);
  }
}

function getAvailableActions(application, website) {
  const type = application?.type ?? website?.runtimeType;
  if (type === 'node') {
    return ['deploy', 'rollback', 'restart', 'status', 'process', 'environment', 'configuration', 'logs', 'health'];
  }
  if (type === 'python') {
    return ['deploy', 'rollback', 'restart', 'status', 'environment', 'logs', 'health'];
  }
  if (type === 'php') {
    return ['wp_cli', 'composer', 'health', 'logs'];
  }
  if (type === 'docker') {
    return ['build', 'pull', 'start', 'stop', 'restart', 'logs', 'health'];
  }
  if (type === 'static') {
    return ['deploy', 'rollback', 'health', 'logs'];
  }
  return ['health'];
}

export function mountApplicationOperationsRoutes(app, {
  websiteRegistry,
  domainRegistry = null,
  applicationRegistry,
  applicationEnvironmentRegistry = null,
  jobRegistry,
  queueDeploy = null,
  registry = null,
  siteHealthService = null,
  journalLogReader = null,
  nginxLogReader = null,
  localServerId = null,
  now = () => Date.now(),
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express app is required for application operations');
  }
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new Error('Website registry is required for application operations');
  }

  const resolveWebsite = async (websiteId) => {
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || (localServerId && website.serverId !== localServerId)) {
      throw new ApplicationOperationsHttpError('website_not_found', 'Website not found', 404);
    }
    return website;
  };

  const resolveWebsiteAndApp = async (websiteId, { requireApp = false } = {}) => {
    const website = await resolveWebsite(websiteId);
    if (!website.applicationId) {
      if (requireApp) {
        throw new ApplicationOperationsHttpError('application_not_bound', 'Website has no application bound', 404);
      }
      return { website, application: null };
    }
    if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function') {
      throw new ApplicationOperationsHttpError('application_registry_unavailable', 'Application registry unavailable', 503);
    }
    const application = await applicationRegistry.getApplication(website.applicationId);
    if (!application || (localServerId && application.serverId !== localServerId)) {
      if (requireApp) {
        throw new ApplicationOperationsHttpError('application_not_found', 'Bound application was not found', 404);
      }
      return { website, application: null };
    }
    return { website, application };
  };

  // 1. GET /api/websites/:websiteId/application (and alias /runtime)
  const handleGetApplication = async (request, response) => {
    const { website, application } = await resolveWebsiteAndApp(request.params.websiteId);

    // If website has a bound application
    if (application) {
      const runtimeType = application.type;
      const isProductExtension = ['python', 'docker'].includes(runtimeType);
      const productExtensionLabel = runtimeType === 'python'
        ? 'Python (Ürün uzantısı)'
        : (runtimeType === 'docker' ? 'Docker (Ürün uzantısı)' : null);

      let envStatus = null;
      if (applicationEnvironmentRegistry && ['node', 'python'].includes(application.type)) {
        try {
          const status = await applicationEnvironmentRegistry.environmentStatus(application.id, {
            currentReleaseId: application.currentReleaseId,
          });
          const vars = await applicationEnvironmentRegistry.listVariables(application.id);
          envStatus = {
            savedRevision: status.savedRevision,
            appliedRevision: status.appliedRevision,
            appliedToRunningProcess: status.appliedToRunningProcess,
            variableCount: vars.length,
            secretCount: vars.filter((v) => v.secret).length,
            lastChange: status.lastChange,
          };
        } catch {
          // ignore error reading env status
        }
      }

      const isHealthy = application.healthy ?? (application.state === 'active');

      return response.json({
        data: {
          websiteId: website.id,
          websiteName: website.name,
          serverId: website.serverId,
          applicationId: application.id,
          name: application.name,
          type: application.type,
          runtimeType,
          isProductExtension,
          productExtensionLabel,
          state: application.state,
          runtime: application.runtime ?? null,
          runtimeAdapter: application.runtimeAdapter ?? null,
          webRoot: application.webRoot ?? null,
          repositoryUrl: application.repositoryUrl ?? null,
          branch: application.branch ?? null,
          currentCommitSha: application.currentCommitSha ?? null,
          currentReleaseId: application.currentReleaseId ?? null,
          previousReleaseId: application.previousReleaseId ?? null,
          activeDeploymentId: application.activeDeploymentId ?? null,
          lastDeployedAt: application.lastDeployedAt ?? null,
          serviceName: application.serviceName ?? null,
          servicePort: application.servicePort ?? application.runtime?.port ?? null,
          healthPath: application.healthPath ?? application.runtime?.healthPath ?? null,
          healthy: isHealthy,
          health: {
            healthy: isHealthy,
            healthPath: application.healthPath ?? application.runtime?.healthPath ?? null,
            port: application.servicePort ?? application.runtime?.port ?? null,
            serviceName: application.serviceName ?? null,
            status: application.state,
          },
          releases: application.releases ?? [],
          environment: envStatus ? {
            savedRevision: envStatus.savedRevision,
            appliedRevision: envStatus.appliedRevision,
            appliedToRunningProcess: envStatus.appliedToRunningProcess,
            variableCount: envStatus.variableCount,
            secretCount: envStatus.secretCount,
            lastChange: envStatus.lastChange,
          } : null,
          actions: getAvailableActions(application, website),
        },
      });
    }

    // If website has PHP runtime type
    if (website.runtimeType === 'php') {
      return response.json({
        data: {
          websiteId: website.id,
          websiteName: website.name,
          serverId: website.serverId,
          applicationId: null,
          runtimeType: 'php',
          isProductExtension: false,
          productExtensionLabel: null,
          state: 'active',
          runtime: {
            phpVersion: '8.3',
            adapter: 'php-fpm',
            webRoot: `/var/www/${website.name}/public`,
          },
          health: { healthy: true, status: 'ok', runtimeType: 'php' },
          releases: [],
          actions: ['wp_cli', 'composer', 'health', 'logs'],
        },
      });
    }

    // If website has Docker runtime type or docker binding
    if (website.runtimeType === 'docker' || website.dockerWorkloadId || website.managedComposeBinding) {
      return response.json({
        data: {
          websiteId: website.id,
          websiteName: website.name,
          serverId: website.serverId,
          applicationId: null,
          dockerWorkloadId: website.dockerWorkloadId ?? null,
          managedComposeBinding: website.managedComposeBinding ?? null,
          runtimeType: 'docker',
          isProductExtension: true,
          productExtensionLabel: 'Docker (Ürün uzantısı)',
          state: 'running',
          health: { healthy: true, status: 'running', runtimeType: 'docker' },
          actions: ['build', 'pull', 'start', 'stop', 'restart', 'logs', 'health'],
        },
      });
    }

    // Unbound website
    return response.json({
      data: {
        websiteId: website.id,
        websiteName: website.name,
        serverId: website.serverId,
        applicationId: null,
        runtimeType: website.runtimeType ?? 'unbound',
        isProductExtension: false,
        productExtensionLabel: null,
        unbound: true,
        actions: ['health'],
      },
    });
  };

  app.get('/api/websites/:websiteId/application', requirePanelRouteAccess, asyncRoute(handleGetApplication));
  app.get('/api/websites/:websiteId/runtime', requirePanelRouteAccess, asyncRoute(handleGetApplication));

  // 2. Environment routes
  app.get('/api/websites/:websiteId/application/environment', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!['node', 'python'].includes(application.type)) {
      throw new ApplicationOperationsHttpError('environment_not_supported', 'Environment variables are available only for Node and Python applications', 409);
    }
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    return response.json({
      data: await applicationEnvironmentRegistry.listVariables(application.id),
      environment: await applicationEnvironmentRegistry.environmentStatus(application.id, { currentReleaseId: application.currentReleaseId }),
      secretStoreConfigured: applicationEnvironmentRegistry.secretStoreConfigured,
    });
  }));

  app.get('/api/websites/:websiteId/application/environment/status', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    const status = await applicationEnvironmentRegistry.environmentStatus(application.id, { currentReleaseId: application.currentReleaseId });
    const vars = await applicationEnvironmentRegistry.listVariables(application.id);
    return response.json({
      data: {
        ...status,
        variableCount: vars.length,
        secretCount: vars.filter((v) => v.secret).length,
      },
    });
  }));

  app.put('/api/websites/:websiteId/application/environment/:key', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!['node', 'python'].includes(application.type)) {
      throw new ApplicationOperationsHttpError('environment_not_supported', 'Environment variables are available only for Node and Python applications', 409);
    }
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    await ensureEnvironmentMutable(application, jobRegistry);
    const variable = await applicationEnvironmentRegistry.setVariable({
      applicationId: application.id,
      key: request.params.key,
      value: request.body?.value,
      secret: request.body?.secret === true,
    });
    return response.json({ data: variable });
  }));

  app.delete('/api/websites/:websiteId/application/environment/:key', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!['node', 'python'].includes(application.type)) {
      throw new ApplicationOperationsHttpError('environment_not_supported', 'Environment variables are available only for Node and Python applications', 409);
    }
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    await ensureEnvironmentMutable(application, jobRegistry);
    await applicationEnvironmentRegistry.deleteVariable(application.id, request.params.key);
    return response.status(204).end();
  }));

  app.post('/api/websites/:websiteId/application/environment/import', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!['node', 'python'].includes(application.type)) {
      throw new ApplicationOperationsHttpError('environment_import_not_supported', 'Environment import is available only for Node and Python applications', 409);
    }
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    await ensureEnvironmentMutable(application, jobRegistry);
    const body = environmentImportInput(request.body);
    return response.json({
      data: await applicationEnvironmentRegistry.importVariables({
        applicationId: application.id,
        ...body,
      }),
    });
  }));

  // 3. Deployment & Releases (Git)
  app.get('/api/websites/:websiteId/application/releases', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    return response.json({
      data: application.releases ?? [],
      currentReleaseId: application.currentReleaseId ?? null,
      previousReleaseId: application.previousReleaseId ?? null,
    });
  }));

  const handleDeploy = async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (application.type === 'php') {
      throw new ApplicationOperationsHttpError('deployment_not_supported', 'PHP application does not support Git deploy flow', 409);
    }
    if (!queueDeploy) {
      throw new ApplicationOperationsHttpError('deploy_queue_unavailable', 'Deploy queue is unavailable', 503);
    }
    const gitTarget = deploymentGitTarget(request.body, application.branch);
    const queued = await queueDeploy({ applicationId: application.id, gitTarget });
    return response.status(202).json({ data: { application: queued.application, job: queued.job } });
  };

  app.post('/api/websites/:websiteId/application/deploy', requirePanelRouteAccess, asyncRoute(handleDeploy));
  app.post('/api/websites/:websiteId/deploy', requirePanelRouteAccess, asyncRoute(handleDeploy));

  // 4. Rollback
  const handleRollback = async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!['static', 'node', 'python'].includes(application.type)) {
      throw new ApplicationOperationsHttpError('rollback_not_supported', 'Rollback is not implemented for this application type', 409);
    }
    await ensureApplicationIdle(jobRegistry, application.id);
    if (application.activeDeploymentId) {
      throw new ApplicationOperationsHttpError('deployment_in_progress', 'Application already has an active operation', 409);
    }

    const releaseId = request.body?.releaseId ?? application.previousReleaseId;
    if (!releaseId) {
      throw new ApplicationOperationsHttpError('rollback_release_required', 'No previous release is available for rollback', 409);
    }

    const targetRelease = (application.releases ?? []).find((r) => r.releaseId === releaseId);
    if (!targetRelease && releaseId !== application.previousReleaseId) {
      throw new ApplicationOperationsHttpError('invalid_rollback_release', 'Target release was not found in release history', 409);
    }

    const nodeRollback = application.type === 'node';
    const pythonRollback = application.type === 'python';
    let envRevision = null;
    if (nodeRollback || pythonRollback) {
      if (applicationEnvironmentRegistry) {
        try {
          const env = await applicationEnvironmentRegistry.environmentStatus(application.id);
          envRevision = env.savedRevision;
        } catch {}
      }
    }

    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: pythonRollback
        ? 'app.python.rollback'
        : (nodeRollback ? 'app.node.rollback' : 'app.static.rollback'),
      operation: pythonRollback
        ? OPERATIONS.APP_PYTHON_ROLLBACK
        : (nodeRollback ? OPERATIONS.APP_NODE_ROLLBACK : OPERATIONS.APP_STATIC_ROLLBACK),
      payload: (nodeRollback || pythonRollback)
        ? {
            applicationId: application.id,
            releaseId,
            currentReleaseId: application.currentReleaseId,
            runtime: targetRelease?.runtime ?? application.activeRuntime ?? application.runtime,
            environmentRevision: envRevision,
          }
        : {
            applicationId: application.id,
            releaseId,
            currentReleaseId: application.currentReleaseId,
          },
      resourceType: 'application',
      resourceId: application.id,
    });

    try {
      const updated = await applicationRegistry.markRollingBack(application.id, job.id, releaseId);
      return response.status(202).json({ data: { application: updated, job } });
    } catch (error) {
      await jobRegistry.cancel(job.id).catch(() => {});
      throw error;
    }
  };

  app.post('/api/websites/:websiteId/application/rollback', requirePanelRouteAccess, asyncRoute(handleRollback));
  app.post('/api/websites/:websiteId/rollback', requirePanelRouteAccess, asyncRoute(handleRollback));

  // 5. Restart
  const handleRestart = async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!['node', 'python'].includes(application.type)) {
      throw new ApplicationOperationsHttpError('restart_not_supported', 'Restart is only supported for Node and Python applications', 409);
    }
    if (!application.currentReleaseId) {
      throw new ApplicationOperationsHttpError('application_not_deployed', 'Application has no active release to restart', 409);
    }
    await ensureApplicationIdle(jobRegistry, application.id);
    if (application.activeDeploymentId) {
      throw new ApplicationOperationsHttpError('deployment_in_progress', 'Application already has an active operation', 409);
    }

    const isPython = application.type === 'python';
    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: isPython ? 'app.python.restart' : 'app.node.restart',
      operation: isPython ? OPERATIONS.APP_PYTHON_RESTART : OPERATIONS.APP_NODE_RESTART,
      payload: {
        applicationId: application.id,
        releaseId: application.currentReleaseId,
        runtime: application.activeRuntime ?? application.runtime,
      },
      resourceType: 'application',
      resourceId: application.id,
    });
    return response.status(202).json({ data: job });
  };

  app.post('/api/websites/:websiteId/application/restart', requirePanelRouteAccess, asyncRoute(handleRestart));
  app.post('/api/websites/:websiteId/restart', requirePanelRouteAccess, asyncRoute(handleRestart));

  // 6. Process Control (Node.js)
  app.post('/api/websites/:websiteId/application/process', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (application.type !== 'node') {
      throw new ApplicationOperationsHttpError('node_process_not_supported', 'Process control is available only for Node applications', 409);
    }
    if (!application.currentReleaseId || !application.activeRuntime) {
      throw new ApplicationOperationsHttpError('application_not_deployed', 'Application has no active release to control', 409);
    }
    if (application.activeDeploymentId) {
      throw new ApplicationOperationsHttpError('deployment_in_progress', 'Application already has an active operation', 409);
    }
    await ensureApplicationIdle(jobRegistry, application.id);

    const body = exactBody(
      request.body,
      PROCESS_BODY_FIELDS,
      'node_process_input_invalid',
      'Request must contain exactly a supported action and confirmation',
    );
    if (!PROCESS_ACTIONS.has(body.action)) {
      throw new ApplicationOperationsHttpError('node_process_input_invalid', 'Invalid action specified');
    }

    const expectedConfirmation = `node-process:${application.id}:${application.currentReleaseId}:${body.action}`;
    if (body.confirmation !== expectedConfirmation) {
      throw new ApplicationOperationsHttpError('node_process_confirmation_required', 'Exact Node process confirmation is required', 400);
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

  // 7. Configuration Preview and Apply
  app.post('/api/websites/:websiteId/application/configuration-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (application.type !== 'node') {
      throw new ApplicationOperationsHttpError('configuration_not_supported', 'Configuration preview is available only for Node applications', 409);
    }
    const body = exactBody(
      request.body,
      CONFIG_PREVIEW_FIELDS,
      'node_configuration_input_invalid',
      'Request must contain exactly runtime field',
    );
    await ensureApplicationIdle(jobRegistry, application.id);
    return response.json({
      data: await applicationRegistry.previewNodeConfiguration(application.id, body.runtime),
    });
  }));

  app.post('/api/websites/:websiteId/application/configuration', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (application.type !== 'node') {
      throw new ApplicationOperationsHttpError('configuration_not_supported', 'Configuration update is available only for Node applications', 409);
    }
    const body = exactBody(
      request.body,
      CONFIG_APPLY_FIELDS,
      'node_configuration_input_invalid',
      'Request must contain exactly runtime, expectedRevision, previewDigest, and confirmation',
    );
    await ensureApplicationIdle(jobRegistry, application.id);
    return response.json({
      data: await applicationRegistry.updateNodeConfiguration({
        applicationId: application.id,
        expectedRevision: body.expectedRevision,
        runtime: body.runtime,
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      }),
    });
  }));

  // 8. Health
  app.get('/api/websites/:websiteId/application/health', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { website, application } = await resolveWebsiteAndApp(request.params.websiteId);
    const runtimeType = application?.type ?? website.runtimeType ?? 'unbound';
    const isProductExtension = ['python', 'docker'].includes(runtimeType);

    let siteHealthReport = null;
    if (siteHealthService && typeof siteHealthService.inspectSiteHealth === 'function') {
      try {
        siteHealthReport = await siteHealthService.inspectSiteHealth({ websiteId: website.id });
      } catch {}
    }

    const healthy = application ? (application.healthy ?? (application.state === 'active')) : true;
    return response.json({
      data: {
        websiteId: website.id,
        websiteName: website.name,
        applicationId: application?.id ?? null,
        runtimeType,
        isProductExtension,
        healthy,
        status: application?.state ?? (runtimeType === 'php' ? 'active' : 'unbound'),
        port: application?.servicePort ?? application?.runtime?.port ?? null,
        healthPath: application?.healthPath ?? application?.runtime?.healthPath ?? '/',
        serviceName: application?.serviceName ?? null,
        checkedAt: new Date(now()).toISOString(),
        siteHealthReport,
      },
    });
  }));

  // 9. Logs
  const mountLogFormats = (basePath, handler) => {
    app.get(basePath, requirePanelRouteAccess, asyncRoute((req, res) => handler(req, res, 'json')));
    app.get(`${basePath}/stream`, requirePanelRouteAccess, asyncRoute((req, res) => handler(req, res, 'stream')));
    app.get(`${basePath}/download`, requirePanelRouteAccess, asyncRoute((req, res) => handler(req, res, 'download')));
  };

  mountLogFormats('/api/websites/:websiteId/application/logs', async (request, response, format) => {
    const { website, application } = await resolveWebsiteAndApp(request.params.websiteId);
    const query = normalizeLogQuery(request.query, { now: now(), allowedLevels: JOURNAL_LEVELS, maxLimit: 200 });

    if (application?.type === 'node') {
      if (!journalLogReader || typeof journalLogReader.query !== 'function') {
        throw new ApplicationOperationsHttpError('journal_logs_unavailable', 'System journal log reader is unavailable', 503);
      }
      const unit = logHttpInternals.nodeUnit(application.id);
      const result = await journalLogReader.query({
        unit,
        since: query.since,
        until: query.until,
        priorities: query.levels.map((level) => JOURNAL_LEVELS.indexOf(level)),
        search: query.search,
        limit: query.limit,
        cursor: query.cursor,
      });
      return sendLogResult(response, result, format, `website-${website.name}-node-logs.txt`);
    }

    if (website.runtimeType === 'php' || !application) {
      if (!nginxLogReader || typeof nginxLogReader.query !== 'function') {
        throw new ApplicationOperationsHttpError('nginx_logs_unavailable', 'Nginx log reader is unavailable', 503);
      }
      const result = await nginxLogReader.query({
        kind: request.query.kind === 'error' ? 'error' : 'access',
        since: query.since,
        until: query.until,
        levels: query.levels,
        search: query.search,
        limit: query.limit,
        cursor: query.cursor,
      });
      return sendLogResult(response, result, format, `website-${website.name}-nginx-logs.txt`);
    }

    // Default response for other runtimes without direct log reader
    const emptyResult = { entries: [], page: { limit: query.limit, hasMore: false }, range: { since: query.since, until: query.until } };
    return sendLogResult(response, emptyResult, format, `website-${website.name}-logs.txt`);
  });

  // 10. Deployment credential & GitHub webhook
  app.get('/api/websites/:websiteId/application/deployment-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    return response.json({
      data: await applicationEnvironmentRegistry.deploymentCredential(application.id),
      secretStoreConfigured: applicationEnvironmentRegistry.secretStoreConfigured,
    });
  }));

  app.put('/api/websites/:websiteId/application/deployment-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    await ensureEnvironmentMutable(application, jobRegistry);
    return response.json({
      data: await applicationEnvironmentRegistry.setDeploymentCredential({
        applicationId: application.id,
        credential: request.body,
      }),
    });
  }));

  app.delete('/api/websites/:websiteId/application/deployment-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    await ensureEnvironmentMutable(application, jobRegistry);
    const confirmation = `delete-deployment-credential:${application.id}`;
    if (!request.body || request.body.confirmation !== confirmation) {
      throw new ApplicationOperationsHttpError('git_credential_confirmation_required', `Confirm credential deletion with ${confirmation}`);
    }
    await applicationEnvironmentRegistry.deleteDeploymentCredential(application.id);
    return response.status(204).end();
  }));

  app.get('/api/websites/:websiteId/application/github-webhook', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    return response.json({
      data: await applicationEnvironmentRegistry.webhookSecret(application.id),
      secretStoreConfigured: applicationEnvironmentRegistry.secretStoreConfigured,
    });
  }));

  app.put('/api/websites/:websiteId/application/github-webhook', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    await ensureEnvironmentMutable(application, jobRegistry);
    if (!request.body || typeof request.body.secret !== 'string') {
      throw new ApplicationOperationsHttpError('invalid_github_webhook_secret', 'GitHub webhook secret request is invalid');
    }
    return response.json({
      data: await applicationEnvironmentRegistry.setWebhookSecret({
        applicationId: application.id,
        secret: request.body.secret,
      }),
    });
  }));

  app.delete('/api/websites/:websiteId/application/github-webhook', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { application } = await resolveWebsiteAndApp(request.params.websiteId, { requireApp: true });
    if (!applicationEnvironmentRegistry) {
      throw new ApplicationOperationsHttpError('environment_registry_unavailable', 'Application environment registry is unavailable', 503);
    }
    await ensureEnvironmentMutable(application, jobRegistry);
    const confirmation = `delete-github-webhook:${application.id}`;
    if (!request.body || request.body.confirmation !== confirmation) {
      throw new ApplicationOperationsHttpError('github_webhook_confirmation_required', `Confirm webhook deletion with ${confirmation}`);
    }
    await applicationEnvironmentRegistry.deleteWebhookSecret(application.id);
    return response.status(204).end();
  }));
}

function sendLogResult(response, result, format, filename) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (format === 'json') return response.json({ data: result });
  if (format === 'stream') {
    response.type('application/x-ndjson');
    const entries = (result.entries ?? []).map((entry) => JSON.stringify({ type: 'entry', data: entry }));
    entries.push(JSON.stringify({ type: 'page', data: result.page, range: result.range }));
    return response.send(`${entries.join('\n')}\n`);
  }
  response.type('text/plain');
  response.setHeader('content-disposition', `attachment; filename="${filename}"`);
  const lines = (result.entries ?? []).map((entry) => {
    const context = entry.unit ?? `${entry.source}${entry.stage ? `/${entry.stage}` : ''}`;
    return `${entry.timestamp} ${(entry.level ?? 'INFO').toUpperCase()} ${context} ${(entry.message ?? '').replace(/\r?\n/g, ' ↩ ')}`;
  });
  return response.send(`${lines.join('\n')}${lines.length ? '\n' : ''}`);
}
