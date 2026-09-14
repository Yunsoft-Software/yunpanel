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

const MODES = Object.freeze({
  home: 0o750,
  temporary: 0o700,
  logs: 0o750,
  backupArtifacts: 0o700,
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

function normalizeRoot(value, field) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value)) {
    throw new WebsitePathContractError('website_path_root_invalid', `${field} is invalid`);
  }
  const normalized = path.posix.resolve(value);
  if (normalized === '/') {
    throw new WebsitePathContractError('website_path_root_invalid', `${field} cannot be filesystem root`);
  }
  return normalized;
}

function directChild(root, id) {
  const value = path.posix.join(root, id);
  if (path.posix.dirname(value) !== root || path.posix.basename(value) !== id) {
    throw new WebsitePathContractError('website_path_escape_rejected', 'Website path escaped its managed root');
  }
  return value;
}

export function createApplicationPathContract(applicationId, {
  applicationRoot = ROOTS.application,
  dataRoot = ROOTS.data,
  staticBuildRoot = ROOTS.staticBuild,
  staticPublishRoot = ROOTS.staticPublish,
} = {}) {
  const normalizedApplicationId = normalizeUuid(applicationId, 'applicationId');
  const managedApplicationRoot = normalizeRoot(applicationRoot, 'applicationRoot');
  const managedDataRoot = normalizeRoot(dataRoot, 'dataRoot');
  const managedStaticBuildRoot = normalizeRoot(staticBuildRoot, 'staticBuildRoot');
  const managedStaticPublishRoot = normalizeRoot(staticPublishRoot, 'staticPublishRoot');

  const homeDirectory = directChild(managedDataRoot, normalizedApplicationId);
  const applicationDirectory = directChild(managedApplicationRoot, normalizedApplicationId);
  const staticBuildDirectory = directChild(managedStaticBuildRoot, normalizedApplicationId);
  const staticPublishDirectory = directChild(managedStaticPublishRoot, normalizedApplicationId);

  return Object.freeze({
    applicationId: normalizedApplicationId,
    workspace: Object.freeze({
      authority: AUTHORITIES.siteUser,
      homeDirectory,
      homeMode: MODES.home,
      persistentDataDirectory: homeDirectory,
      persistentDataMode: MODES.home,
      temporaryDirectory: path.posix.join(homeDirectory, 'tmp'),
      temporaryMode: MODES.temporary,
      logDirectory: path.posix.join(homeDirectory, 'logs'),
      logMode: MODES.logs,
      sftpRoot: homeDirectory,
    }),
    runtime: Object.freeze({
      containerAuthority: AUTHORITIES.controlPlane,
      releaseAuthority: AUTHORITIES.siteUser,
      applicationRoot: applicationDirectory,
      releasesDirectory: path.posix.join(applicationDirectory, 'releases'),
      currentRelease: path.posix.join(applicationDirectory, 'current'),
    }),
    static: Object.freeze({
      buildAuthority: AUTHORITIES.siteUser,
      buildRoot: staticBuildDirectory,
      publishRoot: staticPublishDirectory,
    }),
  });
}

export function createWebsitePathContract({ websiteId, applicationId } = {}) {
  const normalizedWebsiteId = normalizeUuid(websiteId, 'websiteId');
  const application = createApplicationPathContract(applicationId);

  return Object.freeze({
    websiteId: normalizedWebsiteId,
    applicationId: application.applicationId,
    workspace: application.workspace,
    runtime: application.runtime,
    static: application.static,
    backup: Object.freeze({
      authority: AUTHORITIES.controlPlane,
      artifactRoot: ROOTS.backupArtifacts,
      artifactRootMode: MODES.backupArtifacts,
      scopeKey: `website:${normalizedWebsiteId}`,
    }),
  });
}

export const websitePathContractInternals = Object.freeze({
  roots: ROOTS,
  authorities: AUTHORITIES,
  modes: MODES,
  uuidPattern: UUID_PATTERN,
  normalizeUuid,
  normalizeRoot,
  directChild,
});
