import { createDockerVolumeManager, DockerVolumeManagerError } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  DockerVolumeOperationReceiptError,
  dockerVolumeOperationReceiptInternals,
} from './docker-volume-operation-receipt.js';
import {
  assertVolumeOwnedByProject,
  DockerVolumeOperationsError,
  findCrossProjectVolumeReferences,
  resolveProjectVolumeCatalog,
  withRequiredDockerVolumeLocks,
} from './docker-volume-operations.js';
import { SiteMutationLockError } from '../websites/site-mutation-lock.js';

export class LocalDockerVolumeOperationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'LocalDockerVolumeOperationError';
    this.code = code;
    this.status = status;
  }
}

function mapError(error) {
  if (error instanceof LocalDockerVolumeOperationError) return error;
  if (error instanceof DockerVolumeOperationsError
    || error instanceof DockerVolumeManagerError
    || error instanceof DockerVolumeOperationReceiptError
    || error instanceof SiteMutationLockError
    || error?.name === 'SiteMutationLockError') {
    return new LocalDockerVolumeOperationError(error.code, error.message, error.status ?? 409);
  }
  return error;
}

export function createLocalDockerVolumeOperation({
  projectRegistry,
  volumeManager = createDockerVolumeManager(),
  validateDockerCompose = null,
  projectBackupLocked = async () => false,
  siteMutationLock = null,
  receiptStore,
} = {}) {
  if (!projectRegistry || typeof projectRegistry.getProject !== 'function' || typeof projectRegistry.listProjects !== 'function'
    || !volumeManager || typeof volumeManager.deleteVolume !== 'function'
    || typeof projectBackupLocked !== 'function'
    || !receiptStore || typeof receiptStore.read !== 'function'
    || typeof receiptStore.writeIntent !== 'function'
    || typeof receiptStore.writeCompleted !== 'function') {
    throw new LocalDockerVolumeOperationError(
      'docker_volume_local_dependencies_invalid',
      'Local Docker volume operation dependencies are invalid',
      500,
    );
  }

  async function execute(operation, payload = {}, execution = null) {
    if (operation !== OPERATIONS.DOCKER_VOLUME_DELETE) {
      throw new LocalDockerVolumeOperationError('docker_volume_operation_unsupported', 'Unsupported Docker volume operation', 400);
    }
    if (!execution || typeof execution.serverId !== 'string' || typeof execution.jobId !== 'string'
      || typeof execution.authorize !== 'function') {
      throw new LocalDockerVolumeOperationError('docker_volume_execution_context_invalid', 'Docker volume job execution context is invalid', 500);
    }

    try {
      return await withRequiredDockerVolumeLocks(
        siteMutationLock,
        {
          serverId: execution.serverId,
          projectId: payload.projectId,
          volumeName: payload.volumeName,
        },
        async () => {
          // 1. Check durable pre-delete/completed receipt before any mutation to prevent blind replay.
          const expectedIdentity = {
            serverId: execution.serverId,
            jobId: execution.jobId,
            operation,
            projectId: payload.projectId,
            projectName: payload.projectName,
            projectRevision: payload.expectedProjectRevision,
            composeSha256: payload.expectedComposeSha256,
            volumeKey: payload.volumeKey,
            volumeName: payload.volumeName,
            volumeFingerprint: payload.volumeFingerprint,
            previewDigest: payload.previewDigest,
          };
          const existingReceipt = await receiptStore.read(execution.jobId);
          if (existingReceipt) {
            if (!dockerVolumeOperationReceiptInternals.sameIdentity(existingReceipt, expectedIdentity)) {
              throw new LocalDockerVolumeOperationError(
                'docker_volume_receipt_conflict',
                'Docker volume receipt identity is already used for different evidence',
                409,
              );
            }
            if (existingReceipt.phase === 'completed') {
              return Object.freeze({
                version: 1,
                projectId: existingReceipt.projectId,
                projectName: existingReceipt.projectName,
                projectRevision: existingReceipt.projectRevision,
                composeSha256: existingReceipt.composeSha256,
                volumeKey: existingReceipt.volumeKey,
                volumeName: existingReceipt.volumeName,
                volumeFingerprint: existingReceipt.volumeFingerprint,
                previewDigest: existingReceipt.previewDigest,
                deleted: true,
                sideEffects: true,
              });
            }
            throw new LocalDockerVolumeOperationError(
              'docker_volume_delete_recovery_required',
              'A prior Docker volume deletion intent was interrupted before absence verification; inspect before retrying',
              409,
            );
          }

          // 2. Re-verify live Owner authorization under lock.
          await execution.authorize();

          // 3. Re-verify backup lock state.
          let backupLocked;
          try {
            backupLocked = await projectBackupLocked(payload.projectId);
          } catch {
            throw new LocalDockerVolumeOperationError('docker_compose_backup_state_unavailable', 'Docker backup lock state could not be inspected', 503);
          }
          if (backupLocked !== true && backupLocked !== false) {
            throw new LocalDockerVolumeOperationError('docker_compose_backup_state_unavailable', 'Docker backup lock state is invalid', 503);
          }
          if (backupLocked) {
            throw new LocalDockerVolumeOperationError('docker_compose_backup_conflict', 'Docker Compose project is locked by an active backup', 409);
          }

          // 4. Re-verify immutable project identity, revision, and Compose SHA-256.
          const project = await projectRegistry.getProject(payload.projectId);
          if (!project || project.serverId !== execution.serverId) {
            throw new LocalDockerVolumeOperationError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
          }
          if (project.projectName !== payload.projectName
            || project.revision !== payload.expectedProjectRevision
            || project.composeSha256 !== payload.expectedComposeSha256) {
            throw new LocalDockerVolumeOperationError(
              'docker_volume_preview_stale',
              'Docker Compose project changed before volume deletion executed',
              409,
            );
          }

          // 5. Re-verify ownership and zero cross-project references under shared inventory lock.
          const catalog = await resolveProjectVolumeCatalog(project, { projectRegistry, validateDockerCompose });
          const owned = assertVolumeOwnedByProject(project, catalog, payload.volumeKey);
          if (owned.volumeName !== payload.volumeName) {
            throw new LocalDockerVolumeOperationError('docker_volume_identity_mismatch', 'Docker volume identity mismatch', 409);
          }
          const crossRefs = await findCrossProjectVolumeReferences({
            targetProject: project,
            volumeName: owned.volumeName,
            projectRegistry,
            validateDockerCompose,
          });
          if (crossRefs.length > 0) {
            throw new LocalDockerVolumeOperationError(
              'docker_volume_cross_project_referenced',
              'Docker volume name is referenced by another managed Compose project on this server',
              409,
            );
          }

          // 6. Execute verified single-volume deletion on local Docker Unix socket.
          // Immediately before physical `docker volume rm` (after final inspect + usage check),
          // re-verify live Owner authorization and persist durable exact pre-delete intent.
          const outcome = await volumeManager.deleteVolume({
            projectName: project.projectName,
            volumeKey: owned.volumeKey,
            volumeName: owned.volumeName,
            expectedFingerprint: payload.volumeFingerprint,
            beforeRemove: async () => {
              await execution.authorize();
              await receiptStore.writeIntent({
                serverId: execution.serverId,
                jobId: execution.jobId,
                operation,
                intent: {
                  projectId: project.id,
                  projectName: project.projectName,
                  projectRevision: project.revision,
                  composeSha256: project.composeSha256,
                  volumeKey: owned.volumeKey,
                  volumeName: owned.volumeName,
                  volumeFingerprint: payload.volumeFingerprint,
                  previewDigest: payload.previewDigest,
                },
              });
            },
          });

          const result = Object.freeze({
            version: 1,
            projectId: project.id,
            projectName: project.projectName,
            projectRevision: project.revision,
            composeSha256: project.composeSha256,
            volumeKey: outcome.volumeKey,
            volumeName: outcome.volumeName,
            volumeFingerprint: outcome.volumeFingerprint,
            previewDigest: payload.previewDigest,
            deleted: true,
            sideEffects: true,
          });

          // 7. Promote durable 0600 receipt from intent -> completed after verified absence.
          // Physical deletion and absence verification have already succeeded; a transient
          // receipt write failure must not misclassify confirmed deletion as failed.
          try {
            await receiptStore.writeCompleted({
              serverId: execution.serverId,
              jobId: execution.jobId,
              operation,
              result,
            });
          } catch {}

          return result;
        },
        LocalDockerVolumeOperationError,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  return Object.freeze({ execute });
}
