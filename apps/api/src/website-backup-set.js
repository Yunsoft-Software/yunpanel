import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { createWebsitePathContract } from '@yunpanel/host-runtime';

const BACKUP_SET_VERSION = 1;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DEFAULT_BACKUP_RESOURCE_ROOT = '/var/lib/yunpanel/backups/resources';

const DEFAULT_FILE_EXCLUSIONS = Object.freeze(['.git', 'node_modules/.cache', 'tmp']);
const DEFAULT_DATA_EXCLUSIONS = Object.freeze(['**/tmp/**', '**/*.sock', '**/*.pid']);

export class WebsiteBackupSetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteBackupSetError';
    this.code = code;
    this.status = status;
  }
}

function normalizeUuid(value, label) {
  try {
    return assertUuid(value, label);
  } catch {
    throw new WebsiteBackupSetError('invalid_website_id', `${label} is invalid`, 400);
  }
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function uniqueSorted(array) {
  return Object.freeze([...new Set(array.filter((item) => typeof item === 'string' && item.length > 0))].sort());
}

export function normalizeWebsiteBackupSet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== BACKUP_SET_VERSION
    || !value.website || typeof value.website !== 'object'
    || !value.files || typeof value.files !== 'object'
    || !value.data || typeof value.data !== 'object'
    || !value.env || typeof value.env !== 'object'
    || !Array.isArray(value.databases)
    || !Array.isArray(value.mail)
    || !Array.isArray(value.dns)
    || !Array.isArray(value.nginx)
    || !value.composeHooks || typeof value.composeHooks !== 'object'
    || !Array.isArray(value.targetPaths)
    || !Array.isArray(value.excludePatterns)
    || !Array.isArray(value.tags)) {
    throw new WebsiteBackupSetError('website_backup_set_invalid', 'Website backup set format is invalid', 409);
  }

  const payloadForDigest = {
    version: value.version,
    website: value.website,
    files: value.files,
    data: value.data,
    env: value.env,
    databases: value.databases,
    mail: value.mail,
    dns: value.dns,
    nginx: value.nginx,
    composeHooks: value.composeHooks,
    targetPaths: value.targetPaths,
    excludePatterns: value.excludePatterns,
    tags: value.tags,
  };

  const expectedDigest = sha256(payloadForDigest);
  if (value.digest !== expectedDigest) {
    throw new WebsiteBackupSetError('website_backup_set_digest_mismatch', 'Website backup set digest mismatch', 409);
  }

  return Object.freeze({
    ...value,
    targetPaths: Object.freeze([...value.targetPaths]),
    excludePatterns: Object.freeze([...value.excludePatterns]),
    tags: Object.freeze([...value.tags]),
    databases: Object.freeze(value.databases.map((db) => Object.freeze({ ...db }))),
    mail: Object.freeze(value.mail.map((m) => Object.freeze({ ...m }))),
    dns: Object.freeze(value.dns.map((d) => Object.freeze({ ...d }))),
    nginx: Object.freeze(value.nginx.map((n) => Object.freeze({ ...n }))),
  });
}

export function createWebsiteBackupSetProvider({
  websiteRegistry,
  domainRegistry,
  databaseBindingRegistry,
  mailDomainRegistry,
  applicationRegistry = null,
  applicationEnvironmentRegistry = null,
  dockerComposeProjectRegistry = null,
  localServerId = null,
  backupResourceRoot = DEFAULT_BACKUP_RESOURCE_ROOT,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new WebsiteBackupSetError('website_backup_set_dependencies_invalid', 'Website registry is required', 503);
  }
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function') {
    throw new WebsiteBackupSetError('website_backup_set_dependencies_invalid', 'Domain registry is required', 503);
  }
  if (!databaseBindingRegistry || typeof databaseBindingRegistry.listBindings !== 'function') {
    throw new WebsiteBackupSetError('website_backup_set_dependencies_invalid', 'Database binding registry is required', 503);
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.listMailDomains !== 'function') {
    throw new WebsiteBackupSetError('website_backup_set_dependencies_invalid', 'Mail domain registry is required', 503);
  }

  async function getWebsiteBackupSet({ websiteId, serverId = null } = {}) {
    const normalizedWebsiteId = normalizeUuid(websiteId, 'websiteId');

    const website = await websiteRegistry.getWebsite(normalizedWebsiteId);
    if (!website) {
      throw new WebsiteBackupSetError('website_not_found', 'Website not found', 404);
    }

    if (serverId && website.serverId !== serverId) {
      throw new WebsiteBackupSetError('website_server_mismatch', 'Website belongs to a different server', 404);
    }

    if (localServerId && website.serverId !== localServerId) {
      throw new WebsiteBackupSetError('website_server_mismatch', 'Website belongs to a different server', 404);
    }

    const stagedRoot = path.posix.join(backupResourceRoot, 'website', normalizedWebsiteId);

    // 1. Linked Domains
    const allDomains = await domainRegistry.listDomains();
    const linkedDomains = allDomains
      .filter((domain) => domain.websiteId === website.id || domain.primaryDomain === website.primaryDomain)
      .sort((left, right) => left.id.localeCompare(right.id));
    const linkedDomainIds = new Set(linkedDomains.map((d) => d.id));

    // 2. Application & Path Contract
    let pathContract = null;
    let application = null;
    if (website.applicationId) {
      try {
        pathContract = createWebsitePathContract({
          websiteId: website.id,
          applicationId: website.applicationId,
        });
      } catch {
        pathContract = null;
      }

      if (applicationRegistry && typeof applicationRegistry.getApplication === 'function') {
        try {
          application = await applicationRegistry.getApplication(website.applicationId);
        } catch {
          application = null;
        }
      }
    }

    // 3. Files
    const fileTargetPaths = [];
    let releasesDirectory = null;
    let currentRelease = null;
    let applicationRoot = null;
    let publishRoot = null;
    let composeProjectDirectory = null;

    if (pathContract) {
      applicationRoot = pathContract.runtime.applicationRoot;
      releasesDirectory = pathContract.runtime.releasesDirectory;
      currentRelease = pathContract.runtime.currentRelease;
      fileTargetPaths.push(currentRelease);

      if (website.runtimeType === 'static') {
        publishRoot = pathContract.static.publishRoot;
        fileTargetPaths.push(publishRoot);
      }
    } else if (website.documentRoot) {
      fileTargetPaths.push(website.documentRoot);
    }

    if (website.managedComposeBinding?.projectDirectory) {
      composeProjectDirectory = website.managedComposeBinding.projectDirectory;
      fileTargetPaths.push(composeProjectDirectory);
    }

    const files = Object.freeze({
      runtimeType: website.runtimeType,
      documentRoot: website.documentRoot ?? null,
      applicationRoot,
      releasesDirectory,
      currentRelease,
      publishRoot,
      composeProjectDirectory,
      targetPaths: uniqueSorted(fileTargetPaths),
      inclusions: Object.freeze(['**']),
      exclusions: DEFAULT_FILE_EXCLUSIONS,
    });

    // 4. Data
    const dataTargetPaths = [];
    let persistentDataDirectory = null;
    let logDirectory = null;
    let temporaryDirectory = null;

    if (pathContract) {
      persistentDataDirectory = pathContract.workspace.persistentDataDirectory;
      logDirectory = pathContract.workspace.logDirectory;
      temporaryDirectory = pathContract.workspace.temporaryDirectory;
      dataTargetPaths.push(persistentDataDirectory);
    }

    const data = Object.freeze({
      persistentDataDirectory,
      logDirectory,
      temporaryDirectory,
      targetPaths: uniqueSorted(dataTargetPaths),
      exclusions: DEFAULT_DATA_EXCLUSIONS,
    });

    // 5. Env metadata
    let envStatus = null;
    let envVariables = null;
    if (website.applicationId && applicationEnvironmentRegistry) {
      try {
        if (typeof applicationEnvironmentRegistry.environmentStatus === 'function') {
          envStatus = await applicationEnvironmentRegistry.environmentStatus(website.applicationId, {
            currentReleaseId: application?.currentReleaseId ?? null,
          });
        }
        if (typeof applicationEnvironmentRegistry.listVariables === 'function') {
          envVariables = await applicationEnvironmentRegistry.listVariables(website.applicationId);
        }
      } catch {
        envStatus = null;
        envVariables = null;
      }
    }

    const variableKeys = Array.isArray(envVariables)
      ? envVariables.map((variable) => variable.key).sort()
      : [];

    const env = Object.freeze({
      savedRevision: envStatus?.savedRevision ?? 0,
      appliedRevision: envStatus?.appliedRevision ?? null,
      appliedReleaseId: envStatus?.appliedReleaseId ?? null,
      variablesCount: variableKeys.length,
      variableKeys: Object.freeze(variableKeys),
      stagedMetadataPath: website.applicationId
        ? path.posix.join(stagedRoot, 'env-metadata.json')
        : null,
    });

    // 6. DB Dump
    const databaseBindings = await databaseBindingRegistry.listBindings({
      serverId: website.serverId,
      websiteId: website.id,
    });

    const databases = databaseBindings
      .sort((left, right) => left.databaseName.localeCompare(right.databaseName))
      .map((binding) => {
        const stagedDumpPath = path.posix.join(stagedRoot, 'databases', `${binding.databaseName}.sql`);
        return Object.freeze({
          bindingId: binding.id,
          databaseName: binding.databaseName,
          engine: 'mariadb',
          unixUser: binding.unixUser,
          dumpHook: Object.freeze({
            program: '/usr/bin/mariadb-dump',
            args: Object.freeze([
              '--single-transaction',
              '--quick',
              '--routines',
              '--events',
              '--triggers',
              '--hex-blob',
              '--databases',
              binding.databaseName,
            ]),
            stagedDumpPath,
          }),
        });
      });

    // 7. Mail
    const allMailDomains = await mailDomainRegistry.listMailDomains();
    const mailDomains = allMailDomains
      .filter((mailDomain) => linkedDomainIds.has(mailDomain.webDomainId))
      .sort((left, right) => left.domainName.localeCompare(right.domainName))
      .map((mailDomain) => {
        const isLocal = mailDomain.managementMode === 'local';
        const storagePath = isLocal ? `/var/vmail/${mailDomain.domainName}` : null;
        const virtualMailDbSnapshot = isLocal
          ? path.posix.join(stagedRoot, 'mail', `${mailDomain.domainName}-virtual.sql`)
          : null;
        return Object.freeze({
          mailDomainId: mailDomain.id,
          domainName: mailDomain.domainName,
          webDomainId: mailDomain.webDomainId,
          managementMode: mailDomain.managementMode,
          status: mailDomain.status,
          storagePath,
          virtualMailDbSnapshot,
        });
      });

    // 8. DNS
    const dns = linkedDomains.map((domain) => {
      const mode = domain.dns?.mode ?? 'external';
      const zoneName = domain.dns?.zoneName ?? domain.primaryDomain;
      const stagedZonePath = path.posix.join(stagedRoot, 'dns', `${domain.primaryDomain}.zone.json`);
      return Object.freeze({
        domainId: domain.id,
        primaryDomain: domain.primaryDomain,
        aliases: Object.freeze([...(domain.aliases ?? [])].sort()),
        mode,
        zoneName,
        stagedZonePath,
      });
    });

    // 9. Nginx
    const nginx = linkedDomains.map((domain) => {
      const configPath = `/etc/nginx/sites-available/yunpanel-${domain.id}.conf`;
      const stagedConfigPath = path.posix.join(stagedRoot, 'nginx', `${domain.id}.conf`);
      return Object.freeze({
        domainId: domain.id,
        primaryDomain: domain.primaryDomain,
        configPath,
        appliedRevision: domain.appliedRevision ?? 0,
        stagedConfigPath,
      });
    });

    // 10. Compose Hooks
    let composeHooks = Object.freeze({ enabled: false });
    if (website.managedComposeBinding) {
      const binding = website.managedComposeBinding;
      let project = null;
      if (dockerComposeProjectRegistry && typeof dockerComposeProjectRegistry.getProject === 'function') {
        try {
          project = await dockerComposeProjectRegistry.getProject(binding.projectId);
        } catch {
          project = null;
        }
      }

      const composeFile = path.posix.join(binding.projectDirectory, 'docker-compose.yml');
      const storageMounts = [];
      if (project?.services) {
        for (const service of project.services) {
          if (Array.isArray(service.storageMounts)) {
            for (const mount of service.storageMounts) {
              if (mount.kind === 'named_volume' || (mount.kind === 'bind' && mount.sourceScope === 'project')) {
                storageMounts.push(Object.freeze({ ...mount, serviceName: service.name }));
              }
            }
          }
        }
      }

      composeHooks = Object.freeze({
        enabled: true,
        projectId: binding.projectId,
        projectName: binding.projectName,
        projectDirectory: binding.projectDirectory,
        composeFile,
        preHook: Object.freeze({
          command: 'docker',
          args: Object.freeze(['compose', '-p', binding.projectName, '-f', composeFile, 'pause']),
        }),
        postHook: Object.freeze({
          command: 'docker',
          args: Object.freeze(['compose', '-p', binding.projectName, '-f', composeFile, 'unpause']),
        }),
        storage: Object.freeze(storageMounts),
      });
    }

    // 11. Consolidated target paths & exclusions for restic snapshot
    const targetPaths = uniqueSorted([
      ...files.targetPaths,
      ...data.targetPaths,
      stagedRoot,
      ...mailDomains.map((m) => m.storagePath).filter(Boolean),
      ...(composeHooks.enabled ? [composeHooks.projectDirectory] : []),
    ]);

    const excludePatterns = uniqueSorted([
      ...files.exclusions,
      ...data.exclusions,
    ]);

    // 12. Restic snapshot tags
    const tags = uniqueSorted([
      `website:${website.id}`,
      `server:${website.serverId}`,
      `domain:${website.primaryDomain}`,
      `runtime:${website.runtimeType}`,
    ]);

    // 13. Digest computation
    const websiteSummary = Object.freeze({
      id: website.id,
      serverId: website.serverId,
      name: website.name,
      primaryDomain: website.primaryDomain,
      runtimeType: website.runtimeType,
      applicationId: website.applicationId ?? null,
      unixUser: website.unixUser ?? null,
      revision: website.revision,
    });

    const payloadForDigest = {
      version: BACKUP_SET_VERSION,
      website: websiteSummary,
      files,
      data,
      env,
      databases,
      mail: mailDomains,
      dns,
      nginx,
      composeHooks,
      targetPaths,
      excludePatterns,
      tags,
    };

    const digest = sha256(payloadForDigest);

    return normalizeWebsiteBackupSet({
      ...payloadForDigest,
      digest,
    });
  }

  return Object.freeze({
    getWebsiteBackupSet,
  });
}
