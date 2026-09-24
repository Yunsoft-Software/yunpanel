const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// Shared by runtime instances using the same registry, not by other processes or writers.
const activeRemovals = new WeakMap();

export class WebsiteRemovalRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteRemovalRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function requireCleanupMethod(method) {
  if (typeof method !== 'function') {
    throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unavailable', 'The required cleanup adapter is unavailable.', 503);
  }
}
function requireCleanupReceipt(receipt, expected, flag) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt[flag] !== true
    || Object.entries(expected).some(([key, value]) => receipt[key] !== value)) {
    throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Cleanup of this Website could not be verified.', 409);
  }
}
function cleanupInventory(value) {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item.id !== 'string' || !SAFE_ID.test(item.id))
    || new Set(value.map((item) => item.id)).size !== value.length) {
    throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'The cleanup inventory could not be verified.', 409);
  }
  return value;
}

function stepContinuationConfirmation(operation, step) {
  return `continue-website-remove-step:${operation.websiteId}:${operation.id}:${step.id}:${operation.updatedAt}`;
}

function firstIncomplete(operation) {
  return operation.steps.find((step) => step.status !== 'succeeded') ?? null;
}

function publicOperation(operation) {
  if (!operation) return null;
  const step = firstIncomplete(operation);
  const stepContinuable = step
    && ['pending', 'running', 'blocked', 'failed'].includes(step.status)
    && operation.status !== 'removed';

  return Object.freeze({
    ...operation,
    actions: Object.freeze({
      stepContinuationConfirmation: stepContinuable
        ? stepContinuationConfirmation(operation, step)
        : null,
    }),
  });
}

export function createWebsiteRemovalRuntime({
  registry,
  previewProvider,
  domainRemovalRuntime,
  websiteRegistry = null,
  applicationRegistry = null,
  applicationEnvironmentRegistry = null,
  databaseBindingRegistry = null,
  databaseCredentialRegistry = null,
  websiteSftpKeyRegistry = null,
  runtimeBindingRegistry = null,
  websiteCronRegistry = null,
  fileCleanupHandler = null,
  unixIdentityCleanupHandler = null,
} = {}) {
  if (!registry || typeof registry.create !== 'function' || typeof registry.get !== 'function') {
    throw new WebsiteRemovalRuntimeError(
      'website_removal_runtime_invalid_dependencies',
      'Website removal operation registry is required',
      503,
    );
  }
  if (!previewProvider || typeof previewProvider !== 'function') {
    throw new WebsiteRemovalRuntimeError(
      'website_removal_runtime_invalid_dependencies',
      'Website removal preview provider is required',
      503,
    );
  }
  if (!domainRemovalRuntime || typeof domainRemovalRuntime.start !== 'function') {
    throw new WebsiteRemovalRuntimeError(
      'website_removal_runtime_invalid_dependencies',
      'Domain removal runtime is required for website removal orchestrator',
      503,
    );
  }

  let active = activeRemovals.get(registry);
  if (!active) { active = new Set(); activeRemovals.set(registry, active); }
  async function withWebsiteMutation(input, action) {
    const websiteId = input?.websiteId;
    if (typeof websiteId !== 'string' || !SAFE_ID.test(websiteId)) {
      throw new WebsiteRemovalRuntimeError('website_removal_target_invalid', 'An explicit Website target is required.');
    }
    // Do not queue a stale destructive confirmation for later execution.
    if (active.has(websiteId)) {
      throw new WebsiteRemovalRuntimeError('website_removal_busy', 'A removal step for this Website is already running.', 409);
    }
    const submitted = structuredClone(input);
    active.add(websiteId);
    try { return await action(submitted); }
    finally { active.delete(websiteId); }
  }

  async function loadOperation(operationId) {
    const op = await registry.get(operationId);
    if (!op) {
      throw new WebsiteRemovalRuntimeError(
        'website_removal_operation_not_found',
        'Website removal operation was not found',
        404,
      );
    }
    return op;
  }

  async function init() {
    await registry.init();
    // Inspect-first reconciliation for interrupted operations
    const operations = await registry.list();
    for (const op of operations) {
      if (op.status === 'running') {
        const step = firstIncomplete(op);
        if (step && step.status === 'running') {
          // Fail-closed/inspect-only: do not blindly replay mutation
          await registry.blockStep(op.id, step.id, {
            code: 'website_removal_interrupted',
            message: 'Website removal step was interrupted and requires explicit continuation',
          });
        }
      }
    }
  }

  function cleanupBlockers(plan) {
    const missing = [];
    const require = (code, ...methods) => { if (methods.some((method) => typeof method !== 'function')) missing.push(code); };
    require('file_cleanup_unavailable', fileCleanupHandler);
    require('metadata_cleanup_unavailable', websiteRegistry?.getWebsite, websiteRegistry?.deleteMigrationWebsite);
    if (plan?.applicationId) require('application_cleanup_unavailable',
      applicationRegistry?.getApplication, applicationRegistry?.deleteApplication,
      applicationEnvironmentRegistry?.inspectApplicationState, applicationEnvironmentRegistry?.purgeApplication);
    if (plan?.systemUser) require('unix_cleanup_unavailable', unixIdentityCleanupHandler);
    if (plan?.additional?.crons?.ids?.length) require('cron_cleanup_unavailable', websiteCronRegistry?.listTasks, websiteCronRegistry?.removeTask);
    if (plan?.additional?.sftpKeys?.ids?.length) require('sftp_cleanup_unavailable', websiteSftpKeyRegistry?.listKeys, websiteSftpKeyRegistry?.revokeKey);
    if (plan?.additional?.databases?.ids?.length) {
      require('database_cleanup_unavailable', databaseBindingRegistry?.listBindings,
        databaseBindingRegistry?.unbindDatabase ?? databaseBindingRegistry?.removeBinding,
        databaseCredentialRegistry?.getForBinding, databaseCredentialRegistry?.deleteCredential);
    }
    if (plan?.additional?.runtimeBindings?.ids?.length) require('runtime_cleanup_unavailable', runtimeBindingRegistry?.getBinding, runtimeBindingRegistry?.removeOwnedPassenger);
    return missing;
  }

  async function preview({ websiteId } = {}) {
    const current = await previewProvider({ websiteId });
    const missing = cleanupBlockers(current?.plan);
    if (!missing.length) return current;
    // No destructive confirmation when this deployment cannot finish the planned cleanup.
    return Object.freeze({ ...current, readyToStart: false, confirmation: null,
      hardBlockers: Object.freeze([...new Set([...(current?.hardBlockers ?? []), ...missing])]) });
  }

  async function start({ websiteId, previewDigest, confirmation } = {}) {
    if (typeof websiteId !== 'string' || !SAFE_ID.test(websiteId)
      || typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation.startsWith(`start-website-remove:${websiteId}:`)) {
      throw new WebsiteRemovalRuntimeError(
        'website_removal_confirmation_invalid',
        'Valid website removal confirmation is required',
        400,
      );
    }

    const currentPreview = await preview({ websiteId });
    if (!currentPreview || currentPreview.website?.id !== websiteId
      || currentPreview.previewDigest !== previewDigest
      || currentPreview.confirmation !== confirmation || currentPreview.readyToStart !== true) {
      throw new WebsiteRemovalRuntimeError(
        'website_removal_preview_stale',
        'Website removal state has changed since preview; request a new preview',
        409,
      );
    }

    requireCleanupMethod(registry.listForWebsite);
    const prior = await registry.listForWebsite(websiteId);
    if (!Array.isArray(prior) || prior.some((operation) => operation?.websiteId !== websiteId)) {
      throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'The removal operation history could not be verified.', 409);
    }
    // A failed operation may have partially removed resources. Continue it explicitly;
    // starting a second operation must not erase its unfinished cleanup history.
    if (prior.some((operation) => operation.status !== 'removed')) {
      throw new WebsiteRemovalRuntimeError('website_removal_operation_in_progress', 'Continue the existing removal operation before starting another.', 409);
    }
    const op = await registry.create(currentPreview);
    return runNextStep(op.id);
  }

  async function continueStep({
    websiteId,
    operationId,
    stepId,
    expectedUpdatedAt,
    confirmation,
  } = {}) {
    const op = await loadOperation(operationId);
    if (op.websiteId !== websiteId) {
      throw new WebsiteRemovalRuntimeError('operation_not_found', 'Operation not found', 404);
    }

    const step = firstIncomplete(op);
    const expectedConf = step ? stepContinuationConfirmation(op, step) : null;
    if (!step || op.status === 'removed' || step.id !== stepId || op.updatedAt !== expectedUpdatedAt
      || confirmation !== expectedConf) {
      throw new WebsiteRemovalRuntimeError(
        'website_removal_step_continuation_stale',
        'Website removal step continuation is stale or confirmation is invalid',
        409,
      );
    }

    return runNextStep(op.id);
  }

  async function runDomainRemovalStep(op, step) {
    const domainId = step.resourceId;
    let domainOps = [];
    if (typeof domainRemovalRuntime.listForDomain === 'function') {
      domainOps = await domainRemovalRuntime.listForDomain(domainId);
    }

    let activeChild = domainOps.find((dOp) => dOp.status !== 'removed' && dOp.status !== 'failed');
    if (!activeChild) {
      // Check if domain is already removed
      const lastOp = domainOps.find((dOp) => dOp.status === 'removed');
      if (lastOp) {
        return registry.succeedStep(op.id, step.id, { domainRemoved: true, domainId });
      }

      // Start new domain removal operation
      const domainPreview = await domainRemovalRuntime.preview({ domainId });
      if (!domainPreview || !domainPreview.confirmation) {
        return registry.blockStep(op.id, step.id, {
          code: 'domain_removal_not_ready',
          message: `Domain removal for ${domainId} is not ready to start`,
        });
      }
      activeChild = await domainRemovalRuntime.start({ confirmation: domainPreview.confirmation });
    } else {
      // Advance existing child operation
      if (activeChild.actions?.routingRetryConfirmation) {
        activeChild = await domainRemovalRuntime.retryRouting({
          domainId: activeChild.domainId,
          operationId: activeChild.id,
          expectedUpdatedAt: activeChild.updatedAt,
          checksum: activeChild.checksum,
          confirmation: activeChild.actions.routingRetryConfirmation,
        });
      } else if (activeChild.actions?.stepContinuationConfirmation) {
        const confParts = activeChild.actions.stepContinuationConfirmation.split(':');
        const stepIdFromConf = confParts[3];
        const childStep = activeChild.steps?.find((s) => s.status !== 'succeeded') ?? { id: stepIdFromConf };
        if (childStep && childStep.id) {
          activeChild = await domainRemovalRuntime.continueStep({
            domainId: activeChild.domainId,
            operationId: activeChild.id,
            stepId: childStep.id,
            expectedUpdatedAt: activeChild.updatedAt,
            checksum: activeChild.checksum,
            confirmation: activeChild.actions.stepContinuationConfirmation,
          });
        }
      }
    }

    if (activeChild.status === 'removed') {
      return registry.succeedStep(op.id, step.id, { domainRemoved: true, domainId });
    }

    if (activeChild.status === 'failed' || activeChild.status === 'blocked') {
      return registry.blockStep(op.id, step.id, {
        code: 'child_domain_removal_blocked',
        message: `Child domain removal for ${domainId} is ${activeChild.status}`,
      });
    }

    // Step is still running, waiting for domain removal to complete
    return registry.get(op.id);
  }

  async function runNextStep(operationId) {
    let op = await loadOperation(operationId);
    const step = firstIncomplete(op);
    if (!step) return publicOperation(op);

    await registry.markStepRunning(op.id, step.id);
    op = await loadOperation(operationId);

    try {
      switch (step.kind) {
        case 'domain_removal': {
          op = await runDomainRemovalStep(op, step);
          break;
        }

        case 'cron_cleanup': {
          requireCleanupMethod(websiteCronRegistry?.listTasks);
          requireCleanupMethod(websiteCronRegistry?.removeTask);
          if (websiteCronRegistry && typeof websiteCronRegistry.listTasks === 'function') {
            const tasks = cleanupInventory(await websiteCronRegistry.listTasks({ websiteId: op.websiteId }));
            for (const task of tasks) {
              if (typeof websiteCronRegistry.removeTask === 'function') {
                await websiteCronRegistry.removeTask(task.id);
              }
            }
          }
          op = await registry.succeedStep(op.id, step.id, { cronsCleaned: true });
          break;
        }

        case 'sftp_key_cleanup': {
          requireCleanupMethod(websiteSftpKeyRegistry?.listKeys);
          requireCleanupMethod(websiteSftpKeyRegistry?.revokeKey);
          const keys = cleanupInventory(await websiteSftpKeyRegistry.listKeys({ websiteId: op.websiteId }));
          for (const key of keys) {
            if (!Number.isSafeInteger(key.revision) || key.revision < 1) {
              throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Reload the current SFTP key revision.', 409);
            }
            // Use the actual registry signature once. Never retry an exception with a weaker signature.
            await websiteSftpKeyRegistry.revokeKey({ websiteId: op.websiteId, keyId: key.id, expectedRevision: key.revision });
          }
          op = await registry.succeedStep(op.id, step.id, { sftpKeysCleaned: true });
          break;
        }

        case 'database_binding_cleanup': {
          requireCleanupMethod(databaseBindingRegistry?.listBindings);
          requireCleanupMethod(databaseBindingRegistry?.unbindDatabase ?? databaseBindingRegistry?.removeBinding);
          requireCleanupMethod(databaseCredentialRegistry?.getForBinding);
          requireCleanupMethod(databaseCredentialRegistry?.deleteCredential);
          const unboundBindings = [];
          if (databaseBindingRegistry && typeof databaseBindingRegistry.listBindings === 'function') {
            const bindings = cleanupInventory(await databaseBindingRegistry.listBindings({ websiteId: op.websiteId }));
            for (const binding of bindings) {
              if (databaseCredentialRegistry && typeof databaseCredentialRegistry.getForBinding === 'function') {
                const credential = await databaseCredentialRegistry.getForBinding(binding.id);
                if (credential && typeof databaseCredentialRegistry.deleteCredential === 'function') {
                  await databaseCredentialRegistry.deleteCredential(credential.id, {
                    expectedRevision: credential.revision,
                    confirmation: `delete-database-credential:${credential.id}:${credential.revision}`,
                  });
                }
              }
              if (typeof databaseBindingRegistry.unbindDatabase === 'function') {
                await databaseBindingRegistry.unbindDatabase(binding.id, {
                  expectedRevision: binding.revision ?? 1,
                  confirmation: `unbind-database:${binding.id}:${binding.revision ?? 1}`,
                });
                unboundBindings.push({
                  id: binding.id,
                  databaseName: binding.databaseName,
                  revision: binding.revision,
                  unbound: true,
                });
              } else if (typeof databaseBindingRegistry.removeBinding === 'function') {
                await databaseBindingRegistry.removeBinding(binding.id);
                unboundBindings.push({
                  id: binding.id,
                  unbound: true,
                });
              }
            }
          }
          op = await registry.succeedStep(op.id, step.id, {
            databaseBindingsCleaned: true,
            unboundBindings,
          });
          break;
        }

        case 'runtime_cleanup': {
          requireCleanupMethod(runtimeBindingRegistry?.getBinding);
          requireCleanupMethod(runtimeBindingRegistry?.removeOwnedPassenger);
          if (runtimeBindingRegistry && typeof runtimeBindingRegistry.getBinding === 'function') {
            const binding = await runtimeBindingRegistry.getBinding(op.applicationId);
            if (binding && typeof runtimeBindingRegistry.removeOwnedPassenger === 'function') {
              await runtimeBindingRegistry.removeOwnedPassenger(op.applicationId, {
                operationId: op.id,
                expectedRevision: binding.revision,
              });
            }
          }
          op = await registry.succeedStep(op.id, step.id, { runtimeCleaned: true });
          break;
        }

        case 'file_cleanup': {
          requireCleanupMethod(fileCleanupHandler);
          const retainedBackups = [...(op.plan?.additional?.backups?.ids ?? [])];
          const cleanupResult = await fileCleanupHandler({
            websiteId: op.websiteId, applicationId: op.applicationId, retainedBackups: [...retainedBackups],
          });
          requireCleanupReceipt(cleanupResult, { websiteId: op.websiteId, applicationId: op.applicationId }, 'filesCleaned');
          if (!Array.isArray(cleanupResult.retainedBackups)
            || cleanupResult.retainedBackups.length !== retainedBackups.length
            || [...cleanupResult.retainedBackups].sort().some((id, index) => id !== [...retainedBackups].sort()[index])) {
            throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Retained backup scope was not verified.', 409);
          }
          // Do not copy arbitrary adapter fields or secrets into the public operation result.
          op = await registry.succeedStep(op.id, step.id, {
            filesCleaned: true, retainedBackups,
            ...(Number.isSafeInteger(cleanupResult.cleanedFilesCount) && cleanupResult.cleanedFilesCount >= 0
              ? { cleanedFilesCount: cleanupResult.cleanedFilesCount } : {}),
          });
          break;
        }

        case 'unix_identity_cleanup': {
          requireCleanupMethod(unixIdentityCleanupHandler);
          const expected = { systemUser: step.resourceId, websiteId: op.websiteId };
          const result = await unixIdentityCleanupHandler({ ...expected });
          requireCleanupReceipt(result, expected, 'unixIdentityCleaned');
          op = await registry.succeedStep(op.id, step.id, { unixIdentityCleaned: true });
          break;
        }

        case 'metadata_finalization': {
          requireCleanupMethod(websiteRegistry?.getWebsite);
          requireCleanupMethod(websiteRegistry?.deleteMigrationWebsite);
          const current = await websiteRegistry.getWebsite(op.websiteId);
          if (current !== null) {
            if (!current || current.id !== op.websiteId || current.serverId !== op.serverId
              || current.applicationId !== op.applicationId) {
              throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Website identity changed during removal.', 409);
            }
            await websiteRegistry.deleteMigrationWebsite({
              websiteId: op.websiteId, applicationId: op.applicationId, serverId: op.serverId,
            });
          }
          // A delete response or exception is not evidence that persistence is gone.
          if (await websiteRegistry.getWebsite(op.websiteId) !== null) {
            throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Website metadata is still present or unavailable.', 409);
          }
          op = await registry.succeedStep(op.id, step.id, { finalized: true });
          break;
        }

        case 'application_cleanup': {
          requireCleanupMethod(applicationRegistry?.getApplication);
          requireCleanupMethod(applicationRegistry?.deleteApplication);
          requireCleanupMethod(applicationEnvironmentRegistry?.inspectApplicationState);
          requireCleanupMethod(applicationEnvironmentRegistry?.purgeApplication);
          if (!op.applicationId || step.resourceId !== op.applicationId) {
            throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Application cleanup identity does not match removal journal.', 409);
          }
          // Website metadata must already be gone before Application deletion.
          if (await websiteRegistry.getWebsite(op.websiteId) !== null) {
            throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Website metadata must be removed before Application cleanup.', 409);
          }
          const currentApplication = await applicationRegistry.getApplication(op.applicationId);
          if (currentApplication !== null) {
            if (!currentApplication || currentApplication.id !== op.applicationId
              || currentApplication.serverId !== op.serverId
              || currentApplication.desiredRevision !== op.websiteRevision
              || currentApplication.activeDeploymentId !== null) {
              throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Application identity or revision changed during removal.', 409);
            }
            await applicationEnvironmentRegistry.purgeApplication(op.applicationId);
            const environmentAfter = await applicationEnvironmentRegistry.inspectApplicationState(op.applicationId);
            if (environmentAfter.variableCount !== 0 || environmentAfter.environmentPresent) {
              throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Application environment state is still present.', 409);
            }
            await applicationRegistry.deleteApplication({
              applicationId: op.applicationId,
              expectedServerId: op.serverId,
              expectedDesiredRevision: op.websiteRevision,
            });
          } else {
            // Explicit continuation after a crash may observe metadata already gone.
            const environmentAfter = await applicationEnvironmentRegistry.inspectApplicationState(op.applicationId);
            if (environmentAfter.variableCount !== 0 || environmentAfter.environmentPresent) {
              throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Application metadata is absent but environment state remains.', 409);
            }
          }
          if (await applicationRegistry.getApplication(op.applicationId) !== null) {
            throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Application metadata is still present.', 409);
          }
          op = await registry.succeedStep(op.id, step.id, { applicationCleaned: true });
          break;
        }

        default:
          throw new WebsiteRemovalRuntimeError(
            'unknown_step_kind',
            `Unknown step kind: ${step.kind}`,
            500,
          );
      }
    } catch (err) {
      const known = err instanceof WebsiteRemovalRuntimeError;
      const error = {
        code: typeof err?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(err.code) ? err.code : 'website_removal_step_failed',
        message: known ? err.message : 'Cleanup failed. Check the server diagnostics before explicitly continuing.',
      };
      const blocked = known && ['website_removal_cleanup_unavailable', 'website_removal_cleanup_unverified'].includes(err.code);
      op = await registry[blocked ? 'blockStep' : 'failStep'](op.id, step.id, error);
    }

    return publicOperation(op);
  }

  async function get(operationId) {
    return publicOperation(await registry.get(operationId));
  }

  async function listForWebsite(websiteId) {
    const list = await registry.listForWebsite(websiteId);
    return list.map(publicOperation);
  }

  return Object.freeze({
    init,
    preview,
    start: (input) => withWebsiteMutation(input, start),
    continueStep: (input) => withWebsiteMutation(input, continueStep),
    get,
    listForWebsite,
  });
}
