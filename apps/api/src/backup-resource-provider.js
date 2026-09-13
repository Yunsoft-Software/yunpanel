import { createBackupManifest } from './backup-manifest.js';
import { createBackupPlan } from './backup-plan.js';
import { databaseBackupResources } from './database-backup-resource.js';
import { mailDataBackupResource } from './mail-data-backup-resource.js';

export class BackupResourceProviderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupResourceProviderError';
    this.code = code;
    this.status = status;
  }
}

function requireDependency(condition, message) {
  if (!condition) throw new BackupResourceProviderError('backup_resource_provider_dependencies_invalid', message, 503);
}

async function sourceRead(code, message, loader) {
  try {
    return await loader();
  } catch (error) {
    if (error instanceof BackupResourceProviderError) throw error;
    throw new BackupResourceProviderError(code, message, 503);
  }
}

function requireArray(value, code, message) {
  if (!Array.isArray(value)) throw new BackupResourceProviderError(code, message, 503);
  return value;
}

export function createBackupResourceProvider({
  serverRegistry,
  dockerComposeProjectRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry,
  loadDatabaseInventory,
  mailDomainRegistry,
  domainRegistry,
  mailDataOperationsService,
  now = () => Date.now(),
} = {}) {
  requireDependency(serverRegistry && typeof serverRegistry.getServer === 'function', 'Server registry is required');
  requireDependency(
    dockerComposeProjectRegistry && typeof dockerComposeProjectRegistry.listProjects === 'function',
    'Docker Compose project registry is required',
  );
  requireDependency(applicationRegistry && typeof applicationRegistry.listApplications === 'function', 'Application registry is required');
  requireDependency(
    applicationEnvironmentRegistry && typeof applicationEnvironmentRegistry.environmentStatus === 'function',
    'Application environment registry is required',
  );
  requireDependency(typeof loadDatabaseInventory === 'function', 'Database inventory loader is required');
  requireDependency(mailDomainRegistry && typeof mailDomainRegistry.listMailDomains === 'function', 'Mail Domain registry is required');
  requireDependency(domainRegistry && typeof domainRegistry.getDomain === 'function', 'Domain registry is required');
  requireDependency(
    mailDataOperationsService && typeof mailDataOperationsService.previewBackup === 'function',
    'Mail data backup preview service is required',
  );
  requireDependency(typeof now === 'function', 'Backup clock is required');

  async function requireServer(serverId) {
    const server = await sourceRead(
      'backup_server_state_unavailable',
      'Backup server state could not be verified',
      () => serverRegistry.getServer(serverId),
    );
    if (!server) throw new BackupResourceProviderError('server_not_found', 'Server not found', 404);
    return server;
  }

  async function dockerProjects(serverId) {
    const projects = await sourceRead(
      'backup_docker_inventory_unavailable',
      'Docker backup inventory could not be read',
      () => dockerComposeProjectRegistry.listProjects({ serverId }),
    );
    return requireArray(projects, 'backup_docker_inventory_unavailable', 'Docker backup inventory is invalid');
  }

  async function applications(serverId) {
    const all = requireArray(await sourceRead(
      'backup_application_inventory_unavailable',
      'Application backup inventory could not be read',
      () => applicationRegistry.listApplications(),
    ), 'backup_application_inventory_unavailable', 'Application backup inventory is invalid');
    const scoped = all.filter((application) => application?.serverId === serverId)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const snapshots = [];
    for (const application of scoped) {
      const environment = await sourceRead(
        'backup_application_environment_unavailable',
        'Application environment backup state could not be read',
        () => applicationEnvironmentRegistry.environmentStatus(application.id, {
          currentReleaseId: application.currentReleaseId ?? null,
        }),
      );
      snapshots.push(Object.freeze({ application, environment }));
    }
    return Object.freeze(snapshots);
  }

  async function databases(serverId) {
    const inventory = await sourceRead(
      'backup_database_inventory_unavailable',
      'Database backup inventory could not be read',
      () => loadDatabaseInventory(serverId),
    );
    if (inventory === null) {
      throw new BackupResourceProviderError(
        'backup_database_inventory_required',
        'Refresh the database inventory before creating a general backup preview',
        409,
      );
    }
    try {
      return databaseBackupResources({ serverId, inventory });
    } catch {
      throw new BackupResourceProviderError(
        'backup_database_inventory_invalid',
        'Database backup inventory is invalid',
        409,
      );
    }
  }

  async function mailData(serverId) {
    const mailDomains = requireArray(await sourceRead(
      'backup_mail_inventory_unavailable',
      'Mail backup inventory could not be read',
      () => mailDomainRegistry.listMailDomains(),
    ), 'backup_mail_inventory_unavailable', 'Mail backup inventory is invalid')
      .filter((mailDomain) => mailDomain?.managementMode === 'local' && typeof mailDomain.webDomainId === 'string')
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    const resources = [];
    for (const mailDomain of mailDomains) {
      const domain = await sourceRead(
        'backup_mail_domain_state_unavailable',
        'Mail Domain ownership could not be verified',
        () => domainRegistry.getDomain(mailDomain.webDomainId),
      );
      if (!domain) {
        throw new BackupResourceProviderError(
          'backup_mail_domain_state_invalid',
          'Mail Domain backup ownership is stale',
          409,
        );
      }
      if (domain.serverId !== serverId) continue;
      if (domain.primaryDomain !== mailDomain.domainName) {
        throw new BackupResourceProviderError(
          'backup_mail_domain_state_invalid',
          'Mail Domain backup ownership is inconsistent',
          409,
        );
      }
      const preview = await sourceRead(
        'backup_mail_data_unavailable',
        'Mail data backup state could not be inspected',
        () => mailDataOperationsService.previewBackup({ scope: 'domain', resourceId: mailDomain.id }),
      );
      try {
        resources.push(mailDataBackupResource({ serverId, preview }));
      } catch {
        throw new BackupResourceProviderError(
          'backup_mail_data_invalid',
          'Mail data backup state is invalid',
          409,
        );
      }
    }
    return Object.freeze(resources.sort((left, right) => left.identity.localeCompare(right.identity)));
  }

  async function preview({ serverId, selectedResourceIdentities = null } = {}) {
    const server = await requireServer(serverId);
    const [projects, applicationSnapshots, databaseResources, mailDataResources] = await Promise.all([
      dockerProjects(server.id),
      applications(server.id),
      databases(server.id),
      mailData(server.id),
    ]);

    let baseManifest;
    try {
      baseManifest = createBackupManifest({
        serverId: server.id,
        dockerProjects: projects,
        applicationSnapshots,
        createdAt: new Date(now()).toISOString(),
      });
    } catch {
      throw new BackupResourceProviderError('backup_resource_state_invalid', 'Backup resource state is invalid', 409);
    }

    return createBackupPlan({
      baseManifest,
      databaseResources,
      mailDataResources,
      selectedResourceIdentities,
    });
  }

  return Object.freeze({ preview });
}
