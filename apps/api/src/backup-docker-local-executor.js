import path from 'node:path';
import { dockerComposeManagerInternals } from '@yunpanel/host-runtime';
import { DOCKER_COMPOSE_OPERATIONS } from '@yunpanel/protocol';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const DOCKER_OPERATIONS = new Set(DOCKER_COMPOSE_OPERATIONS);
const SAFE_PROJECT_STATUSES = new Set(['absent', 'stopped']);

export class BackupDockerLocalExecutorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupDockerLocalExecutorError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new BackupDockerLocalExecutorError(code, message, status);
}

function normalizeStorage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 5
    || Object.keys(value).some((key) => !['kind', 'source', 'sourceScope', 'target', 'readOnly'].includes(key))
    || !['named_volume', 'bind'].includes(value.kind)
    || value.sourceScope !== 'project'
    || typeof value.source !== 'string' || value.source.length < 1 || value.source.length > 4096
    || typeof value.target !== 'string' || !value.target.startsWith('/') || value.target.length > 4096
    || typeof value.readOnly !== 'boolean') {
    fail('backup_docker_step_invalid', 'Docker storage backup step is invalid');
  }
  if (value.kind === 'bind' && value.source !== './') {
    if (!value.source.startsWith('./')
      || value.source.slice(2).split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      fail('backup_docker_step_invalid', 'Docker project bind source is invalid');
    }
  }
  return Object.freeze({ ...value });
}

function normalizeStep(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.executorKind !== 'docker_storage_backup'
    || value.resourceType !== 'docker_storage'
    || typeof value.stepDigest !== 'string' || !SHA256_PATTERN.test(value.stepDigest)
    || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)
    || typeof value.input.projectId !== 'string' || !UUID_PATTERN.test(value.input.projectId)
    || !Number.isSafeInteger(value.input.projectRevision) || value.input.projectRevision < 1
    || typeof value.input.serviceName !== 'string' || !SERVICE_NAME_PATTERN.test(value.input.serviceName)) {
    fail('backup_docker_step_invalid', 'Docker storage backup step is invalid');
  }
  return Object.freeze({ ...value, input: Object.freeze({ ...value.input, storage: normalizeStorage(value.input.storage) }) });
}

function sameStorage(left, right) {
  return Boolean(left && right
    && left.kind === right.kind
    && left.source === right.source
    && left.sourceScope === right.sourceScope
    && left.target === right.target
    && left.readOnly === right.readOnly);
}

function workRef(step) {
  return Object.freeze({ kind: 'local', id: `docker-storage-backup:${step.stepDigest}` });
}

function projectBindPath(projectWorkspace, source) {
  const root = path.resolve(projectWorkspace);
  const resolved = source === './' ? root : path.resolve(root, source.slice(2));
  const relative = path.relative(root, resolved);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    fail('backup_docker_source_invalid', 'Docker project bind resolves outside the managed project workspace');
  }
  return resolved;
}

function archiveEntry(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (resolved === path.parse(resolved).root) {
    fail('backup_docker_source_invalid', 'Docker storage backup source cannot be a filesystem root');
  }
  return Object.freeze({ directory: path.dirname(resolved), name: path.basename(resolved) });
}

function controlDocument(serverId, project, step, runtimeSource) {
  return `${JSON.stringify({
    version: 1,
    serverId,
    projectId: project.id,
    projectName: project.projectName,
    projectRevision: project.revision,
    serviceName: step.input.serviceName,
    storage: step.input.storage,
    runtimeSource,
  }, null, 2)}\n`;
}

export function createBackupDockerLocalExecutor({
  dockerComposeProjectRegistry,
  dockerComposeObserver,
  jobRegistry,
  projectBackupLocked,
  inspectDockerVolume,
  localBackupArtifactManager,
  composeRuntimeRoot = dockerComposeManagerInternals.defaultRoot,
  projectWorkspacePath = dockerComposeManagerInternals.projectWorkspacePath,
} = {}) {
  if (!dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function'
    || !dockerComposeObserver || typeof dockerComposeObserver.inspect !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function'
    || typeof projectBackupLocked !== 'function'
    || typeof inspectDockerVolume !== 'function'
    || !localBackupArtifactManager || typeof localBackupArtifactManager.archive !== 'function'
    || typeof composeRuntimeRoot !== 'string' || !path.isAbsolute(composeRuntimeRoot)
    || typeof projectWorkspacePath !== 'function') {
    throw new BackupDockerLocalExecutorError(
      'backup_docker_dependencies_invalid',
      'Docker storage backup executor dependencies are unavailable',
      503,
    );
  }

  async function sourceState(serverId, stepValue) {
    const step = normalizeStep(stepValue);
    let locked;
    let project;
    let jobs;
    try {
      [locked, project, jobs] = await Promise.all([
        projectBackupLocked(step.input.projectId),
        dockerComposeProjectRegistry.getProject(step.input.projectId),
        jobRegistry.listJobs({ resourceType: 'docker_project', resourceId: step.input.projectId }),
      ]);
    } catch (error) {
      if (error instanceof BackupDockerLocalExecutorError) throw error;
      fail('backup_docker_state_unavailable', 'Docker storage backup state could not be verified', 503);
    }
    if (locked !== true) {
      fail('backup_docker_lock_required', 'Docker storage backup requires an active durable backup lock', 409);
    }
    if (!project || project.id !== step.input.projectId || project.serverId !== serverId
      || project.revision !== step.input.projectRevision
      || typeof project.projectName !== 'string' || !PROJECT_NAME_PATTERN.test(project.projectName)
      || !Array.isArray(project.services)) {
      fail('backup_docker_preview_stale', 'Docker storage backup source changed after preview', 409);
    }
    if (!Array.isArray(jobs)) fail('backup_docker_job_state_unavailable', 'Docker project job state is invalid', 503);
    if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job?.status) && DOCKER_OPERATIONS.has(job?.operation))) {
      fail('backup_docker_job_conflict', 'A Docker Compose lifecycle operation is already active', 409);
    }
    const service = project.services.find((candidate) => candidate?.name === step.input.serviceName) ?? null;
    if (!service || !Array.isArray(service.storageMounts)
      || !service.storageMounts.some((mount) => sameStorage(mount, step.input.storage))) {
      fail('backup_docker_preview_stale', 'Docker storage mount changed after preview', 409);
    }
    let runtime;
    try { runtime = await dockerComposeObserver.inspect({ projectName: project.projectName }); }
    catch {
      fail('backup_docker_runtime_unavailable', 'Docker Compose runtime state could not be inspected', 503);
    }
    if (!runtime || !SAFE_PROJECT_STATUSES.has(runtime.status)) {
      fail(
        'backup_docker_consistency_blocked',
        'Docker storage backup requires the managed Compose project to be stopped',
        409,
      );
    }
    return Object.freeze({ step, project, runtime });
  }

  async function prepare(serverId, stepValue) {
    const { step } = await sourceState(serverId, stepValue);
    return Object.freeze({ workRef: workRef(step) });
  }

  async function resolveSource(project, step) {
    if (step.input.storage.kind === 'bind') {
      const workspace = projectWorkspacePath(composeRuntimeRoot, project.id);
      const sourcePath = projectBindPath(workspace, step.input.storage.source);
      return Object.freeze({
        sourcePath,
        runtimeSource: Object.freeze({ kind: 'project_bind', source: step.input.storage.source }),
      });
    }
    const volumeName = `${project.projectName}_${step.input.storage.source}`;
    let volume;
    try { volume = await inspectDockerVolume(volumeName); }
    catch (error) {
      if (error?.code && String(error.code).startsWith('docker_volume_')) throw error;
      fail('backup_docker_volume_unavailable', 'Docker managed volume could not be inspected', 503);
    }
    if (!volume || volume.name !== volumeName || volume.driver !== 'local'
      || typeof volume.mountpoint !== 'string' || !path.isAbsolute(volume.mountpoint)) {
      fail('backup_docker_volume_invalid', 'Docker managed volume state is invalid', 409);
    }
    return Object.freeze({
      sourcePath: volume.mountpoint,
      runtimeSource: Object.freeze({ kind: 'named_volume', name: volumeName }),
    });
  }

  async function executePrepared(serverId, stepValue, requestedWorkRef) {
    const { step, project } = await sourceState(serverId, stepValue);
    const expectedWorkRef = workRef(step);
    if (!requestedWorkRef || requestedWorkRef.kind !== expectedWorkRef.kind || requestedWorkRef.id !== expectedWorkRef.id) {
      fail('backup_docker_dispatch_intent_invalid', 'Docker backup dispatch intent does not match the execution step', 409);
    }
    const source = await resolveSource(project, step);
    let evidence;
    try {
      evidence = await localBackupArtifactManager.archive({
        artifactId: step.stepDigest,
        sourceDigest: step.stepDigest,
        entries: [archiveEntry(source.sourcePath)],
        inlineFiles: [{
          name: 'control.json',
          content: controlDocument(serverId, project, step, source.runtimeSource),
        }],
      });
    } catch (error) {
      if (error?.code && (String(error.code).startsWith('backup_artifact_')
        || String(error.code).startsWith('docker_volume_'))) throw error;
      fail('backup_docker_archive_failed', 'Docker storage backup artifact could not be created', 503);
    }
    return Object.freeze({ evidence });
  }

  return Object.freeze({ prepare, executePrepared });
}

export const backupDockerLocalExecutorInternals = Object.freeze({
  normalizeStorage,
  normalizeStep,
  sameStorage,
  workRef,
  projectBindPath,
  archiveEntry,
  controlDocument,
});
