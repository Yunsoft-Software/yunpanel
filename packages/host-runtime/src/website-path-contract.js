import path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROOTS = Object.freeze({
  application: '/var/lib/yunpanel/apps',
  data: '/var/lib/yunpanel/data',
  staticBuild: '/var/lib/yunpanel/build',
  staticPublish: '/var/www/yunpanel/apps',
  backupArtifacts: '/var/lib/yunpanel/backups/resources',
});

const AUTHORITIES = Object.freeze({
  siteUser: 'site_user',
  controlPlane: 'control_plane',
});

export class WebsitePathContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsitePathContractError';
    this.code = code;
  }
}

function normalizeUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WebsitePathContractError('website_path_identity_invalid', `${field} is invalid`);
  }
  return value.toLowerCase();
}

function directChild(root, id) {
  const value = path.posix.join(root, id);
  if (path.posix.dirname(value) !== root || path.posix.basename(value) !== id) {
    throw new WebsitePathContractError('website_path_escape_rejected', 'Website path escaped its managed root');
  }
  return value;
}

export function createWebsitePathContract({ websiteId, applicationId } = {}) {
  const normalizedWebsiteId = normalizeUuid(websiteId, 'websiteId');
  const normalizedApplicationId = normalizeUuid(applicationId, 'applicationId');

  const homeDirectory = directChild(ROOTS.data, normalizedApplicationId);
  const applicationRoot = directChild(ROOTS.application, normalizedApplicationId);
  const staticBuildRoot = directChild(ROOTS.staticBuild, normalizedApplicationId);
  const staticPublishRoot = directChild(ROOTS.staticPublish, normalizedApplicationId);

  return Object.freeze({
    websiteId: normalizedWebsiteId,
    applicationId: normalizedApplicationId,
    workspace: Object.freeze({
      authority: AUTHORITIES.siteUser,
      homeDirectory,
      persistentDataDirectory: homeDirectory,
      temporaryDirectory: path.posix.join(homeDirectory, 'tmp'),
      logDirectory: path.posix.join(homeDirectory, 'logs'),
      sftpRoot: homeDirectory,
    }),
    runtime: Object.freeze({
      containerAuthority: AUTHORITIES.controlPlane,
      releaseAuthority: AUTHORITIES.siteUser,
      applicationRoot,
      releasesDirectory: path.posix.join(applicationRoot, 'releases'),
      currentRelease: path.posix.join(applicationRoot, 'current'),
    }),
    static: Object.freeze({
      buildAuthority: AUTHORITIES.siteUser,
      buildRoot: staticBuildRoot,
      publishRoot: staticPublishRoot,
    }),
    backup: Object.freeze({
      authority: AUTHORITIES.controlPlane,
      artifactRoot: ROOTS.backupArtifacts,
      scopeKey: `website:${normalizedWebsiteId}`,
    }),
  });
}

export const websitePathContractInternals = Object.freeze({
  roots: ROOTS,
  authorities: AUTHORITIES,
  uuidPattern: UUID_PATTERN,
  normalizeUuid,
  directChild,
});
