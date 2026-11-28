import { DockerVolumeManagerError, dockerVolumeManagerInternals } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { DockerComposeOperationsError } from './docker-compose-operations.js';
import {
  assertVolumeOwnedByProject,
  DockerVolumeOperationsError,
  dockerVolumeOperationsInternals,
  findCrossProjectVolumeReferences,
  resolveProjectVolumeCatalog,
} from './docker-volume-operations.js';
import { assertProjectNotReferencedByProxyRoutes } from '../domains/domain-proxy-routes.js';
import { SiteMutationLockError } from '../websites/site-mutation-lock.js';

const fail = (code, message) => new DockerComposeOperationsError(code, message, 409);
const MAX_REMOVAL_VOLUMES = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function mapVolumeError(error) {
  if (error instanceof DockerVolumeOperationsError || error instanceof DockerVolumeManagerError
    || error instanceof SiteMutationLockError || error?.name === 'SiteMutationLockError') {
    return new DockerComposeOperationsError(error.code, error.message, error.status ?? 409);
  }
  return error;
}

// Opted-in volume pins come from a confirmed preview; anything else fails closed.
function removalVolumePins(payload) {
  if (payload?.deleteVolumes === undefined && payload?.volumes === undefined) return null;
  const pins = payload.volumes;
  if (payload.deleteVolumes !== true || !Array.isArray(pins) || pins.length < 1 || pins.length > MAX_REMOVAL_VOLUMES
    || pins.some((pin) => !pin || typeof pin.volumeKey !== 'string' || pin.volumeName !== `${payload.projectName}_${pin.volumeKey}`
      || typeof pin.volumeFingerprint !== 'string' || !SHA256_PATTERN.test(pin.volumeFingerprint))
    || new Set(pins.map((pin) => pin.volumeKey)).size !== pins.length) {
    throw fail('docker_compose_removal_volumes_invalid', 'Confirmed volume deletion scope is invalid');
  }
  return pins;
}

// Physical down has a durable receipt before metadata retirement. Reconciliation
// rechecks absence and resumes only deletion of the same pinned public records.
// Named volumes are kept unless the confirmed preview opted in to deleting them;
// opted-in volumes are deleted after down and before metadata retirement, through
// the same ownership, cross-project, metadata and fingerprint checks as the
// single-volume delete operation.
export function createDockerComposeRemoval({
  projectRegistry,
  environmentRegistry,
  credentialRegistry,
  websiteRegistry,
  domainRegistry = null,
  jobRegistry = null,
  observer,
  volumeManager = null,
  validateDockerCompose = null,
  siteMutationLock = null,
} = {}) {
  async function inspect({ projectId, projectName, serverId }) {
    if (typeof websiteRegistry?.listWebsites !== 'function' || typeof observer?.inspectRemoved !== 'function'
      || typeof projectRegistry?.removeProject !== 'function' || typeof environmentRegistry?.removeForProject !== 'function'
      || typeof credentialRegistry?.removeForProject !== 'function') throw fail('docker_compose_removal_unavailable', 'Native project retirement is unavailable');
    const websites = await websiteRegistry.listWebsites({ serverId });
    if (!Array.isArray(websites)) throw fail('docker_compose_removal_inventory_unavailable', 'Website inventory is unavailable');
    if (websites.some(site => site.managedComposeBinding?.projectId === projectId)) throw fail('docker_compose_project_in_use', 'Remove the bound Websites before retiring this Compose project');
    if (domainRegistry !== null && domainRegistry !== undefined) {
      await assertProjectNotReferencedByProxyRoutes({
        projectId,
        serverId,
        domainRegistry,
        jobRegistry,
        ErrorClass: DockerComposeOperationsError,
        code: 'docker_compose_project_in_use',
      });
    } else if (jobRegistry !== null && jobRegistry !== undefined) {
      await assertProjectNotReferencedByProxyRoutes({
        projectId,
        serverId,
        domainRegistry: null,
        jobRegistry,
        ErrorClass: DockerComposeOperationsError,
        code: 'docker_compose_project_in_use',
      });
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName ?? '')) throw fail('docker_compose_removal_scope_invalid', 'Project identity is invalid');
    return { ready: true };
  }

  function requireVolumeManager() {
    if (!volumeManager || typeof volumeManager.inspectVolumeDetail !== 'function'
      || typeof volumeManager.deleteVolume !== 'function' || typeof projectRegistry?.listProjects !== 'function') {
      throw new DockerComposeOperationsError('docker_compose_removal_volumes_unavailable', 'Docker volume inventory is unavailable', 503);
    }
    return volumeManager;
  }

  async function listRemovalVolumes(project) {
    const catalog = await resolveProjectVolumeCatalog(project, { projectRegistry, validateDockerCompose });
    if (catalog.length === 0) return [];
    const manager = requireVolumeManager();
    const reasons = dockerVolumeOperationsInternals.blockReasons;
    const items = [];
    for (const entry of catalog) {
      const projectScoped = entry.external !== true && entry.scope === 'project'
        && entry.runtimeName === `${project.projectName}_${entry.volumeKey}`;
      let present = null;
      let fingerprint = null;
      let blockCode = null;
      if (!projectScoped) {
        blockCode = 'docker_volume_external_forbidden';
      } else {
        const detail = await manager.inspectVolumeDetail(entry.runtimeName);
        present = detail.present === true;
        if (!present && !entry.declaredActive) continue;
        if (!present) {
          blockCode = 'docker_volume_not_found';
        } else if ((await findCrossProjectVolumeReferences({
          targetProject: project, volumeName: entry.runtimeName, projectRegistry, validateDockerCompose,
        })).length > 0) {
          blockCode = 'docker_volume_cross_project_referenced';
        } else {
          try {
            dockerVolumeManagerInternals.assertVolumeDeletableMetadata(detail, { projectName: project.projectName, volumeKey: entry.volumeKey });
            fingerprint = detail.fingerprint;
          } catch (error) {
            blockCode = error?.code ?? 'docker_volume_ownership_unverified';
          }
        }
      }
      items.push(Object.freeze({
        volumeKey: entry.volumeKey,
        volumeName: entry.runtimeName,
        present,
        deletable: blockCode === null,
        fingerprint,
        blockCode,
        blockReason: blockCode === null ? null : (reasons[blockCode] ?? 'Bu volume silinemez.'),
      }));
    }
    return items;
  }

  async function preview({ projectId, projectName, serverId }) {
    await inspect({ projectId, projectName, serverId });
    const project = await projectRegistry.getProject(projectId);
    if (!project || project.serverId !== serverId || project.projectName !== projectName) throw fail('docker_compose_preview_stale', 'Project changed before retirement preview');
    try {
      return Object.freeze({ ready: true, volumes: Object.freeze(await listRemovalVolumes(project)) });
    } catch (error) {
      throw mapVolumeError(error);
    }
  }

  // Each pin is re-verified against the live project catalog and host metadata.
  // Before down, attached project containers are expected; deleteVolume itself
  // refuses any volume that still has a container after down.
  async function verifyPin(project, pin) {
    const catalog = await resolveProjectVolumeCatalog(project, { projectRegistry, validateDockerCompose });
    let owned;
    try { owned = assertVolumeOwnedByProject(project, catalog, pin.volumeKey); }
    catch { throw fail('docker_compose_removal_volumes_invalid', 'Confirmed volume is not owned by this project'); }
    if (owned.volumeName !== pin.volumeName) throw fail('docker_compose_removal_volumes_invalid', 'Confirmed volume identity mismatch');
    const crossRefs = await findCrossProjectVolumeReferences({
      targetProject: project, volumeName: owned.volumeName, projectRegistry, validateDockerCompose,
    });
    if (crossRefs.length > 0) throw fail('docker_volume_cross_project_referenced', 'Docker volume name is referenced by another managed Compose project on this server');
    return owned;
  }

  function withVolumeLock(volumeName, action) {
    if (typeof siteMutationLock?.withDockerVolumeLock !== 'function') return action();
    return siteMutationLock.withDockerVolumeLock(volumeName, action);
  }

  // Returns the pins still present on the host. With allowAbsent, a missing
  // volume counts as removed by an earlier attempt of this same job.
  async function verifyPins(project, pins, { allowAbsent }) {
    const manager = requireVolumeManager();
    const remaining = [];
    for (const pin of pins) {
      const owned = await verifyPin(project, pin);
      const detail = await manager.inspectVolumeDetail(owned.volumeName);
      if (allowAbsent && detail.present !== true) continue;
      dockerVolumeManagerInternals.assertVolumeDeletableMetadata(detail, {
        projectName: project.projectName, volumeKey: owned.volumeKey, expectedFingerprint: pin.volumeFingerprint,
      });
      remaining.push(pin);
    }
    return remaining;
  }

  async function deleteVolumes(project, pins, authorizeActor) {
    const manager = requireVolumeManager();
    // Verify every pin before deleting any, so one drifted volume never leaves
    // a partially deleted set behind.
    const remaining = await verifyPins(project, pins, { allowAbsent: true });
    for (const pin of remaining) {
      await withVolumeLock(pin.volumeName, async () => {
        const owned = await verifyPin(project, pin);
        if ((await manager.inspectVolumeDetail(owned.volumeName)).present !== true) return;
        try {
          await manager.deleteVolume({
            projectName: project.projectName,
            volumeKey: owned.volumeKey,
            volumeName: owned.volumeName,
            expectedFingerprint: pin.volumeFingerprint,
            beforeRemove: async () => { await authorizeActor?.(); },
          });
        } catch (error) {
          if (error?.code !== 'docker_volume_not_found') throw error;
        }
      });
    }
  }

  async function authorize(payload, execution) {
    await execution?.authorize?.();
    const pins = removalVolumePins(payload);
    const project = await projectRegistry.getProject(payload.projectId);
    if (!project || project.serverId !== execution.serverId || project.projectName !== payload.projectName
      || project.revision !== payload.expectedProjectRevision || project.composeSha256 !== payload.expectedComposeSha256) throw fail('docker_compose_preview_stale', 'Project changed before retirement');
    const ready = await inspect({ ...project, projectId: project.id });
    if (pins) {
      try { await verifyPins(project, pins, { allowAbsent: false }); }
      catch (error) { throw mapVolumeError(error); }
    }
    return ready;
  }
  async function finalize(job) {
    if (job.operation !== OPERATIONS.DOCKER_COMPOSE_REMOVE) return { reconciled: true };
    const { payload } = job;
    await job.authorize?.();
    const pins = removalVolumePins(payload);
    await inspect({ projectId: payload.projectId, projectName: payload.projectName, serverId: job.serverId });
    const actual = await observer.inspectRemoved({ projectName: payload.projectName });
    if (actual?.absent !== true) throw fail('docker_compose_removal_unverified', 'Compose resources reappeared; do not repeat down');
    const project = await projectRegistry.getProject(payload.projectId);
    if (project && (project.serverId !== job.serverId || project.projectName !== payload.projectName
      || project.revision !== payload.expectedProjectRevision || project.composeSha256 !== payload.expectedComposeSha256)) throw fail('docker_compose_preview_stale', 'Project changed before metadata retirement');
    // Volumes go before any metadata: the project record is their ownership
    // evidence, and a missing project means this step already completed.
    if (project && pins) {
      try { await deleteVolumes(project, pins, job.authorize); }
      catch (error) { throw mapVolumeError(error); }
    }
    // Missing records are accepted only after observed physical absence. Project
    // is last, so startup never encounters dangling environment/credential refs.
    await environmentRegistry.removeForProject(payload.projectId, { expectedRevision: payload.expectedEnvironmentRevision });
    await credentialRegistry.removeForProject(payload.projectId, { credentialRevisions: payload.credentialRevisions });
    await projectRegistry.removeProject(payload.projectId, { expectedRevision: payload.expectedProjectRevision, expectedComposeSha256: payload.expectedComposeSha256 });
    return { reconciled: true };
  }
  return Object.freeze({ inspect, preview, authorize, finalize });
}

export const dockerComposeRemovalInternals = Object.freeze({ removalVolumePins, maxRemovalVolumes: MAX_REMOVAL_VOLUMES });
