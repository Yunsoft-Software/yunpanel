import { createHash } from 'node:crypto';
import { renderCronTaskFile } from '@yunpanel/config-templates';
import { cronRemovalIdentity } from './website-cron-removal-proof.js';

// Shared by individual cron deletion and confirmed Website cleanup. The
// existing job key/payload is preserved; commands never enter parent progress.
export function createCronRemovalRequest(task) {
  const text = renderCronTaskFile({ taskId: task.id, user: task.unixUser,
    schedule: task.schedule, command: task.command, enabled: task.enabled });
  const identity = cronRemovalIdentity(task, createHash('sha256').update(text).digest('hex'));
  return Object.freeze({ identity, request: cronRemovalRequestFromIdentity(identity) });
}

export function cronRemovalRequestFromIdentity(value) {
  const identity = cronRemovalIdentity({ id: value.taskId, websiteId: value.websiteId,
    serverId: value.serverId, applicationId: value.applicationId, unixUser: value.unixUser,
    revision: value.revision }, value.desiredStateSha256);
  return Object.freeze({ serverId: identity.serverId, type: 'cron.remove', operation: 'cron.remove',
    payload: Object.freeze({ taskId: identity.taskId, websiteId: identity.websiteId,
      applicationId: identity.applicationId, unixUser: identity.unixUser,
      expectedRevision: identity.revision, desiredStateSha256: identity.desiredStateSha256 }),
    resourceType: 'website_cron', resourceId: identity.taskId,
    idempotencyKey: `cron.remove:${identity.taskId}:${identity.revision}:${identity.desiredStateSha256}` });
}
