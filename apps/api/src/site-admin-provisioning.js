// Completes the existing site's account step; never reassigns or retries users.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const CODES = Object.freeze({
  username_taken: 'site_admin_conflict',
  invalid_username: 'site_admin_input_invalid',
  invalid_password: 'site_admin_input_invalid',
  invalid_website_ids: 'site_admin_result_unverified',
  auth_busy: 'site_admin_busy',
});

export async function provisionSiteAdmin({ input, result, userAdminStore, actorId } = {}) {
  const websiteId = typeof result?.website?.id === 'string' && UUID.test(result.website.id) ? result.website.id : null;
  const outcome = (status, code = null) => Object.freeze({ status, websiteId, code });
  if (input?.siteAdmin == null) return outcome('not_requested');
  if (!websiteId || result?.operationId !== input?.operationId
    || result.website.serverId !== input?.serverId
    || result.primaryDomain?.websiteId !== websiteId) return outcome('attention', 'site_admin_result_unverified');
  // An existing/resumed site may already have its account. Do not guess by email,
  // reset a password or attach an existing principal without durable ownership.
  if (result.created !== true || result.resumed === true) return outcome('attention', 'site_admin_replay_requires_review');
  if (!record(input.siteAdmin) || typeof input.siteAdmin.email !== 'string'
    || typeof input.siteAdmin.password !== 'string' || !input.siteAdmin.password) return outcome('attention', 'site_admin_input_invalid');
  const username = input.siteAdmin.email.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@+-]{2,127}$/.test(username)) return outcome('attention', 'site_admin_input_invalid');
  if (typeof actorId !== 'string' || !actorId || actorId.length > 128) return outcome('attention', 'site_admin_actor_unavailable');
  if (typeof userAdminStore?.createSiteManager !== 'function') return outcome('attention', 'site_admin_unavailable');
  try {
    const user = await userAdminStore.createSiteManager({ username, password: input.siteAdmin.password, websiteId, actorId });
    if (!record(user) || typeof user.id !== 'string' || !UUID.test(user.id)
      || user.username !== username || user.role !== 'site_manager' || user.active !== true
      || !Array.isArray(user.websiteIds) || user.websiteIds.length !== 1 || user.websiteIds[0] !== websiteId) {
      return outcome('attention', 'site_admin_result_unverified');
    }
    return outcome('created');
  } catch (error) {
    // A rejected promise is handled here. Unknown failures may follow a commit;
    // expose no raw error, password, hash or guessed safe-to-retry claim.
    return outcome('attention', Object.hasOwn(CODES, error?.code) ? CODES[error.code] : 'site_admin_result_unverified');
  }
}
