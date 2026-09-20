import { requirePanelRouteAccess } from './panel-http-guard.js';
import { ResticRepositoryRegistryError } from './restic-repository-registry.js';
import { RcloneRemoteRegistryError } from './rclone-remote-registry.js';

export class BackupRepositoryHttpError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'BackupRepositoryHttpError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function isBackupRepositoryHttpError(error) {
  return error instanceof BackupRepositoryHttpError
    || error instanceof ResticRepositoryRegistryError
    || error instanceof RcloneRemoteRegistryError;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      return next(error);
    }
  };
}

function requireOwner(request, response, next) {
  return requirePanelRouteAccess(request, response, () => {
    if (request.auth?.user?.role !== 'owner') {
      return response.status(403).json({
        error: { code: 'forbidden', message: 'Owner access is required.' },
      });
    }
    return next();
  });
}

export function mountBackupRepositoryRoutes(app, {
  resticRepositoryRegistry,
  rcloneRemoteRegistry = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('Express application is required');
  }

  // --- Restic Repositories ---
  if (resticRepositoryRegistry) {
    // List repositories
    app.get('/api/backups/repositories', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const serverId = localServerId ?? request.query?.serverId ?? null;
      const repositories = await resticRepositoryRegistry.listRepositories({ serverId });
      return response.json({ data: repositories });
    }));

    // Create / init repository
    app.post('/api/backups/repositories', requireOwner, asyncRoute(async (request, response) => {
      const { name, backend, target, password, retentionPolicy, initialize = true } = request.body ?? {};
      const serverId = localServerId ?? request.body?.serverId ?? null;
      let repository = await resticRepositoryRegistry.createRepository({
        serverId,
        name,
        backend,
        target,
        password,
        retentionPolicy,
      });
      if (initialize) {
        await resticRepositoryRegistry.initResticRepository(repository.id);
        repository = await resticRepositoryRegistry.getRepository(repository.id);
      }
      return response.status(201).json({ data: repository });
    }));

    // Initialize repository
    app.post('/api/backups/repositories/:repositoryId/init', requireOwner, asyncRoute(async (request, response) => {
      const result = await resticRepositoryRegistry.initResticRepository(request.params.repositoryId);
      return response.json({ data: result });
    }));

    // Get repository
    app.get('/api/backups/repositories/:repositoryId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const repository = await resticRepositoryRegistry.getRepository(request.params.repositoryId);
      if (!repository) {
        return response.status(404).json({ error: { code: 'restic_repository_not_found', message: 'Repository not found' } });
      }
      return response.json({ data: repository });
    }));

    // Delete repository
    app.delete('/api/backups/repositories/:repositoryId', requireOwner, asyncRoute(async (request, response) => {
      const result = await resticRepositoryRegistry.deleteRepository(request.params.repositoryId);
      return response.json({ data: result });
    }));

    // List snapshots
    app.get('/api/backups/repositories/:repositoryId/snapshots', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const tags = request.query?.tags ? (Array.isArray(request.query.tags) ? request.query.tags : [request.query.tags]) : [];
      const snapshots = await resticRepositoryRegistry.listSnapshots(request.params.repositoryId, { tags });
      return response.json({ data: snapshots });
    }));

    // Check repository
    app.post('/api/backups/repositories/:repositoryId/check', requireOwner, asyncRoute(async (request, response) => {
      const { readDataSubset } = request.body ?? {};
      const result = await resticRepositoryRegistry.checkResticRepository(request.params.repositoryId, { readDataSubset });
      return response.json({ data: result });
    }));

    // Unlock repository
    app.post('/api/backups/repositories/:repositoryId/unlock', requireOwner, asyncRoute(async (request, response) => {
      const { removeAll } = request.body ?? {};
      const result = await resticRepositoryRegistry.unlockResticRepository(request.params.repositoryId, { removeAll });
      return response.json({ data: result });
    }));

    // Apply retention & prune
    app.post('/api/backups/repositories/:repositoryId/prune', requireOwner, asyncRoute(async (request, response) => {
      const { dryRun = false } = request.body ?? {};
      const result = await resticRepositoryRegistry.pruneResticRepository(request.params.repositoryId, { dryRun });
      return response.json({ data: result });
    }));
  }

  // --- Rclone Remotes ---
  if (rcloneRemoteRegistry) {
    // List remotes
    app.get('/api/backups/remotes', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const serverId = localServerId ?? request.query?.serverId ?? null;
      const remotes = await rcloneRemoteRegistry.listRemotes({ serverId });
      return response.json({ data: remotes });
    }));

    // Create remote
    app.post('/api/backups/remotes', requireOwner, asyncRoute(async (request, response) => {
      const { name, type, parameters, credentials } = request.body ?? {};
      const serverId = localServerId ?? request.body?.serverId ?? null;
      const remote = await rcloneRemoteRegistry.createRemote({
        serverId,
        name,
        type,
        parameters,
        credentials,
      });
      return response.status(201).json({ data: remote });
    }));

    // Get remote
    app.get('/api/backups/remotes/:remoteId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const remote = await rcloneRemoteRegistry.getRemote(request.params.remoteId);
      if (!remote) {
        return response.status(404).json({ error: { code: 'rclone_remote_not_found', message: 'Remote not found' } });
      }
      return response.json({ data: remote });
    }));

    // Update remote
    app.put('/api/backups/remotes/:remoteId', requireOwner, asyncRoute(async (request, response) => {
      const { name, parameters, credentials } = request.body ?? {};
      const remote = await rcloneRemoteRegistry.updateRemote(request.params.remoteId, {
        name,
        parameters,
        credentials,
      });
      return response.json({ data: remote });
    }));

    // Delete remote
    app.delete('/api/backups/remotes/:remoteId', requireOwner, asyncRoute(async (request, response) => {
      const result = await rcloneRemoteRegistry.deleteRemote(request.params.remoteId);
      return response.json({ data: result });
    }));

    // Test remote connection
    app.post('/api/backups/remotes/:remoteId/test', requireOwner, asyncRoute(async (request, response) => {
      const result = await rcloneRemoteRegistry.testRemote(request.params.remoteId);
      return response.json({ data: result });
    }));
  }
}
