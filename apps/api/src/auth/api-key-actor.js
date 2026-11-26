import { createHash } from 'node:crypto';

// Host jobs, provisioning and removal re-authorize their actor when they run. A panel
// actor is a live session; an automation actor is a live API key acting for the Owner
// who created it, and only on a tenant site recorded inside that key's scope.
function keySessionId(keyId) {
  const hex = createHash('sha256').update(`yunpanel:api-key-actor:v1:${keyId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function apiKeyActor(key) {
  return Object.freeze({ sessionId: keySessionId(key.id), userId: key.createdBy, role: 'owner' });
}

export function createApiKeyActorAuthorizer({ apiKeyStore, tenantSiteStore, getAutomationUser, ownerMfaRequired = true, mfaEnabled = () => false }) {
  return async function authorizeApiKeyActor(actor, websiteId) {
    if (!actor || actor.role !== 'owner' || typeof actor.sessionId !== 'string' || typeof actor.userId !== 'string' || typeof websiteId !== 'string') return null;
    const key = (await apiKeyStore.list()).find((candidate) => !candidate.revokedAt && keySessionId(candidate.id) === actor.sessionId);
    if (!key || key.createdBy !== actor.userId) return null;
    const owner = getAutomationUser(actor.userId);
    if (owner?.role !== 'owner' || (ownerMfaRequired && !mfaEnabled(actor.userId))) return null;
    const sites = await tenantSiteStore.list(key.scope.parentDomain);
    if (!sites.some((site) => site.websiteId === websiteId)) return null;
    return apiKeyActor(key);
  };
}
