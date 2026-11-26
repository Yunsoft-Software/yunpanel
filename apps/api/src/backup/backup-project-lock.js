const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIVE_STATUSES = new Set(['queued', 'running']);

export class BackupProjectLockError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'BackupProjectLockError';
    this.code = code;
    this.status = status;
  }
}

export function createBackupProjectLockProvider({ backupOperationRegistry } = {}) {
  if (!backupOperationRegistry || typeof backupOperationRegistry.listOperations !== 'function') {
    throw new BackupProjectLockError('backup_project_lock_dependencies_invalid', 'Backup operation registry is required');
  }

  return async function projectBackupLocked(projectId) {
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      throw new BackupProjectLockError('backup_project_lock_identity_invalid', 'Docker project backup lock identity is invalid', 400);
    }
    let operations;
    try { operations = await backupOperationRegistry.listOperations(); }
    catch {
      throw new BackupProjectLockError('backup_project_lock_state_unavailable', 'Backup operation lock state could not be read');
    }
    if (!Array.isArray(operations)) {
      throw new BackupProjectLockError('backup_project_lock_state_unavailable', 'Backup operation lock state is invalid');
    }
    return operations.some((operation) => ACTIVE_STATUSES.has(operation?.status)
      && Array.isArray(operation?.plan?.steps)
      && operation.plan.steps.some((step) => step?.resourceType === 'docker_storage'
        && step?.input?.projectId === projectId));
  };
}

export const backupProjectLockInternals = Object.freeze({
  activeStatuses: Object.freeze([...ACTIVE_STATUSES]),
});
