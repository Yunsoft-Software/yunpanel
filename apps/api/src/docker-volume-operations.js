import { createHash } from 'node:crypto';
import {
  DockerVolumeManagerError,
  dockerVolumeManagerInternals,
} from '@yunpanel/host-runtime';
import { DOCKER_COMPOSE_OPERATIONS, DOCKER_VOLUME_OPERATIONS, OPERATIONS } from '@yunpanel/protocol';
import { SiteMutationLockError } from './site-mutation-lock.js';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const ALL_DOCKER_PROJECT_OPS = new Set([...DOCKER_COMPOSE_OPERATIONS, ...DOCKER_VOLUME_OPERATIONS]);
const VOLUME_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DockerVolumeOperationsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerVolumeOperationsError';
    this.code = code;
    this.status = status;
  }
}

const BLOCK_REASONS = Object.freeze({
  docker_volume_not_found: 'Host üzerinde oluşturulmuş volume yok.',
  docker_volume_in_use: 'Konteyner bağlantısı sürüyor.',
  docker_volume_external_forbidden: 'Harici veya özel adlı volume silinemez.',
  docker_volume_cross_project_referenced: 'Başka bir Docker projesi bu volume adına referans veriyor.',
  docker_volume_driver_unsupported: 'Yalnız yerel Docker volume sürücüsü silinebilir.',
  docker_volume_options_unsupported: 'Özel sürücü seçenekli volume silinemez.',
  docker_volume_ownership_unverified: 'Compose proje/volume etiket sahipliği doğrulanamadı.',
  docker_volume_identity_incomplete: 'Volume kapsam veya oluşturulma zamanı kimliği eksik.',
  docker_compose_job_conflict: 'Proje için çalışan başka bir işlem var.',
  docker_compose_backup_conflict: 'Proje aktif bir yedekleme kilidinde.',
});

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function classifyVolumeKeySyntax(project, rawVolumeKey) {
  if (typeof rawVolumeKey !== 'string' || rawVolumeKey.length === 0 || rawVolumeKey.length > 256
    || /[\u0000-\u001f\u007f]/.test(rawVolumeKey)) {
    throw new DockerVolumeOperationsError('docker_volume_key_invalid', 'Docker volume key is invalid', 400);
  }
  const mounts = (project?.services ?? []).flatMap((service) => service?.storageMounts ?? []);
  if (rawVolumeKey.startsWith('/') || rawVolumeKey.startsWith('./') || rawVolumeKey.startsWith('../')
    || mounts.some((mount) => mount?.kind === 'bind' && (mount.source === rawVolumeKey || mount.target === rawVolumeKey))) {
    throw new DockerVolumeOperationsError(
      'docker_volume_bind_mount_forbidden',
      'Bind mounts cannot be deleted through Docker volume removal',
      409,
    );
  }
  if (rawVolumeKey === 'ephemeral' || rawVolumeKey === 'tmpfs'
    || mounts.some((mount) => mount?.kind === 'ephemeral' && mount.target === rawVolumeKey)) {
    throw new DockerVolumeOperationsError(
      'docker_volume_ephemeral_unsupported',
      'Ephemeral mounts are not named Docker volumes',
      409,
    );
  }
  if (!VOLUME_KEY_PATTERN.test(rawVolumeKey) || rawVolumeKey.includes('..')) {
    throw new DockerVolumeOperationsError('docker_volume_key_invalid', 'Docker volume key is invalid', 400);
  }
  return rawVolumeKey;
}

export async function resolveProjectVolumeCatalog(project, {
  projectRegistry,
  validateDockerCompose = null,
} = {}) {
  const detailsByKey = new Map();
  let hasAuthoritativeDetails = false;

  if (Array.isArray(project?.volumeDetails)) {
    hasAuthoritativeDetails = true;
    for (const entry of project.volumeDetails) {
      if (!entry || typeof entry.name !== 'string') continue;
      detailsByKey.set(entry.name, {
        volumeKey: entry.name,
        scope: entry.scope,
        external: entry.external === true,
        runtimeName: entry.runtimeName,
        declaredActive: true,
        ownedHistorical: entry.scope === 'project' && entry.external !== true && entry.runtimeName === `${project.projectName}_${entry.name}`,
      });
    }
  } else if (Array.isArray(project?.volumes) && project.volumes.length > 0) {
    // Legacy persisted record without volumeDetails: materialize and re-validate encrypted Compose YAML.
    if (!projectRegistry || typeof projectRegistry.materializeProject !== 'function'
      || typeof validateDockerCompose !== 'function') {
      throw new DockerVolumeOperationsError(
        'docker_volume_catalog_unavailable',
        'Docker Compose project volume metadata could not be verified',
        503,
      );
    }
    try {
      const materialized = await projectRegistry.materializeProject(project.id, { expectedRevision: project.revision });
      const validation = await validateDockerCompose({
        projectName: project.projectName,
        document: materialized.document,
        environment: {},
        interpolate: false,
      });
      hasAuthoritativeDetails = true;
      for (const entry of validation.volumeDetails ?? []) {
        detailsByKey.set(entry.name, {
          volumeKey: entry.name,
          scope: entry.scope,
          external: entry.external === true,
          runtimeName: entry.runtimeName,
          declaredActive: true,
          ownedHistorical: entry.scope === 'project' && entry.external !== true && entry.runtimeName === `${project.projectName}_${entry.name}`,
        });
      }
    } catch (error) {
      if (error instanceof DockerVolumeOperationsError) throw error;
      throw new DockerVolumeOperationsError(
        'docker_volume_catalog_unavailable',
        'Docker Compose project volume metadata could not be verified',
        503,
      );
    }
  } else {
    hasAuthoritativeDetails = true;
  }

  if (Array.isArray(project?.ownedVolumes)) {
    for (const key of project.ownedVolumes) {
      if (typeof key !== 'string' || !VOLUME_KEY_PATTERN.test(key)) continue;
      const existing = detailsByKey.get(key);
      if (existing) {
        existing.ownedHistorical = true;
      } else {
        detailsByKey.set(key, {
          volumeKey: key,
          scope: 'project',
          external: false,
          runtimeName: `${project.projectName}_${key}`,
          declaredActive: false,
          ownedHistorical: true,
        });
      }
    }
  }

  if (!hasAuthoritativeDetails) {
    throw new DockerVolumeOperationsError(
      'docker_volume_catalog_unavailable',
      'Docker Compose project volume metadata could not be verified',
      503,
    );
  }

  return [...detailsByKey.values()].sort((left, right) => left.volumeKey.localeCompare(right.volumeKey));
}

export async function findCrossProjectVolumeReferences({
  targetProject,
  volumeName,
  projectRegistry,
  validateDockerCompose = null,
} = {}) {
  if (!projectRegistry || typeof projectRegistry.listProjects !== 'function') {
    throw new DockerVolumeOperationsError('docker_volume_inventory_unavailable', 'Docker project inventory is unavailable', 503);
  }
  let projects;
  try {
    projects = await projectRegistry.listProjects({ serverId: targetProject.serverId });
  } catch {
    throw new DockerVolumeOperationsError('docker_volume_inventory_unavailable', 'Docker project inventory could not be read', 503);
  }
  if (!Array.isArray(projects)) {
    throw new DockerVolumeOperationsError('docker_volume_inventory_unavailable', 'Docker project inventory is invalid', 503);
  }

  const conflicts = [];
  for (const other of projects) {
    if (!other || other.id === targetProject.id || other.serverId !== targetProject.serverId) continue;
    const catalog = await resolveProjectVolumeCatalog(other, { projectRegistry, validateDockerCompose });
    for (const entry of catalog) {
      const derivedName = `${other.projectName}_${entry.volumeKey}`;
      if (entry.runtimeName === volumeName || derivedName === volumeName) {
        conflicts.push(Object.freeze({
          projectId: other.id,
          projectName: other.projectName,
          volumeKey: entry.volumeKey,
        }));
      }
    }
  }
  return Object.freeze(conflicts);
}

export function assertVolumeOwnedByProject(project, catalog, rawVolumeKey) {
  const volumeKey = classifyVolumeKeySyntax(project, rawVolumeKey);
  const entry = catalog.find((item) => item.volumeKey === volumeKey) ?? null;
  if (!entry) {
    throw new DockerVolumeOperationsError(
      'docker_volume_not_owned',
      'Selected volume is not owned by this Docker Compose project',
      409,
    );
  }
  const expectedRuntimeName = `${project.projectName}_${volumeKey}`;
  if (entry.external === true || entry.scope !== 'project' || entry.runtimeName !== expectedRuntimeName) {
    throw new DockerVolumeOperationsError(
      'docker_volume_external_forbidden',
      'External or custom-named Docker volumes cannot be deleted through project volume removal',
      409,
    );
  }
  return Object.freeze({
    volumeKey,
    volumeName: expectedRuntimeName,
    declaredActive: entry.declaredActive,
  });
}

function mapManagerError(error) {
  if (error instanceof DockerVolumeOperationsError) return error;
  if (error instanceof DockerVolumeManagerError) {
    return new DockerVolumeOperationsError(error.code, error.message, error.status ?? 409);
  }
  if (error instanceof SiteMutationLockError || error?.name === 'SiteMutationLockError') {
    return new DockerVolumeOperationsError(error.code, error.message, error.status ?? 409);
  }
  return error;
}

export function withRequiredDockerVolumeLocks(
  siteMutationLock,
  { serverId, projectId, volumeName },
  action,
  ErrorClass = DockerVolumeOperationsError,
) {
  if (!siteMutationLock || typeof siteMutationLock.withDockerVolumeOperationLocks !== 'function') {
    throw new ErrorClass(
      'docker_volume_lock_unavailable',
      'Shared Docker inventory, project, and volume lock is unavailable',
      503,
    );
  }
  return siteMutationLock.withDockerVolumeOperationLocks({ serverId, projectId, volumeName }, action);
}

export function createDockerVolumeOperationsService({
  projectRegistry,
  jobRegistry,
  volumeManager,
  validateDockerCompose = null,
  projectBackupLocked = async () => false,
  siteMutationLock = null,
} = {}) {
  if (!projectRegistry || typeof projectRegistry.getProject !== 'function' || typeof projectRegistry.listProjects !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function'
    || !volumeManager || typeof volumeManager.inspectVolumeDetail !== 'function' || typeof volumeManager.listVolumeContainers !== 'function'
    || typeof projectBackupLocked !== 'function') {
    throw new DockerVolumeOperationsError(
      'docker_volume_operations_dependencies_invalid',
      'Docker volume operation dependencies are unavailable',
      503,
    );
  }

  async function listProjectJobs(projectId) {
    let jobs;
    try {
      jobs = await jobRegistry.listJobs({ resourceType: 'docker_project', resourceId: projectId });
    } catch {
      throw new DockerVolumeOperationsError('docker_compose_job_state_unavailable', 'Docker project job state could not be inspected', 503);
    }
    if (!Array.isArray(jobs)) {
      throw new DockerVolumeOperationsError('docker_compose_job_state_unavailable', 'Docker project job state is invalid', 503);
    }
    return jobs.filter((job) => ALL_DOCKER_PROJECT_OPS.has(job?.operation));
  }

  async function assertBackupUnlocked(projectId) {
    let locked;
    try { locked = await projectBackupLocked(projectId); }
    catch {
      throw new DockerVolumeOperationsError('docker_compose_backup_state_unavailable', 'Docker backup lock state could not be inspected', 503);
    }
    if (locked !== true && locked !== false) {
      throw new DockerVolumeOperationsError('docker_compose_backup_state_unavailable', 'Docker backup lock state is invalid', 503);
    }
    if (locked) {
      throw new DockerVolumeOperationsError('docker_compose_backup_conflict', 'Docker Compose project is locked by an active backup', 409);
    }
  }

  async function assertProjectIdle(projectId) {
    const jobs = await listProjectJobs(projectId);
    if (jobs.some((job) => ACTIVE_STATUSES.has(job.status))) {
      throw new DockerVolumeOperationsError('docker_compose_job_conflict', 'Another Docker Compose operation is already queued or running', 409);
    }
    await assertBackupUnlocked(projectId);
    return jobs;
  }

  async function requireProject(projectId) {
    let project;
    try {
      project = await projectRegistry.getProject(projectId);
    } catch {
      throw new DockerVolumeOperationsError('docker_compose_desired_state_unavailable', 'Docker Compose project could not be read', 503);
    }
    if (!project) {
      throw new DockerVolumeOperationsError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
    }
    return project;
  }

  async function listProjectVolumes({ projectId } = {}) {
    const project = await requireProject(projectId);
    const catalog = await resolveProjectVolumeCatalog(project, { projectRegistry, validateDockerCompose });
    const jobs = await listProjectJobs(project.id);
    const activeJob = jobs.some((job) => ACTIVE_STATUSES.has(job.status));
    let backupLocked = false;
    try {
      const state = await projectBackupLocked(project.id);
      if (state !== true && state !== false) {
        throw new DockerVolumeOperationsError('docker_compose_backup_state_unavailable', 'Docker backup lock state is invalid', 503);
      }
      backupLocked = state;
    } catch (error) {
      if (error instanceof DockerVolumeOperationsError) throw error;
      throw new DockerVolumeOperationsError('docker_compose_backup_state_unavailable', 'Docker backup lock state could not be inspected', 503);
    }

    const items = [];
    for (const entry of catalog) {
      const runtimeName = entry.runtimeName;
      let detail;
      try {
        detail = await volumeManager.inspectVolumeDetail(runtimeName);
      } catch (error) {
        throw mapManagerError(error);
      }
      // Hide detached historical volumes once physically removed from the host.
      if (!entry.declaredActive && !detail.present) continue;

      let containers = [];
      let containerCount = 0;
      if (detail.present) {
        try {
          const usage = await volumeManager.listVolumeContainers(runtimeName);
          containers = usage.containers;
          containerCount = usage.containerCount;
        } catch (error) {
          throw mapManagerError(error);
        }
      }

      const crossProjectRefs = await findCrossProjectVolumeReferences({
        targetProject: project,
        volumeName: runtimeName,
        projectRegistry,
        validateDockerCompose,
      });

      const isProjectScoped = entry.external !== true && entry.scope === 'project' && runtimeName === `${project.projectName}_${entry.volumeKey}`;
      let blockCode = null;
      let blockReason = null;

      if (!isProjectScoped) {
        blockCode = 'docker_volume_external_forbidden';
      } else if (activeJob) {
        blockCode = 'docker_compose_job_conflict';
      } else if (backupLocked) {
        blockCode = 'docker_compose_backup_conflict';
      } else if (crossProjectRefs.length > 0) {
        blockCode = 'docker_volume_cross_project_referenced';
      } else if (!detail.present) {
        blockCode = 'docker_volume_not_found';
      } else {
        try {
          dockerVolumeManagerInternals.assertVolumeDeletableMetadata(detail, {
            projectName: project.projectName,
            volumeKey: entry.volumeKey,
          });
        } catch (error) {
          blockCode = error?.code ?? 'docker_volume_ownership_unverified';
        }
      }
      if (!blockCode && containerCount > 0) {
        blockCode = 'docker_volume_in_use';
      }
      if (blockCode) {
        blockReason = blockCode === 'docker_volume_in_use'
          ? `Kullanımda: ${containerCount} konteyner bağlı.`
          : (BLOCK_REASONS[blockCode] ?? 'Bu volume silinemez.');
      }

      items.push(Object.freeze({
        volumeKey: entry.volumeKey,
        volumeName: runtimeName,
        scope: isProjectScoped ? 'project' : 'external',
        declaredActive: entry.declaredActive,
        present: detail.present === true,
        driver: detail.present ? detail.driver : null,
        volumeScope: detail.present ? detail.scope : null,
        createdAt: detail.present ? detail.createdAt : null,
        composeLabelsVerified: detail.present === true
          && detail.composeProject === project.projectName
          && detail.composeVolume === entry.volumeKey,
        containerCount,
        containers,
        crossProjectRefCount: crossProjectRefs.length,
        deletable: blockCode === null,
        blockCode,
        blockReason,
      }));
    }

    return Object.freeze({
      version: 1,
      projectId: project.id,
      projectName: project.projectName,
      projectRevision: project.revision,
      volumes: Object.freeze(items),
      sideEffects: false,
    });
  }

  async function previewDelete({ projectId, volumeKey: rawVolumeKey } = {}) {
    const project = await requireProject(projectId);
    const previousJobs = await assertProjectIdle(project.id);
    const catalog = await resolveProjectVolumeCatalog(project, { projectRegistry, validateDockerCompose });
    const owned = assertVolumeOwnedByProject(project, catalog, rawVolumeKey);
    const crossRefs = await findCrossProjectVolumeReferences({
      targetProject: project,
      volumeName: owned.volumeName,
      projectRegistry,
      validateDockerCompose,
    });
    if (crossRefs.length > 0) {
      throw new DockerVolumeOperationsError(
        'docker_volume_cross_project_referenced',
        'Docker volume name is referenced by another managed Compose project on this server',
        409,
      );
    }

    let detail;
    let usage;
    try {
      detail = await volumeManager.inspectVolumeDetail(owned.volumeName);
      dockerVolumeManagerInternals.assertVolumeDeletableMetadata(detail, {
        projectName: project.projectName,
        volumeKey: owned.volumeKey,
      });
      usage = await volumeManager.listVolumeContainers(owned.volumeName);
    } catch (error) {
      throw mapManagerError(error);
    }
    if (usage.containerCount > 0) {
      throw new DockerVolumeOperationsError(
        'docker_volume_in_use',
        `Docker volume is still attached to ${usage.containerCount} container(s), including stopped containers`,
        409,
      );
    }

    const executionRevision = sha256Json(
      previousJobs
        .map((job) => [job.id, job.operation, job.status])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );
    const digest = sha256Json({
      version: 1,
      action: 'delete',
      operation: OPERATIONS.DOCKER_VOLUME_DELETE,
      serverId: project.serverId,
      projectId: project.id,
      projectName: project.projectName,
      projectRevision: project.revision,
      composeSha256: project.composeSha256,
      executionRevision,
      volumeKey: owned.volumeKey,
      volumeName: owned.volumeName,
      volumeFingerprint: detail.fingerprint,
    });

    return Object.freeze({
      version: 1,
      action: 'delete',
      operation: OPERATIONS.DOCKER_VOLUME_DELETE,
      serverId: project.serverId,
      projectId: project.id,
      projectName: project.projectName,
      projectRevision: project.revision,
      composeSha256: project.composeSha256,
      executionRevision,
      volumeKey: owned.volumeKey,
      volumeName: owned.volumeName,
      volumeFingerprint: detail.fingerprint,
      createdAt: detail.createdAt,
      containerCount: 0,
      previewDigest: digest,
      confirmation: `docker-volume:delete:${project.projectName}:${owned.volumeKey}:${digest}`,
      sideEffects: false,
    });
  }

  async function queueDelete({
    projectId,
    volumeKey: rawVolumeKey,
    expectedPreviewDigest,
    confirmation,
  } = {}) {
    if (typeof expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(expectedPreviewDigest)) {
      throw new DockerVolumeOperationsError('docker_volume_preview_digest_invalid', 'A current Docker volume delete preview digest is required', 400);
    }
    if (typeof confirmation !== 'string' || confirmation.length < 1 || confirmation.length > 512) {
      throw new DockerVolumeOperationsError('docker_volume_confirmation_invalid', 'Explicit typed confirmation is required to delete a Docker volume', 400);
    }

    const preProject = await requireProject(projectId);
    const preCatalog = await resolveProjectVolumeCatalog(preProject, { projectRegistry, validateDockerCompose });
    const preOwned = assertVolumeOwnedByProject(preProject, preCatalog, rawVolumeKey);

    try {
      return await withRequiredDockerVolumeLocks(
        siteMutationLock,
        { serverId: preProject.serverId, projectId: preProject.id, volumeName: preOwned.volumeName },
        async () => {
          const preview = await previewDelete({ projectId: preProject.id, volumeKey: preOwned.volumeKey });
          if (expectedPreviewDigest !== preview.previewDigest) {
            throw new DockerVolumeOperationsError(
              'docker_volume_preview_stale',
              'Docker volume or project state changed after preview; request a new preview',
              409,
            );
          }
          if (confirmation !== preview.confirmation) {
            throw new DockerVolumeOperationsError(
              'docker_volume_confirmation_invalid',
              `Confirm Docker volume deletion with ${preview.confirmation}`,
              409,
            );
          }
          const job = await jobRegistry.enqueue({
            serverId: preview.serverId,
            type: OPERATIONS.DOCKER_VOLUME_DELETE,
            operation: OPERATIONS.DOCKER_VOLUME_DELETE,
            resourceType: 'docker_project',
            resourceId: preview.projectId,
            idempotencyKey: `docker-volume:delete:${preview.projectId}:${preview.volumeKey}:${preview.previewDigest}`,
            payload: {
              projectId: preview.projectId,
              projectName: preview.projectName,
              expectedProjectRevision: preview.projectRevision,
              expectedComposeSha256: preview.composeSha256,
              volumeKey: preview.volumeKey,
              volumeName: preview.volumeName,
              volumeFingerprint: preview.volumeFingerprint,
              previewDigest: preview.previewDigest,
            },
          });
          return Object.freeze({
            previewDigest: preview.previewDigest,
            job,
            sideEffects: false,
          });
        },
        DockerVolumeOperationsError,
      );
    } catch (error) {
      throw mapManagerError(error);
    }
  }

  return Object.freeze({
    listProjectVolumes,
    previewDelete,
    queueDelete,
  });
}

export const dockerVolumeOperationsInternals = Object.freeze({
  classifyVolumeKeySyntax,
  resolveProjectVolumeCatalog,
  findCrossProjectVolumeReferences,
  assertVolumeOwnedByProject,
  blockReasons: BLOCK_REASONS,
});
