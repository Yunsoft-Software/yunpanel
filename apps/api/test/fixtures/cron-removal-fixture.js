import { createCronRemovalRequest } from '../../src/website-cron-removal-request.js';
export const siteId = '11111111-1111-4111-8111-111111111111';
export const serverId = '22222222-2222-4222-8222-222222222222';
export const appId = '33333333-3333-4333-8333-333333333333';
export const taskId = '44444444-4444-4444-8444-444444444444';
export const otherId = '55555555-5555-4555-8555-555555555555';
export const jobId = '66666666-6666-4666-8666-666666666666';
export const task = (patch = {}) => ({ id: taskId, websiteId: siteId, serverId,
  applicationId: appId, unixUser: 'yunapp-123456789abc', revision: 3,
  schedule: '*/5 * * * *', command: '/bin/true', enabled: true, ...patch });
export const website = () => ({ id: siteId, serverId, applicationId: appId,
  unixUser: task().unixUser, runtimeType: 'node', desiredRevision: 1 });
export function jobFor(value = task(), { status = 'queued', id = jobId, absent = false } = {}) {
  const { identity, request } = createCronRemovalRequest(value);
  return { id, serverId, type: request.type, operation: request.operation,
    resourceType: request.resourceType, resourceId: value.id, status,
    result: status === 'succeeded' ? { version: 1, taskId: value.id, websiteId: siteId,
      applicationId: appId, unixUser: value.unixUser, revision: value.revision,
      desiredStateSha256: identity.desiredStateSha256, contentSha256: absent ? null : identity.desiredStateSha256,
      removed: true, sideEffects: !absent } : null };
}
export function preview(values = [task()]) {
  return { operation: 'website_remove', readyToStart: true,
    website: { ...website(), systemUser: task().unixUser },
    previewDigest: 'a'.repeat(64), confirmation: 'fixture-confirmation',
    plan: { domainIds: [], applicationId: appId, systemUser: task().unixUser,
      additional: { crons: { status: 'available', ids: values.map((item) => item.id) } } } };
}
