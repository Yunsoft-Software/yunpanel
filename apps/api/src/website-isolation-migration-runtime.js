import {
  websiteIsolationMigrationPublicView,
  WebsiteIsolationMigrationRegistryError,
} from './website-isolation-migration-registry.js';
import { WebsiteIsolationAuditError } from './website-isolation-audit.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class WebsiteIsolationMigrationRuntimeError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteIsolationMigrationRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function mapped(error) {
  if (error instanceof WebsiteIsolationMigrationRuntimeError) return error;
  if (error instanceof WebsiteIsolationMigrationRegistryError || error instanceof WebsiteIsolationAuditError) {
    return new WebsiteIsolationMigrationRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function safeCode(error, fallback) {
  return typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code) ? error.code : fallback;
}

function workspaceIntent(operation) {
  return Object.freeze({
    websiteId: operation.websiteId,
    applicationId: operation.applicationId,
    user: operation.intent.user,
    homeDirectory: operation.intent.homeDirectory,
  });
}

function exactTargets(operation, audit) {
  const change = audit?.migration?.changes?.length === 1 ? audit.migration.changes[0] : null;
  return Boolean(audit?.websiteId === operation.websiteId
    && audit.applicationId === operation.applicationId
    && audit.websiteRevision === operation.websiteRevision
    && audit.migration?.applyAvailable === true
    && audit.migration.previewDigest === operation.previewDigest
    && change?.action === 'create_workspace_directories'
    && JSON.stringify(change.desired?.directories) === JSON.stringify(operation.intent.targets));
}

function applyEvidence(value) {
  if (!value || value.satisfied !== true || value.workspaceReceiptVersion !== 1
    || !Number.isSafeInteger(value.createdWorkspaceDirectories)
    || value.createdWorkspaceDirectories < 0 || value.createdWorkspaceDirectories > 2) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_evidence_invalid',
      'Website workspace migration did not return valid operation ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    workspaceReceiptVersion: 1,
    createdWorkspaceDirectories: value.createdWorkspaceDirectories,
  });
}

function inspectionEvidence(value) {
  if (!value || value.satisfied !== true) return null;
  if (value.workspaceReceiptVersion === undefined) {
    return Object.freeze({ satisfied: true, createdWorkspaceDirectories: 0 });
  }
  return applyEvidence(value);
}

function compensationEvidence(value) {
  if (!value || value.satisfied !== true
    || !Number.isSafeInteger(value.removedWorkspaceDirectories)
    || value.removedWorkspaceDirectories < 0 || value.removedWorkspaceDirectories > 2) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_compensation_evidence_invalid',
      'Website workspace migration rollback did not return valid ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    removedWorkspaceDirectories: value.removedWorkspaceDirectories,
  });
}

export function createWebsiteIsolationMigrationRuntime({ registry, auditService, workspaceManager } = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForWebsite !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.markApplying !== 'function'
    || typeof registry.succeed !== 'function' || typeof registry.fail !== 'function'
    || typeof registry.markCompensating !== 'function' || typeof registry.compensate !== 'function'
    || typeof registry.failCompensation !== 'function'
    || !auditService || typeof auditService.audit !== 'function'
    || !workspaceManager || typeof workspaceManager.inspectWorkspace !== 'function'
    || typeof workspaceManager.inspectWorkspaceOperation !== 'function'
    || typeof workspaceManager.applyWorkspace !== 'function'
    || typeof workspaceManager.inspectWorkspaceCompensation !== 'function'
    || typeof workspaceManager.compensateWorkspace !== 'function') {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_dependencies_invalid',
      'Website isolation migration dependencies are unavailable',
      503,
    );
  }
  const applyFlights = new Map();
  const rollbackFlights = new Map();

  function singleFlight(flights, operationId, execute) {
    const key = typeof operationId === 'string' ? operationId.toLowerCase() : operationId;
    const active = flights.get(key);
    if (active) return active;
    const flight = Promise.resolve().then(execute).finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    flights.set(key, flight);
    return flight;
  }

  async function audit(websiteId) {
    try { return await auditService.audit(websiteId); }
    catch (error) { throw mapped(error); }
  }

  async function getRequired(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) throw new WebsiteIsolationMigrationRuntimeError('website_isolation_migration_not_found', 'Website isolation migration was not found', 404);
    return operation;
  }

  async function executeRun(operationId) {
    let operation = await getRequired(operationId);
    if (['succeeded', 'failed', 'compensated', 'compensation_failed'].includes(operation.status)) {
      return websiteIsolationMigrationPublicView(operation);
    }
    if (operation.status !== 'pending' && operation.status !== 'applying') {
      throw new WebsiteIsolationMigrationRuntimeError('website_isolation_migration_transition_invalid', 'Website isolation migration is not runnable');
    }
    const mayApply = operation.status === 'pending';
    if (mayApply) {
      try { operation = await registry.markApplying(operation.id); }
      catch (error) { throw mapped(error); }
    }

    const intent = workspaceIntent(operation);
    let inspected;
    try { inspected = await workspaceManager.inspectWorkspaceOperation(intent, { operationId: operation.id }); }
    catch (error) {
      if (!mayApply) {
        throw new WebsiteIsolationMigrationRuntimeError(
          'website_isolation_migration_recovery_pending',
          'Interrupted Website isolation migration could not be inspected and was not replayed',
          503,
        );
      }
      try { return websiteIsolationMigrationPublicView(await registry.fail(operation.id, safeCode(error, 'website_isolation_migration_inspection_failed'))); }
      catch (registryError) { throw mapped(registryError); }
    }
    const alreadySatisfied = inspectionEvidence(inspected);
    if (alreadySatisfied) {
      try { return websiteIsolationMigrationPublicView(await registry.succeed(operation.id, alreadySatisfied)); }
      catch (error) { throw mapped(error); }
    }
    if (!mayApply) {
      throw new WebsiteIsolationMigrationRuntimeError(
        'website_isolation_migration_recovery_pending',
        'Interrupted Website isolation migration remains incomplete and was not replayed',
        409,
      );
    }

    let current;
    try { current = await audit(operation.websiteId); }
    catch (error) {
      return websiteIsolationMigrationPublicView(await registry.fail(operation.id, safeCode(error, 'website_isolation_migration_preview_unavailable')));
    }
    if (!exactTargets(operation, current)) {
      return websiteIsolationMigrationPublicView(await registry.fail(operation.id, 'website_isolation_migration_preview_stale'));
    }

    try {
      const result = applyEvidence(await workspaceManager.applyWorkspace(intent, { operationId: operation.id }));
      return websiteIsolationMigrationPublicView(await registry.succeed(operation.id, result));
    } catch (error) {
      try {
        const postcondition = inspectionEvidence(await workspaceManager.inspectWorkspaceOperation(intent, { operationId: operation.id }));
        if (postcondition) {
          return websiteIsolationMigrationPublicView(await registry.succeed(operation.id, postcondition));
        }
      } catch {
        // The durable operation and workspace receipt remain the recovery authority.
      }
      return websiteIsolationMigrationPublicView(await registry.fail(operation.id, safeCode(error, 'website_isolation_migration_apply_failed')));
    }
  }

  function run(operationId) {
    return singleFlight(applyFlights, operationId, () => executeRun(operationId));
  }

  async function start({ websiteId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new WebsiteIsolationMigrationRuntimeError('website_isolation_migration_preview_invalid', 'Current Website isolation migration preview digest is required', 400);
    }
    const current = await audit(websiteId);
    if (current.migration?.applyAvailable !== true
      || current.migration.previewDigest !== previewDigest
      || current.migration.confirmation !== confirmation) {
      throw new WebsiteIsolationMigrationRuntimeError(
        'website_isolation_migration_confirmation_invalid',
        'Website isolation migration preview is stale, blocked or confirmation is invalid',
        409,
      );
    }
    let operation;
    try { operation = await registry.create(current); }
    catch (error) { throw mapped(error); }
    return run(operation.id);
  }

  async function executeRollback(operationId) {
    let operation = await getRequired(operationId);
    if (operation.status === 'compensated') return websiteIsolationMigrationPublicView(operation);
    if (!['succeeded', 'failed', 'compensation_failed', 'compensating'].includes(operation.status)) {
      throw new WebsiteIsolationMigrationRuntimeError('website_isolation_migration_rollback_invalid', 'Website isolation migration cannot be rolled back from its current state');
    }
    if (operation.status !== 'compensating') {
      try { operation = await registry.markCompensating(operation.id); }
      catch (error) { throw mapped(error); }
    }
    const intent = workspaceIntent(operation);
    try {
      const inspected = await workspaceManager.inspectWorkspaceCompensation(intent, { operationId: operation.id });
      if (inspected?.satisfied === true) {
        return websiteIsolationMigrationPublicView(await registry.compensate(operation.id, compensationEvidence(inspected)));
      }
      const result = compensationEvidence(await workspaceManager.compensateWorkspace(intent, { operationId: operation.id }));
      return websiteIsolationMigrationPublicView(await registry.compensate(operation.id, result));
    } catch (error) {
      return websiteIsolationMigrationPublicView(await registry.failCompensation(
        operation.id,
        safeCode(error, 'website_isolation_migration_compensation_failed'),
      ));
    }
  }

  async function rollback({ operationId, confirmation } = {}) {
    const operation = await getRequired(operationId);
    const expected = `rollback-isolation-migration:${operation.id}:${operation.previewDigest}`;
    if (confirmation !== expected) {
      throw new WebsiteIsolationMigrationRuntimeError(
        'website_isolation_migration_rollback_confirmation_invalid',
        `Confirm Website isolation migration rollback with ${expected}`,
        400,
      );
    }
    return singleFlight(rollbackFlights, operation.id, () => executeRollback(operation.id));
  }

  async function init() {
    try { await registry.init(); }
    catch (error) { throw mapped(error); }
    const interrupted = await registry.listInterrupted();
    const recovery = [];
    for (const operation of interrupted) {
      const intent = workspaceIntent(operation);
      try {
        if (operation.status === 'applying') {
          const result = inspectionEvidence(await workspaceManager.inspectWorkspaceOperation(intent, { operationId: operation.id }));
          if (result) {
            recovery.push(Object.freeze({ operationId: operation.id, recovered: true }));
            await registry.succeed(operation.id, result);
          } else {
            recovery.push(Object.freeze({ operationId: operation.id, recovered: false, reason: 'apply_incomplete' }));
          }
        } else {
          const result = await workspaceManager.inspectWorkspaceCompensation(intent, { operationId: operation.id });
          if (result?.satisfied === true) {
            recovery.push(Object.freeze({ operationId: operation.id, recovered: true }));
            await registry.compensate(operation.id, compensationEvidence(result));
          } else {
            recovery.push(Object.freeze({ operationId: operation.id, recovered: false, reason: 'compensation_incomplete' }));
          }
        }
      } catch {
        recovery.push(Object.freeze({ operationId: operation.id, recovered: false, reason: 'inspection_unavailable' }));
      }
    }
    return Object.freeze(recovery);
  }

  return Object.freeze({
    init,
    audit,
    start,
    run,
    rollback,
    get: async (operationId) => websiteIsolationMigrationPublicView(await getRequired(operationId)),
    listForWebsite: async (websiteId) => Object.freeze((await registry.listForWebsite(websiteId)).map(websiteIsolationMigrationPublicView)),
  });
}

export const websiteIsolationMigrationRuntimeInternals = Object.freeze({
  exactTargets,
  workspaceIntent,
  applyEvidence,
  inspectionEvidence,
  compensationEvidence,
});
