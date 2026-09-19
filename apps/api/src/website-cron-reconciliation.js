import { createHash } from 'node:crypto';
import { renderCronTaskFile } from '@yunpanel/config-templates';

export class WebsiteCronReconciliationError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'WebsiteCronReconciliationError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createWebsiteCronReconciliationProvider({
  websiteCronRegistry,
  websiteCronManager,
  localServerId,
} = {}) {
  if (!websiteCronRegistry || typeof websiteCronRegistry.listTasks !== 'function'
    || !websiteCronManager || typeof websiteCronManager.listManagedFiles !== 'function'
    || typeof localServerId !== 'string' || !localServerId) {
    throw new WebsiteCronReconciliationError(
      'website_cron_reconciliation_dependencies_invalid',
      'Website cron reconciliation provider dependencies are invalid',
    );
  }

  async function inspectTask(task, hostFilesByTaskId, cronServiceActive) {
    const expectedContent = renderCronTaskFile({
      taskId: task.id,
      user: task.unixUser,
      schedule: task.schedule,
      command: task.command,
      enabled: task.enabled,
    });
    const expectedSha256 = sha256(expectedContent);
    const hostFile = hostFilesByTaskId.get(task.id) ?? null;

    let status = 'ready';
    if (!cronServiceActive) {
      status = 'service_inactive';
    } else if (!hostFile) {
      status = 'missing_host_file';
    } else if (hostFile.contentSha256 !== expectedSha256) {
      status = 'drifted';
    }

    return Object.freeze({
      taskId: task.id,
      websiteId: task.websiteId,
      applicationId: task.applicationId,
      unixUser: task.unixUser,
      name: task.name,
      schedule: task.schedule,
      command: task.command,
      enabled: task.enabled,
      revision: task.revision,
      expectedSha256,
      currentSha256: hostFile?.contentSha256 ?? null,
      hostFileExists: hostFile !== null,
      hostFileExact: hostFile?.contentSha256 === expectedSha256,
      cronServiceActive,
      status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  async function reconcileWebsite(websiteId) {
    if (typeof websiteId !== 'string' || !websiteId) {
      throw new WebsiteCronReconciliationError(
        'website_cron_website_id_invalid',
        'websiteId is required for cron reconciliation',
        400,
      );
    }

    const [tasks, hostInventory] = await Promise.all([
      websiteCronRegistry.listTasks({ websiteId, serverId: localServerId }),
      websiteCronManager.listManagedFiles(),
    ]);

    const hostFilesByTaskId = new Map(hostInventory.files.map((file) => [file.taskId, file]));
    const inspected = await Promise.all(
      tasks.map((task) => inspectTask(task, hostFilesByTaskId, hostInventory.cronServiceActive)),
    );

    const counts = {
      total: inspected.length,
      ready: inspected.filter((entry) => entry.status === 'ready').length,
      missingHostFile: inspected.filter((entry) => entry.status === 'missing_host_file').length,
      drifted: inspected.filter((entry) => entry.status === 'drifted').length,
      serviceInactive: inspected.filter((entry) => entry.status === 'service_inactive').length,
    };

    return Object.freeze({
      websiteId,
      cronServiceActive: hostInventory.cronServiceActive,
      tasks: Object.freeze(inspected),
      summary: Object.freeze(counts),
      reconciled: counts.ready === counts.total && hostInventory.cronServiceActive,
    });
  }

  async function reconcileServer() {
    const [allTasks, hostInventory] = await Promise.all([
      websiteCronRegistry.listTasks({ serverId: localServerId }),
      websiteCronManager.listManagedFiles(),
    ]);

    const hostFilesByTaskId = new Map(hostInventory.files.map((file) => [file.taskId, file]));
    const serverTasksByTaskId = new Map(allTasks.map((task) => [task.id, task]));

    const orphanFiles = hostInventory.files.filter((file) => !serverTasksByTaskId.has(file.taskId));
    const inspectedTasks = await Promise.all(
      allTasks.map((task) => inspectTask(task, hostFilesByTaskId, hostInventory.cronServiceActive)),
    );

    return Object.freeze({
      serverId: localServerId,
      cronServiceActive: hostInventory.cronServiceActive,
      tasks: Object.freeze(inspectedTasks),
      orphanFiles: Object.freeze(orphanFiles),
      clean: orphanFiles.length === 0 && inspectedTasks.every((entry) => entry.status === 'ready'),
    });
  }

  return Object.freeze({
    inspectTask,
    reconcileWebsite,
    reconcileServer,
  });
}
