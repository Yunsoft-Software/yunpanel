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

  async function preview({ websiteId } = {}) {
    return previewProvider({ websiteId });
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
          if (websiteCronRegistry && typeof websiteCronRegistry.listTasks === 'function') {
            const tasks = await websiteCronRegistry.listTasks({ websiteId: op.websiteId });
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
          if (websiteSftpKeyRegistry && typeof websiteSftpKeyRegistry.listKeys === 'function') {
            let keys = [];
            try {
              keys = await websiteSftpKeyRegistry.listKeys({ websiteId: op.websiteId });
            } catch {
              keys = await websiteSftpKeyRegistry.listKeys(op.websiteId);
            }
            for (const key of (keys || [])) {
              if (typeof websiteSftpKeyRegistry.revokeKey === 'function') {
                if (websiteSftpKeyRegistry.revokeKey.length === 1) {
                  await websiteSftpKeyRegistry.revokeKey(key.id);
                } else {
                  try {
                    await websiteSftpKeyRegistry.revokeKey({
                      websiteId: op.websiteId,
                      keyId: key.id,
                      expectedRevision: key.revision ?? 1,
                    });
                  } catch {
                    await websiteSftpKeyRegistry.revokeKey(key.id);
                  }
                }
              }
            }
          }
          op = await registry.succeedStep(op.id, step.id, { sftpKeysCleaned: true });
          break;
        }

        case 'database_binding_cleanup': {
          const unboundBindings = [];
          if (databaseBindingRegistry && typeof databaseBindingRegistry.listBindings === 'function') {
            const bindings = await databaseBindingRegistry.listBindings({ websiteId: op.websiteId });
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
          let cleanupResult = null;
          if (typeof fileCleanupHandler === 'function') {
            cleanupResult = await fileCleanupHandler({
              websiteId: op.websiteId,
              applicationId: op.applicationId,
              retainedBackups: op.plan?.additional?.backups?.ids ?? [],
            });
          }
          op = await registry.succeedStep(op.id, step.id, {
            filesCleaned: true,
            retainedBackups: op.plan?.additional?.backups?.ids ?? [],
            ...(cleanupResult && typeof cleanupResult === 'object' ? cleanupResult : {}),
          });
          break;
        }

        case 'unix_identity_cleanup': {
          if (typeof unixIdentityCleanupHandler === 'function') {
            await unixIdentityCleanupHandler({
              systemUser: step.resourceId,
              websiteId: op.websiteId,
            });
          }
          op = await registry.succeedStep(op.id, step.id, { unixIdentityCleaned: true });
          break;
        }

        case 'metadata_finalization': {
          if (websiteRegistry && typeof websiteRegistry.deleteMigrationWebsite === 'function') {
            await websiteRegistry.deleteMigrationWebsite({
              websiteId: op.websiteId,
              applicationId: op.applicationId,
              serverId: op.serverId,
            }).catch(() => {}); // tolerate already removed
          }
          op = await registry.succeedStep(op.id, step.id, { finalized: true });
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
      op = await registry.failStep(op.id, step.id, {
        code: err.code ?? 'step_execution_failed',
        message: err.message,
      });
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
