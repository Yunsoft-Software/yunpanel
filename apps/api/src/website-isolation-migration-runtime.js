import {
  websiteIsolationMigrationPublicView,
  WebsiteIsolationMigrationRegistryError,
} from './website-isolation-migration-registry.js';
import { WebsiteIsolationAuditError } from './website-isolation-audit.js';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';

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

function migrationKind(operation) {
  return operation?.intent?.adapter
    ?? (operation?.intent?.targets?.length === 0 ? 'identity' : 'workspace');
}

function sftpContext(operation) {
  return Object.freeze({
    operationId: operation.id,
    websiteId: operation.websiteId,
    intent: Object.freeze({
      adapter: 'openssh-internal-sftp',
      websiteId: operation.websiteId,
      applicationId: operation.applicationId,
      unixUser: operation.intent.user,
    }),
  });
}

function phpContext(operation) {
  const identity = createApplicationIdentity(operation.applicationId);
  return Object.freeze({
    operationId: operation.id,
    releaseOperationId: operation.intent.sourceOperationId,
    websiteId: operation.websiteId,
    intent: Object.freeze({
      adapter: 'php-fpm',
      websiteId: operation.websiteId,
      applicationId: operation.applicationId,
      unixUser: operation.intent.user,
      documentRoot: `${identity.paths.runtime.currentRelease}/public`,
    }),
  });
}

function staticControlContext(operation) {
  return Object.freeze({
    operationId: operation.id,
    sourceOperationId: operation.intent.sourceOperationId,
    websiteId: operation.websiteId,
    intent: Object.freeze({
      websiteId: operation.websiteId,
      applicationId: operation.applicationId,
    }),
  });
}

function exactIdentityTarget(operation, change) {
  return Boolean(change?.action === 'create_canonical_unix_identity'
    && change.current?.identityMigrationPreview?.safeCreateCandidate === true
    && change.desired?.identity?.user === operation.intent.user
    && change.desired?.identity?.homeDirectory === operation.intent.homeDirectory);
}

function exactSftpTarget(operation, change) {
  return Boolean(change?.action === 'create_sftp_isolation'
    && change.current?.sftpMigrationPreview?.safeCreateCandidate === true
    && change.desired?.sftp?.websiteId === operation.websiteId
    && change.desired?.sftp?.applicationId === operation.applicationId
    && change.desired?.sftp?.unixUser === operation.intent.user);
}

function exactPhpTarget(operation, change) {
  const identity = createApplicationIdentity(operation.applicationId);
  return Boolean(change?.action === 'create_php_fpm_pool'
    && change.current?.operationId === operation.intent.sourceOperationId
    && change.current?.phpRuntimeMigrationPreview?.safeCreateCandidate === true
    && change.desired?.phpRuntime?.websiteId === operation.websiteId
    && change.desired?.phpRuntime?.applicationId === operation.applicationId
    && change.desired?.phpRuntime?.unixUser === operation.intent.user
    && change.desired?.phpRuntime?.documentRoot === `${identity.paths.runtime.currentRelease}/public`
    && change.desired?.phpRuntime?.runtimeUmask === '0027');
}

function exactPhpContainerTarget(operation, change) {
  const identity = createApplicationIdentity(operation.applicationId);
  return Boolean(change?.action === 'repair_php_container_metadata'
    && change.current?.operationId === operation.intent.sourceOperationId
    && change.current?.phpRuntimeMigrationPreview?.safeContainerMigrationCandidate === true
    && change.current?.phpRuntimeMigrationPreview?.current?.container?.safeMigrationCandidate === true
    && change.desired?.phpContainer?.websiteId === operation.websiteId
    && change.desired?.phpContainer?.applicationId === operation.applicationId
    && change.desired?.phpContainer?.releaseId === operation.intent.sourceOperationId
    && change.desired?.phpContainer?.unixUser === operation.intent.user
    && change.desired?.phpContainer?.documentRoot === `${identity.paths.runtime.currentRelease}/public`
    && change.desired?.phpContainer?.applicationRoot === identity.paths.runtime.applicationRoot
    && change.desired?.phpContainer?.releasesDirectory === identity.paths.runtime.releasesDirectory
    && change.desired?.phpContainer?.currentRelease === identity.paths.runtime.currentRelease
    && change.desired?.phpContainer?.releaseDirectory === `${identity.paths.runtime.releasesDirectory}/${operation.intent.sourceOperationId}`
    && change.desired?.phpContainer?.releaseDocumentRoot === `${identity.paths.runtime.releasesDirectory}/${operation.intent.sourceOperationId}/public`);
}

function exactStaticControlTarget(operation, change) {
  const identity = createApplicationIdentity(operation.applicationId);
  const publishRoot = identity.paths.static.publishRoot;
  return Boolean(change?.action === 'repair_static_control_metadata'
    && change.current?.operationId === operation.intent.sourceOperationId
    && change.current?.staticRuntimeMigrationPreview?.safeControlMigrationCandidate === true
    && change.current?.staticRuntimeMigrationPreview?.current?.isolation?.safeMigrationCandidate === true
    && change.desired?.staticControl?.websiteId === operation.websiteId
    && change.desired?.staticControl?.applicationId === operation.applicationId
    && change.desired?.staticControl?.unixUser === operation.intent.user
    && change.desired?.staticControl?.homeDirectory === operation.intent.homeDirectory
    && change.desired?.staticControl?.publishRoot === publishRoot
    && change.desired?.staticControl?.releasesRoot === `${publishRoot}/releases`
    && change.desired?.staticControl?.currentPath === `${publishRoot}/current`
    && change.desired?.staticControl?.controlDirectoryMode === '0711'
    && change.desired?.staticControl?.releaseDirectoryMode === '0750'
    && change.desired?.staticControl?.releaseFileMode === '0640'
    && change.desired?.staticControl?.nginxDirectoryAcl === 'user:www-data:r-x'
    && change.desired?.staticControl?.nginxFileAcl === 'user:www-data:r--'
    && change.desired?.staticControl?.aclPackage === 'acl');
}

function exactTargets(operation, audit) {
  const change = audit?.migration?.changes?.length === 1 ? audit.migration.changes[0] : null;
  const kind = migrationKind(operation);
  const exactChange = kind === 'identity'
    ? exactIdentityTarget(operation, change)
    : kind === 'sftp'
      ? exactSftpTarget(operation, change)
      : kind === 'php'
        ? exactPhpTarget(operation, change)
        : kind === 'php_container'
          ? exactPhpContainerTarget(operation, change)
          : kind === 'static_control'
            ? exactStaticControlTarget(operation, change)
            : change?.action === 'create_workspace_directories'
        && JSON.stringify(change.desired?.directories) === JSON.stringify(operation.intent.targets);
  return Boolean(audit?.websiteId === operation.websiteId
    && audit.applicationId === operation.applicationId
    && audit.websiteRevision === operation.websiteRevision
    && audit.migration?.applyAvailable === true
    && audit.migration.previewDigest === operation.previewDigest
    && exactChange);
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

function identityApplyEvidence(value) {
  if (!value || value.satisfied !== true
    || value.identityReceiptVersion !== 1
    || value.createdUnixIdentity !== true) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_evidence_invalid',
      'Website Unix identity migration did not return valid operation ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    identityReceiptVersion: 1,
    createdUnixIdentity: true,
  });
}

function identityInspectionEvidence(value) {
  if (!value || value.satisfied !== true) return null;
  return identityApplyEvidence(value);
}

function identityCompensationEvidence(value) {
  if (!value || value.satisfied !== true
    || typeof value.removedUser !== 'boolean'
    || typeof value.removedGroup !== 'boolean'
    || typeof value.removedHome !== 'boolean'
    || (value.preservedHomeData !== undefined && typeof value.preservedHomeData !== 'boolean')) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_compensation_evidence_invalid',
      'Website Unix identity migration rollback did not return valid ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    removedUser: value.removedUser,
    removedGroup: value.removedGroup,
    removedHome: value.removedHome,
    ...(value.preservedHomeData === undefined ? {} : { preservedHomeData: value.preservedHomeData }),
  });
}

function sftpApplyEvidence(value) {
  if (!value || value.satisfied !== true
    || value.sftpReceiptVersion !== 1
    || value.activatedSftpIsolation !== true
    || !Number.isSafeInteger(value.authorizedKeyCount) || value.authorizedKeyCount < 0 || value.authorizedKeyCount > 100
    || typeof value.authorizedKeysSha256 !== 'string' || !SHA256_PATTERN.test(value.authorizedKeysSha256)) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_evidence_invalid',
      'Website SFTP migration did not return valid operation ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    sftpReceiptVersion: 1,
    activatedSftpIsolation: true,
    authorizedKeyCount: value.authorizedKeyCount,
    authorizedKeysSha256: value.authorizedKeysSha256,
  });
}

function sftpInspectionEvidence(value) {
  if (!value || value.satisfied !== true) return null;
  return sftpApplyEvidence(value);
}

function sftpCompensationEvidence(value) {
  if (!value || value.satisfied !== true || value.removedSftpIsolation !== true) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_compensation_evidence_invalid',
      'Website SFTP migration rollback did not return valid ownership evidence',
      503,
    );
  }
  return Object.freeze({ satisfied: true, removedSftpIsolation: true });
}

function phpApplyEvidence(value) {
  if (!value || value.satisfied !== true
    || value.phpFpmReceiptVersion !== 1
    || value.createdPhpFpmPool !== true) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_evidence_invalid',
      'Website PHP-FPM migration did not return valid operation ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    phpFpmReceiptVersion: 1,
    createdPhpFpmPool: true,
  });
}

function phpInspectionEvidence(value) {
  if (!value || value.satisfied !== true) return null;
  return phpApplyEvidence(value);
}

function phpCompensationEvidence(value) {
  if (!value || value.satisfied !== true
    || typeof value.restoredPrevious !== 'boolean'
    || typeof value.preservedExisting !== 'boolean'
    || value.restoredPrevious !== false
    || value.preservedExisting !== false) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_compensation_evidence_invalid',
      'Website PHP-FPM migration rollback did not return valid operation ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    restoredPrevious: false,
    preservedExisting: false,
  });
}

function phpContainerApplyEvidence(value) {
  if (!value || value.satisfied !== true
    || value.phpContainerReceiptVersion !== 1
    || value.migratedPhpContainer !== true) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_evidence_invalid',
      'Website PHP container migration did not return valid operation ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    phpContainerReceiptVersion: 1,
    migratedPhpContainer: true,
  });
}

function phpContainerInspectionEvidence(value) {
  if (!value || value.satisfied !== true) return null;
  return phpContainerApplyEvidence(value);
}

function phpContainerCompensationEvidence(value) {
  if (!value || value.satisfied !== true || value.restoredPhpContainerMetadata !== true) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_compensation_evidence_invalid',
      'Website PHP container migration rollback did not return valid ownership evidence',
      503,
    );
  }
  return Object.freeze({ satisfied: true, restoredPhpContainerMetadata: true });
}

function staticControlApplyEvidence(value) {
  if (!value || value.satisfied !== true
    || value.staticControlReceiptVersion !== 1
    || value.migratedStaticControlMetadata !== true) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_evidence_invalid',
      'Website static control migration did not return valid operation ownership evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    staticControlReceiptVersion: 1,
    migratedStaticControlMetadata: true,
  });
}

function staticControlInspectionEvidence(value) {
  if (!value || value.satisfied !== true) return null;
  return staticControlApplyEvidence(value);
}

function staticControlCompensationEvidence(value) {
  if (!value || value.satisfied !== true || value.restoredStaticControlMetadata !== true) {
    throw new WebsiteIsolationMigrationRuntimeError(
      'website_isolation_migration_compensation_evidence_invalid',
      'Website static control migration rollback did not return valid ownership evidence',
      503,
    );
  }
  return Object.freeze({ satisfied: true, restoredStaticControlMetadata: true });
}

export function createWebsiteIsolationMigrationRuntime({
  registry,
  auditService,
  workspaceManager,
  migrationHandlers = {},
} = {}) {
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
    || typeof workspaceManager.compensateWorkspace !== 'function'
    || typeof workspaceManager.inspectIdentityOperation !== 'function'
    || typeof workspaceManager.applyIdentityMigration !== 'function'
    || typeof workspaceManager.inspectIdentityMigrationCompensation !== 'function'
    || typeof workspaceManager.compensateIdentityMigration !== 'function'
    || !migrationHandlers || typeof migrationHandlers !== 'object' || Array.isArray(migrationHandlers)) {
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
    const kind = migrationKind(operation);
    const sftpHandler = migrationHandlers.sftp;
    const phpHandler = migrationHandlers.php_runtime;
    const staticHandler = migrationHandlers.static_runtime;
    if (kind === 'sftp' && (!sftpHandler
      || typeof sftpHandler.inspectMigrationOperation !== 'function'
      || typeof sftpHandler.applyMigration !== 'function'
      || typeof sftpHandler.inspectMigrationCompensation !== 'function'
      || typeof sftpHandler.compensateMigration !== 'function')) {
      return websiteIsolationMigrationPublicView(
        await registry.fail(operation.id, 'website_isolation_migration_handler_unavailable'),
      );
    }
    if (kind === 'php' && (!phpHandler
      || typeof phpHandler.inspectMigrationOperation !== 'function'
      || typeof phpHandler.applyMigration !== 'function'
      || typeof phpHandler.inspectMigrationCompensation !== 'function'
      || typeof phpHandler.compensateMigration !== 'function')) {
      return websiteIsolationMigrationPublicView(
        await registry.fail(operation.id, 'website_isolation_migration_handler_unavailable'),
      );
    }
    if (kind === 'php_container' && (!phpHandler
      || typeof phpHandler.inspectContainerMigrationOperation !== 'function'
      || typeof phpHandler.applyContainerMigration !== 'function'
      || typeof phpHandler.inspectContainerMigrationCompensation !== 'function'
      || typeof phpHandler.compensateContainerMigration !== 'function')) {
      return websiteIsolationMigrationPublicView(
        await registry.fail(operation.id, 'website_isolation_migration_handler_unavailable'),
      );
    }
    if (kind === 'static_control' && (!staticHandler
      || typeof staticHandler.inspectControlMigrationOperation !== 'function'
      || typeof staticHandler.applyControlMigration !== 'function'
      || typeof staticHandler.inspectControlMigrationCompensation !== 'function'
      || typeof staticHandler.compensateControlMigration !== 'function')) {
      return websiteIsolationMigrationPublicView(
        await registry.fail(operation.id, 'website_isolation_migration_handler_unavailable'),
      );
    }
    let inspected;
    try {
      inspected = kind === 'identity'
        ? await workspaceManager.inspectIdentityOperation(intent, { operationId: operation.id })
        : kind === 'sftp'
          ? await sftpHandler.inspectMigrationOperation(sftpContext(operation))
          : kind === 'php'
            ? await phpHandler.inspectMigrationOperation(phpContext(operation))
            : kind === 'php_container'
              ? await phpHandler.inspectContainerMigrationOperation(phpContext(operation))
              : kind === 'static_control'
                ? await staticHandler.inspectControlMigrationOperation(staticControlContext(operation))
                : await workspaceManager.inspectWorkspaceOperation(intent, { operationId: operation.id });
    }
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
    const alreadySatisfied = kind === 'identity'
      ? identityInspectionEvidence(inspected)
      : kind === 'sftp'
        ? sftpInspectionEvidence(inspected)
        : kind === 'php'
          ? phpInspectionEvidence(inspected)
          : kind === 'php_container'
            ? phpContainerInspectionEvidence(inspected)
            : kind === 'static_control'
              ? staticControlInspectionEvidence(inspected)
              : inspectionEvidence(inspected);
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
      const result = kind === 'identity'
        ? identityApplyEvidence(await workspaceManager.applyIdentityMigration(intent, { operationId: operation.id }))
        : kind === 'sftp'
          ? sftpApplyEvidence(await sftpHandler.applyMigration(sftpContext(operation)))
          : kind === 'php'
            ? phpApplyEvidence(await phpHandler.applyMigration(phpContext(operation)))
            : kind === 'php_container'
              ? phpContainerApplyEvidence(await phpHandler.applyContainerMigration(phpContext(operation)))
              : kind === 'static_control'
                ? staticControlApplyEvidence(await staticHandler.applyControlMigration(staticControlContext(operation)))
                : applyEvidence(await workspaceManager.applyWorkspace(intent, { operationId: operation.id }));
      return websiteIsolationMigrationPublicView(await registry.succeed(operation.id, result));
    } catch (error) {
      try {
        const postInspection = kind === 'identity'
          ? await workspaceManager.inspectIdentityOperation(intent, { operationId: operation.id })
          : kind === 'sftp'
            ? await sftpHandler.inspectMigrationOperation(sftpContext(operation))
            : kind === 'php'
              ? await phpHandler.inspectMigrationOperation(phpContext(operation))
              : kind === 'php_container'
                ? await phpHandler.inspectContainerMigrationOperation(phpContext(operation))
                : kind === 'static_control'
                  ? await staticHandler.inspectControlMigrationOperation(staticControlContext(operation))
                  : await workspaceManager.inspectWorkspaceOperation(intent, { operationId: operation.id });
        const postcondition = kind === 'identity'
          ? identityInspectionEvidence(postInspection)
          : kind === 'sftp'
            ? sftpInspectionEvidence(postInspection)
            : kind === 'php'
              ? phpInspectionEvidence(postInspection)
              : kind === 'php_container'
                ? phpContainerInspectionEvidence(postInspection)
                : kind === 'static_control'
                  ? staticControlInspectionEvidence(postInspection)
                  : inspectionEvidence(postInspection);
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
    const kind = migrationKind(operation);
    const sftpHandler = migrationHandlers.sftp;
    const phpHandler = migrationHandlers.php_runtime;
    const staticHandler = migrationHandlers.static_runtime;
    try {
      const inspected = kind === 'identity'
        ? await workspaceManager.inspectIdentityMigrationCompensation(intent, {
          operationId: operation.id,
          evidence: operation.result,
        })
        : kind === 'sftp'
          ? await sftpHandler.inspectMigrationCompensation(sftpContext(operation))
          : kind === 'php'
            ? await phpHandler.inspectMigrationCompensation(phpContext(operation))
            : kind === 'php_container'
              ? await phpHandler.inspectContainerMigrationCompensation(phpContext(operation))
              : kind === 'static_control'
                ? await staticHandler.inspectControlMigrationCompensation(staticControlContext(operation))
                : await workspaceManager.inspectWorkspaceCompensation(intent, { operationId: operation.id });
      if (inspected?.satisfied === true) {
        const evidence = kind === 'identity'
          ? identityCompensationEvidence(inspected)
          : kind === 'sftp'
            ? sftpCompensationEvidence(inspected)
            : kind === 'php'
              ? phpCompensationEvidence(inspected)
              : kind === 'php_container'
                ? phpContainerCompensationEvidence(inspected)
                : kind === 'static_control'
                  ? staticControlCompensationEvidence(inspected)
                  : compensationEvidence(inspected);
        return websiteIsolationMigrationPublicView(await registry.compensate(operation.id, evidence));
      }
      const result = kind === 'identity'
        ? identityCompensationEvidence(await workspaceManager.compensateIdentityMigration(intent, {
          operationId: operation.id,
          evidence: operation.result,
        }))
        : kind === 'sftp'
          ? sftpCompensationEvidence(await sftpHandler.compensateMigration(sftpContext(operation)))
          : kind === 'php'
            ? phpCompensationEvidence(await phpHandler.compensateMigration(phpContext(operation)))
            : kind === 'php_container'
              ? phpContainerCompensationEvidence(await phpHandler.compensateContainerMigration(phpContext(operation)))
              : kind === 'static_control'
                ? staticControlCompensationEvidence(await staticHandler.compensateControlMigration(staticControlContext(operation)))
                : compensationEvidence(await workspaceManager.compensateWorkspace(intent, { operationId: operation.id }));
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
      const kind = migrationKind(operation);
      try {
        if (operation.status === 'applying') {
          const inspected = kind === 'identity'
            ? await workspaceManager.inspectIdentityOperation(intent, { operationId: operation.id })
            : kind === 'sftp'
              ? await migrationHandlers.sftp?.inspectMigrationOperation(sftpContext(operation))
              : kind === 'php'
                ? await migrationHandlers.php_runtime?.inspectMigrationOperation(phpContext(operation))
                : kind === 'php_container'
                  ? await migrationHandlers.php_runtime?.inspectContainerMigrationOperation(phpContext(operation))
                  : kind === 'static_control'
                    ? await migrationHandlers.static_runtime?.inspectControlMigrationOperation(staticControlContext(operation))
                    : await workspaceManager.inspectWorkspaceOperation(intent, { operationId: operation.id });
          const result = kind === 'identity'
            ? identityInspectionEvidence(inspected)
            : kind === 'sftp'
              ? sftpInspectionEvidence(inspected)
              : kind === 'php'
                ? phpInspectionEvidence(inspected)
                : kind === 'php_container'
                  ? phpContainerInspectionEvidence(inspected)
                  : kind === 'static_control'
                    ? staticControlInspectionEvidence(inspected)
                    : inspectionEvidence(inspected);
          if (result) {
            recovery.push(Object.freeze({ operationId: operation.id, recovered: true }));
            await registry.succeed(operation.id, result);
          } else {
            recovery.push(Object.freeze({ operationId: operation.id, recovered: false, reason: 'apply_incomplete' }));
          }
        } else {
          const result = kind === 'identity'
            ? await workspaceManager.inspectIdentityMigrationCompensation(intent, {
              operationId: operation.id,
              evidence: operation.result,
            })
            : kind === 'sftp'
              ? await migrationHandlers.sftp?.inspectMigrationCompensation(sftpContext(operation))
              : kind === 'php'
                ? await migrationHandlers.php_runtime?.inspectMigrationCompensation(phpContext(operation))
                : kind === 'php_container'
                  ? await migrationHandlers.php_runtime?.inspectContainerMigrationCompensation(phpContext(operation))
                  : kind === 'static_control'
                    ? await migrationHandlers.static_runtime?.inspectControlMigrationCompensation(staticControlContext(operation))
                    : await workspaceManager.inspectWorkspaceCompensation(intent, { operationId: operation.id });
          if (result?.satisfied === true) {
            recovery.push(Object.freeze({ operationId: operation.id, recovered: true }));
            await registry.compensate(
              operation.id,
              kind === 'identity'
                ? identityCompensationEvidence(result)
                : kind === 'sftp'
                  ? sftpCompensationEvidence(result)
                  : kind === 'php'
                    ? phpCompensationEvidence(result)
                    : kind === 'php_container'
                      ? phpContainerCompensationEvidence(result)
                      : kind === 'static_control'
                        ? staticControlCompensationEvidence(result)
                        : compensationEvidence(result),
            );
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
  exactIdentityTarget,
  exactSftpTarget,
  exactPhpTarget,
  exactPhpContainerTarget,
  exactStaticControlTarget,
  migrationKind,
  workspaceIntent,
  sftpContext,
  phpContext,
  staticControlContext,
  applyEvidence,
  inspectionEvidence,
  compensationEvidence,
  identityApplyEvidence,
  identityInspectionEvidence,
  identityCompensationEvidence,
  sftpApplyEvidence,
  sftpInspectionEvidence,
  sftpCompensationEvidence,
  phpApplyEvidence,
  phpInspectionEvidence,
  phpCompensationEvidence,
  phpContainerApplyEvidence,
  phpContainerInspectionEvidence,
  phpContainerCompensationEvidence,
  staticControlApplyEvidence,
  staticControlInspectionEvidence,
  staticControlCompensationEvidence,
});
