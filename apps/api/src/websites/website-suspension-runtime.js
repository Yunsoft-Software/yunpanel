import { createHash } from 'node:crypto';
import {
  websiteSuspensionOperationPublicView,
  WebsiteSuspensionOperationRegistryError,
} from './website-suspension-operation-registry.js';

export class WebsiteSuspensionRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteSuspensionRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value) {
  return sha256(JSON.stringify(value));
}

function suspendConfirmation(website, previewDigest) {
  return `start-website-suspend:${website.id}:${website.revision}:${previewDigest}`;
}

function suspendRetryConfirmation(operation) {
  return `retry-website-suspend:${operation.websiteId}:${operation.id}:${operation.updatedAt}`;
}

function resumeConfirmation(operation) {
  return `resume-website:${operation.websiteId}:${operation.id}:${operation.updatedAt}`;
}

function resumeRetryConfirmation(operation) {
  return `retry-website-resume:${operation.websiteId}:${operation.id}:${operation.updatedAt}`;
}

export function createWebsiteSuspensionRuntime({
  registry,
  websiteRegistry,
  domainRegistry,
  domainSuspensionRuntime,
  localServerId,
} = {}) {
  if (!registry || typeof registry.create !== 'function' || typeof registry.get !== 'function'
    || typeof registry.update !== 'function' || typeof registry.listForWebsite !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !domainRegistry || typeof domainRegistry.listDomains !== 'function'
    || !domainSuspensionRuntime || typeof domainSuspensionRuntime.preview !== 'function'
    || typeof domainSuspensionRuntime.start !== 'function'
    || typeof domainSuspensionRuntime.resume !== 'function'
    || typeof localServerId !== 'string' || !localServerId) {
    throw new WebsiteSuspensionRuntimeError(
      'website_suspension_dependencies_invalid',
      'Website suspension runtime dependencies are invalid',
      503,
    );
  }

  async function preview({ websiteId } = {}) {
    if (typeof websiteId !== 'string' || !websiteId) {
      throw new WebsiteSuspensionRuntimeError('website_id_required', 'websiteId is required');
    }
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || website.serverId !== localServerId) {
      throw new WebsiteSuspensionRuntimeError('website_not_found', 'Website not found on local server', 404);
    }

    const allDomains = await domainRegistry.listDomains();
    const boundDomains = allDomains
      .filter((d) => d.websiteId === websiteId && d.serverId === localServerId)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (boundDomains.length === 0) {
      throw new WebsiteSuspensionRuntimeError(
        'website_has_no_domains',
        'Website has no bound domains to suspend',
        409,
      );
    }

    const domainPreviews = await Promise.all(boundDomains.map(async (domain) => {
      try {
        const p = await domainSuspensionRuntime.preview({ domainId: domain.id });
        return {
          id: domain.id,
          primaryDomain: domain.primaryDomain,
          state: domain.state,
          readyToSuspend: p.readyToSuspend === true,
          previewDigest: p.previewDigest,
          confirmation: p.confirmation,
          blockers: p.blockers ?? [],
        };
      } catch (err) {
        return {
          id: domain.id,
          primaryDomain: domain.primaryDomain,
          state: domain.state,
          readyToSuspend: false,
          previewDigest: null,
          confirmation: null,
          blockers: [err.code || 'domain_preview_failed'],
        };
      }
    }));

    const readyToSuspend = domainPreviews.length > 0 && domainPreviews.every((d) => d.readyToSuspend);
    const readyToResume = domainPreviews.length > 0 && domainPreviews.every((d) => d.state === 'suspended');

    const previewCore = Object.freeze({
      website: {
        id: website.id,
        name: website.name,
        revision: website.revision,
      },
      domains: Object.freeze(domainPreviews),
      readyToSuspend,
      readyToResume,
    });

    const previewDigest = digest(previewCore);
    const confirmation = readyToSuspend ? suspendConfirmation(website, previewDigest) : null;

    return Object.freeze({
      ...previewCore,
      previewDigest,
      confirmation,
      sideEffects: false,
    });
  }

  async function start({ websiteId, previewDigest, confirmation } = {}) {
    const currentPreview = await preview({ websiteId });
    if (!currentPreview.readyToSuspend) {
      throw new WebsiteSuspensionRuntimeError(
        'website_suspension_blocked',
        'Website has domain dependencies that are not ready for suspension',
        409,
      );
    }
    if (currentPreview.previewDigest !== previewDigest || currentPreview.confirmation !== confirmation) {
      throw new WebsiteSuspensionRuntimeError(
        'website_suspension_confirmation_mismatch',
        'Suspension preview digest or confirmation has drifted',
        409,
      );
    }

    const initialDomainOps = currentPreview.domains.map((d) => ({
      domainId: d.id,
      operationId: null,
      status: 'pending',
      error: null,
    }));

    const operation = await registry.create({
      websiteId,
      serverId: localServerId,
      websiteRevision: currentPreview.website.revision,
      previewDigest,
      confirmation,
      domainOperations: initialDomainOps,
    });

    await registry.update(operation.id, { status: 'suspending' });

    let hasFailure = false;
    const updatedDomainOps = [];

    for (const domain of currentPreview.domains) {
      try {
        const domainOp = await domainSuspensionRuntime.start({
          domainId: domain.id,
          previewDigest: domain.previewDigest,
          confirmation: domain.confirmation,
        });
        updatedDomainOps.push({
          domainId: domain.id,
          operationId: domainOp.id,
          status: domainOp.status,
          error: domainOp.error ?? null,
        });
        if (domainOp.status !== 'suspended') {
          hasFailure = true;
        }
      } catch (err) {
        hasFailure = true;
        updatedDomainOps.push({
          domainId: domain.id,
          operationId: null,
          status: 'failed',
          error: { code: err.code || 'domain_suspend_failed', message: err.message },
        });
      }
    }

    const finalStatus = hasFailure
      ? (updatedDomainOps.some((d) => d.status === 'suspended') ? 'partial' : 'failed')
      : 'suspended';

    const updated = await registry.update(operation.id, {
      status: finalStatus,
      domainOperations: updatedDomainOps,
      completedAt: finalStatus === 'suspended' ? new Date().toISOString() : null,
      error: hasFailure ? { code: 'domain_suspension_partial_failure', message: 'One or more domains failed to suspend' } : null,
    });

    return publicWebsiteSuspensionOperation(updated);
  }

  async function retrySuspend({ websiteId, operationId, expectedUpdatedAt, confirmation } = {}) {
    const operation = await registry.get(operationId);
    if (!operation || operation.websiteId !== websiteId || operation.serverId !== localServerId) {
      throw new WebsiteSuspensionRuntimeError('operation_not_found', 'Website suspension operation not found', 404);
    }
    if (!['suspending', 'partial', 'failed'].includes(operation.status)) {
      throw new WebsiteSuspensionRuntimeError(
        'website_suspension_retry_invalid',
        'Operation is not in a retryable state',
        409,
      );
    }
    if (operation.updatedAt !== expectedUpdatedAt || suspendRetryConfirmation(operation) !== confirmation) {
      throw new WebsiteSuspensionRuntimeError(
        'website_suspension_confirmation_mismatch',
        'Retry confirmation or expectedUpdatedAt is stale',
        409,
      );
    }

    await registry.update(operation.id, { status: 'suspending' });

    let hasFailure = false;
    const updatedDomainOps = [];

    for (const dOp of operation.domainOperations) {
      if (dOp.status === 'suspended') {
        updatedDomainOps.push(dOp);
        continue;
      }
      try {
        const dPreview = await domainSuspensionRuntime.preview({ domainId: dOp.domainId });
        if (!dPreview.readyToSuspend) {
          hasFailure = true;
          updatedDomainOps.push({ ...dOp, status: 'failed' });
          continue;
        }
        const domainOp = await domainSuspensionRuntime.start({
          domainId: dOp.domainId,
          previewDigest: dPreview.previewDigest,
          confirmation: dPreview.confirmation,
        });
        updatedDomainOps.push({
          domainId: dOp.domainId,
          operationId: domainOp.id,
          status: domainOp.status,
          error: domainOp.error ?? null,
        });
        if (domainOp.status !== 'suspended') hasFailure = true;
      } catch (err) {
        hasFailure = true;
        updatedDomainOps.push({
          domainId: dOp.domainId,
          operationId: dOp.operationId,
          status: 'failed',
          error: { code: err.code || 'domain_suspend_failed', message: err.message },
        });
      }
    }

    const finalStatus = hasFailure
      ? (updatedDomainOps.some((d) => d.status === 'suspended') ? 'partial' : 'failed')
      : 'suspended';

    const updated = await registry.update(operation.id, {
      status: finalStatus,
      domainOperations: updatedDomainOps,
      completedAt: finalStatus === 'suspended' ? new Date().toISOString() : null,
      error: hasFailure ? { code: 'domain_suspension_partial_failure', message: 'One or more domains failed to suspend' } : null,
    });

    return publicWebsiteSuspensionOperation(updated);
  }

  async function resume({ websiteId, operationId, expectedUpdatedAt, confirmation } = {}) {
    const operation = await registry.get(operationId);
    if (!operation || operation.websiteId !== websiteId || operation.serverId !== localServerId) {
      throw new WebsiteSuspensionRuntimeError('operation_not_found', 'Website suspension operation not found', 404);
    }
    if (operation.status !== 'suspended') {
      throw new WebsiteSuspensionRuntimeError(
        'website_resume_invalid',
        'Website is not suspended; cannot resume',
        409,
      );
    }
    if (operation.updatedAt !== expectedUpdatedAt || resumeConfirmation(operation) !== confirmation) {
      throw new WebsiteSuspensionRuntimeError(
        'website_suspension_confirmation_mismatch',
        'Resume confirmation or expectedUpdatedAt is stale',
        409,
      );
    }

    await registry.update(operation.id, { status: 'resuming' });

    let hasFailure = false;
    const updatedDomainOps = [];

    for (const dOp of operation.domainOperations) {
      try {
        if (!dOp.operationId) {
          throw new Error('Missing child domain operation ID');
        }
        const childOp = await domainSuspensionRuntime.get(dOp.operationId);
        if (!childOp) throw new Error('Child domain operation not found');

        const resumeConfirm = `resume-domain:${childOp.domainId}:${childOp.id}:${childOp.updatedAt}:${childOp.checksum}`;
        const domainOp = await domainSuspensionRuntime.resume({
          domainId: childOp.domainId,
          operationId: childOp.id,
          expectedUpdatedAt: childOp.updatedAt,
          checksum: childOp.checksum,
          confirmation: resumeConfirm,
        });

        updatedDomainOps.push({
          domainId: dOp.domainId,
          operationId: domainOp.id,
          status: domainOp.status,
          error: domainOp.error ?? null,
        });
        if (domainOp.status !== 'resumed') hasFailure = true;
      } catch (err) {
        hasFailure = true;
        updatedDomainOps.push({
          domainId: dOp.domainId,
          operationId: dOp.operationId,
          status: 'resume_failed',
          error: { code: err.code || 'domain_resume_failed', message: err.message },
        });
      }
    }

    const finalStatus = hasFailure
      ? (updatedDomainOps.some((d) => d.status === 'resumed') ? 'resume_partial' : 'resume_failed')
      : 'resumed';

    const updated = await registry.update(operation.id, {
      status: finalStatus,
      domainOperations: updatedDomainOps,
      completedAt: finalStatus === 'resumed' ? new Date().toISOString() : null,
      error: hasFailure ? { code: 'domain_resume_partial_failure', message: 'One or more domains failed to resume' } : null,
    });

    return publicWebsiteSuspensionOperation(updated);
  }

  async function retryResume({ websiteId, operationId, expectedUpdatedAt, confirmation } = {}) {
    const operation = await registry.get(operationId);
    if (!operation || operation.websiteId !== websiteId || operation.serverId !== localServerId) {
      throw new WebsiteSuspensionRuntimeError('operation_not_found', 'Website suspension operation not found', 404);
    }
    if (!['resuming', 'resume_partial', 'resume_failed'].includes(operation.status)) {
      throw new WebsiteSuspensionRuntimeError(
        'website_resume_retry_invalid',
        'Operation is not in a retryable resume state',
        409,
      );
    }
    if (operation.updatedAt !== expectedUpdatedAt || resumeRetryConfirmation(operation) !== confirmation) {
      throw new WebsiteSuspensionRuntimeError(
        'website_suspension_confirmation_mismatch',
        'Resume retry confirmation or expectedUpdatedAt is stale',
        409,
      );
    }

    await registry.update(operation.id, { status: 'resuming' });

    let hasFailure = false;
    const updatedDomainOps = [];

    for (const dOp of operation.domainOperations) {
      if (dOp.status === 'resumed') {
        updatedDomainOps.push(dOp);
        continue;
      }
      try {
        const childOp = await domainSuspensionRuntime.get(dOp.operationId);
        if (!childOp) throw new Error('Child domain operation not found');

        const resumeConfirm = `resume-domain:${childOp.domainId}:${childOp.id}:${childOp.updatedAt}:${childOp.checksum}`;
        const domainOp = await domainSuspensionRuntime.resume({
          domainId: childOp.domainId,
          operationId: childOp.id,
          expectedUpdatedAt: childOp.updatedAt,
          checksum: childOp.checksum,
          confirmation: resumeConfirm,
        });

        updatedDomainOps.push({
          domainId: dOp.domainId,
          operationId: domainOp.id,
          status: domainOp.status,
          error: domainOp.error ?? null,
        });
        if (domainOp.status !== 'resumed') hasFailure = true;
      } catch (err) {
        hasFailure = true;
        updatedDomainOps.push({
          domainId: dOp.domainId,
          operationId: dOp.operationId,
          status: 'resume_failed',
          error: { code: err.code || 'domain_resume_failed', message: err.message },
        });
      }
    }

    const finalStatus = hasFailure
      ? (updatedDomainOps.some((d) => d.status === 'resumed') ? 'resume_partial' : 'resume_failed')
      : 'resumed';

    const updated = await registry.update(operation.id, {
      status: finalStatus,
      domainOperations: updatedDomainOps,
      completedAt: finalStatus === 'resumed' ? new Date().toISOString() : null,
      error: hasFailure ? { code: 'domain_resume_partial_failure', message: 'One or more domains failed to resume' } : null,
    });

    return publicWebsiteSuspensionOperation(updated);
  }

  function publicWebsiteSuspensionOperation(operation) {
    if (!operation) return null;
    const base = websiteSuspensionOperationPublicView(operation);
    return Object.freeze({
      ...base,
      actions: Object.freeze({
        suspendRetryConfirmation: ['suspending', 'partial', 'failed'].includes(operation.status)
          ? suspendRetryConfirmation(operation)
          : null,
        resumeConfirmation: operation.status === 'suspended'
          ? resumeConfirmation(operation)
          : null,
        resumeRetryConfirmation: ['resuming', 'resume_partial', 'resume_failed'].includes(operation.status)
          ? resumeRetryConfirmation(operation)
          : null,
      }),
    });
  }

  async function listForWebsite(websiteId) {
    const list = await registry.listForWebsite(websiteId);
    return list.map(publicWebsiteSuspensionOperation);
  }

  return Object.freeze({
    preview,
    start,
    retrySuspend,
    resume,
    retryResume,
    listForWebsite,
    get: async (id) => publicWebsiteSuspensionOperation(await registry.get(id)),
  });
}
