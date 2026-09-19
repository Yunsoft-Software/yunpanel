import { createHash } from 'node:crypto';
import { renderCronTaskFile } from '@yunpanel/config-templates';

export class WebsiteCronImpactError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsiteCronImpactError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createWebsiteCronImpactProvider({
  websiteCronRegistry,
  websiteCronManager,
  localServerId,
} = {}) {
  if (!websiteCronRegistry || typeof websiteCronRegistry.listTasks !== 'function'
    || !websiteCronManager || typeof websiteCronManager.listManagedFiles !== 'function'
    || typeof localServerId !== 'string' || !localServerId) {
    throw new WebsiteCronImpactError(
      'website_cron_dependencies_invalid',
      'Website cron impact provider dependencies are invalid',
      500,
    );
  }

  return async function websiteCronImpactProvider(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new WebsiteCronImpactError(
        'website_cron_context_invalid',
        'Impact provider context is invalid',
        500,
      );
    }
    if (context.serverId !== localServerId) {
      throw new WebsiteCronImpactError(
        'website_cron_local_server_required',
        'Website cron impact inspection is restricted to this panel host',
        404,
      );
    }

    const [allServerTasks, hostInventory] = await Promise.all([
      websiteCronRegistry.listTasks({ serverId: localServerId }),
      websiteCronManager.listManagedFiles(),
    ]);

    if (!hostInventory.cronServiceActive) {
      throw new WebsiteCronImpactError(
        'website_cron_service_unavailable',
        'Cron system service is not active',
        503,
      );
    }

    const hostFilesByTaskId = new Map(hostInventory.files.map((file) => [file.taskId, file]));
    const serverTasksByTaskId = new Map(allServerTasks.map((task) => [task.id, task]));

    // 1. Host file orphan check: every managed file must belong to a known task on this server
    for (const file of hostInventory.files) {
      const task = serverTasksByTaskId.get(file.taskId);
      if (!task) {
        throw new WebsiteCronImpactError(
          'website_cron_orphan_file_detected',
          `Unmanaged cron task file detected on host: ${file.fileName}`,
          409,
        );
      }
      const expectedContent = renderCronTaskFile({
        taskId: task.id,
        user: task.unixUser,
        schedule: task.schedule,
        command: task.command,
        enabled: task.enabled,
      });
      const expectedSha256 = sha256(expectedContent);
      if (file.contentSha256 !== expectedSha256) {
        throw new WebsiteCronImpactError(
          'website_cron_inventory_drift',
          `Cron task file ${file.fileName} has drifted from registry desired state`,
          409,
        );
      }
    }

    // 2. Registry missing host file check: every task on this server must have an exact host file
    for (const task of allServerTasks) {
      if (!hostFilesByTaskId.has(task.id)) {
        throw new WebsiteCronImpactError(
          'website_cron_host_file_missing',
          `Managed cron file missing on host for task: ${task.id}`,
          409,
        );
      }
    }

    const targetWebsiteId = context.resourceType === 'website'
      ? context.resourceId
      : context.websiteId ?? null;

    if (!targetWebsiteId) {
      return Object.freeze([]);
    }

    const matchingTasks = allServerTasks
      .filter((task) => task.websiteId === targetWebsiteId)
      .map((task) => Object.freeze({
        id: task.id,
        state: task.enabled ? 'enabled' : 'disabled',
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    return Object.freeze(matchingTasks);
  };
}
