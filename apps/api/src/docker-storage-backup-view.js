import {
  backupManifestInternals,
  dockerStorageBackupResources,
} from './backup-manifest.js';

function counts(resources) {
  const value = { total: resources.length, included: 0, excluded: 0, rejected: 0 };
  for (const resource of resources) {
    if (resource.policy.disposition === 'include') value.included += 1;
    else if (resource.policy.disposition === 'exclude') value.excluded += 1;
    else if (resource.policy.disposition === 'reject') value.rejected += 1;
  }
  return Object.freeze(value);
}

export function createDockerStorageBackupView(project) {
  const resources = dockerStorageBackupResources(project);
  return Object.freeze({
    manifestVersion: backupManifestInternals.manifestVersion,
    serverId: project.serverId,
    projectId: project.id,
    projectRevision: project.revision,
    resources,
    counts: counts(resources),
  });
}

export const dockerStorageBackupViewInternals = Object.freeze({ counts });
