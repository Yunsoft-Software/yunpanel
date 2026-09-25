const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ROLES = new Set(['owner', 'site_manager']);

import { createHash } from 'node:crypto';
import { renderCronTaskFile } from '@yunpanel/config-templates';
import { cronRemovalIdentity } from './website-cron-removal-proof.js';

// Shared by individual cron deletion and confirmed Website cleanup. The
// existing job key/payload is preserved; commands never enter parent progress.
function authorizationPayload(authorization = null) {
  if (authorization === null) return Object.freeze({ authorizationMode: 'system_removal' });
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)
    || typeof authorization.sessionId !== 'string' || !UUID.test(authorization.sessionId)
    || typeof authorization.userId !== 'string' || !UUID.test(authorization.userId)
    || !USER_ROLES.has(authorization.role)) {
    throw new TypeError('Cron user authorization context is invalid');
  }
  return Object.freeze({
    authorizationMode: 'user',
    actorSessionId: authorization.sessionId,
    actorUserId: authorization.userId,
    actorRole: authorization.role,
  });
}

export function createCronRemovalRequest(task, authorization = null) {
  const text = renderCronTaskFile({ taskId: task.id, user: task.unixUser,
    schedule: task.schedule, command: task.command, enabled: task.enabled });
  const identity = cronRemovalIdentity(task, createHash('sha256').update(text).digest('hex'));
  return Object.freeze({ identity, request: cronRemovalRequestFromIdentity(identity, authorization) });
}

export function cronRemovalRequestFromIdentity(value, authorization = null) {
  const identity = cronRemovalIdentity({ id: value.taskId, websiteId: value.websiteId,
    serverId: value.serverId, applicationId: value.applicationId, unixUser: value.unixUser,
    revision: value.revision }, value.desiredStateSha256);
  return Object.freeze({ serverId: identity.serverId, type: 'cron.remove', operation: 'cron.remove',
    payload: Object.freeze({ taskId: identity.taskId, websiteId: identity.websiteId,
      applicationId: identity.applicationId, unixUser: identity.unixUser,
      expectedRevision: identity.revision, desiredStateSha256: identity.desiredStateSha256,
      ...authorizationPayload(authorization) }),
    resourceType: 'website_cron', resourceId: identity.taskId,
    idempotencyKey: `cron.remove:${identity.taskId}:${identity.revision}:${identity.desiredStateSha256}` });
}

export const websiteCronRemovalRequestInternals = Object.freeze({ authorizationPayload });
