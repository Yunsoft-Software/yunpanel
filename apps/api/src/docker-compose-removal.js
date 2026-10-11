import { OPERATIONS } from '@yunpanel/protocol';
import { DockerComposeOperationsError } from './docker-compose-operations.js';

const fail = (code, message) => new DockerComposeOperationsError(code, message, 409);

// Physical down has a durable receipt before metadata retirement. Reconciliation
// rechecks absence and resumes only deletion of the same pinned public records.
export function createDockerComposeRemoval({ projectRegistry, environmentRegistry, credentialRegistry, websiteRegistry, observer } = {}) {
  async function inspect({ projectId, projectName, serverId }) {
    if (typeof websiteRegistry?.listWebsites !== 'function' || typeof observer?.inspectRemoved !== 'function'
      || typeof projectRegistry?.removeProject !== 'function' || typeof environmentRegistry?.removeForProject !== 'function'
      || typeof credentialRegistry?.removeForProject !== 'function') throw fail('docker_compose_removal_unavailable', 'Native project retirement is unavailable');
    const websites = await websiteRegistry.listWebsites({ serverId });
    if (!Array.isArray(websites)) throw fail('docker_compose_removal_inventory_unavailable', 'Website inventory is unavailable');
    if (websites.some(site => site.managedComposeBinding?.projectId === projectId)) throw fail('docker_compose_project_in_use', 'Remove the bound Websites before retiring this Compose project');
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName ?? '')) throw fail('docker_compose_removal_scope_invalid', 'Project identity is invalid');
    return { ready: true };
  }
  async function authorize(payload, execution) {
    await execution?.authorize?.();
    const project = await projectRegistry.getProject(payload.projectId);
    if (!project || project.serverId !== execution.serverId || project.projectName !== payload.projectName
      || project.revision !== payload.expectedProjectRevision || project.composeSha256 !== payload.expectedComposeSha256) throw fail('docker_compose_preview_stale', 'Project changed before retirement');
    return inspect({ ...project, projectId: project.id });
  }
  async function finalize(job) {
    if (job.operation !== OPERATIONS.DOCKER_COMPOSE_REMOVE) return { reconciled: true };
    const { payload } = job;
    await job.authorize?.();
    await inspect({ projectId: payload.projectId, projectName: payload.projectName, serverId: job.serverId });
    const actual = await observer.inspectRemoved({ projectName: payload.projectName });
    if (actual?.absent !== true) throw fail('docker_compose_removal_unverified', 'Compose resources reappeared; do not repeat down');
    const project = await projectRegistry.getProject(payload.projectId);
    if (project && (project.serverId !== job.serverId || project.projectName !== payload.projectName
      || project.revision !== payload.expectedProjectRevision || project.composeSha256 !== payload.expectedComposeSha256)) throw fail('docker_compose_preview_stale', 'Project changed before metadata retirement');
    // Missing records are accepted only after observed physical absence. Project
    // is last, so startup never encounters dangling environment/credential refs.
    await environmentRegistry.removeForProject(payload.projectId, { expectedRevision: payload.expectedEnvironmentRevision });
    await credentialRegistry.removeForProject(payload.projectId, { credentialRevisions: payload.credentialRevisions });
    await projectRegistry.removeProject(payload.projectId, { expectedRevision: payload.expectedProjectRevision, expectedComposeSha256: payload.expectedComposeSha256 });
    return { reconciled: true };
  }
  return Object.freeze({ inspect, authorize, finalize });
}
