import { AuthError } from './auth-error.js';

const ROOT = '/api/users/hosting/accounts';
const ID = '[A-Za-z0-9_-]{1,128}';
const ITEM = new RegExp(`^${ROOT}/(${ID})(?:/(limits|profile|status))?$`);
const unavailable = () => new AuthError('hosting_accounts_unavailable', 'Hosting account administration is unavailable.', 503);
const invalidQuery = () => new AuthError('invalid_hosting_account_query', 'Use documented, single-valued account filters.');

export function isHostingAccountPath(pathname) {
  return typeof pathname === 'string' && (pathname === ROOT || pathname.startsWith(`${ROOT}/`));
}

/** Query strings never choose the actor or confer reseller privileges. An explicit
 * direct=true filter avoids reserving a valid account ID such as "null" or "none".
 */
export function hostingAccountQuery(query) {
  if (!(query instanceof URLSearchParams)) throw invalidQuery();
  const input = {};
  for (const key of query.keys()) {
    if (!['kind', 'resellerId', 'direct', 'limit', 'offset'].includes(key) || query.getAll(key).length !== 1) throw invalidQuery();
    const value = query.get(key);
    if (key === 'limit' || key === 'offset') {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw invalidQuery();
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < (key === 'limit' ? 1 : 0) || (key === 'limit' && number > 100)) throw invalidQuery();
      input[key] = number;
    } else if (key === 'kind') {
      if (!['reseller', 'customer'].includes(value)) throw invalidQuery();
      input.kind = value;
    } else if (key === 'resellerId') {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw invalidQuery();
      input.resellerId = value;
    } else if (value !== 'true') throw invalidQuery();
  }
  if (query.has('direct')) {
    if (query.has('resellerId')) throw invalidQuery();
    input.resellerId = null;
  }
  if (Object.hasOwn(input, 'resellerId') && input.kind !== 'customer') throw invalidQuery();
  return input;
}

function requireHostingActor(accounts, rawToken, requireManagement) {
  if (typeof accounts?.authorizeActor !== 'function' || typeof requireManagement !== 'function') throw unavailable();
  return accounts.authorizeActor(rawToken, requireManagement);
}
function requireOwnerActor(actor) {
  if (actor?.role !== 'owner') throw new AuthError('reseller_scope_forbidden', 'This account operation is not permitted.', 403);
}

/** Called by auth-http AFTER cookie/Origin/CSRF and the session role boundary.
 * The persisted store derives Owner/reseller authority from current auth/profile
 * state inside every transaction. Resellers get scoped reads and direct-customer
 * login lifecycle only; registration, limits and unlinking remain Owner-only.
 */
export async function handleHostingAccountAdmin({ request, response, pathname, query, store, rawToken, requireManagement, readJson, json }) {
  const accounts = store.users?.hostingAccounts;
  const actor = requireHostingActor(accounts, rawToken, requireManagement);
  const collection = pathname === ROOT;
  const match = ITEM.exec(pathname);
  if (!collection && !match) throw new AuthError('not_found', 'Hosting account route not found.', 404);
  const call = (method, ...args) => {
    if (typeof accounts?.[method] !== 'function') throw unavailable();
    return accounts[method](rawToken, requireManagement, ...args);
  };
  if (collection && request.method === 'GET') {
    return json(response, 200, { data: call('list', hostingAccountQuery(query)) });
  }
  // Non-list routes accept no query modifiers, even for reads.
  if ([...query.keys()].length) throw invalidQuery();
  if (collection && request.method === 'POST') {
    requireOwnerActor(actor);
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['reseller', 'customer'].includes(body.kind)) {
      throw new AuthError('invalid_hosting_kind', 'Choose reseller or customer.');
    }
    const { kind, ...input } = body;
    const account = call(kind === 'reseller' ? 'registerReseller' : 'registerCustomer', input);
    return json(response, 201, { data: { account, accessGranted: false } });
  }
  if (match && !match[2] && request.method === 'GET') {
    return json(response, 200, { data: call('get', match[1]) });
  }
  if (match?.[2] === 'limits' && request.method === 'PATCH') {
    requireOwnerActor(actor);
    const body = await readJson(request);
    return json(response, 200, { data: { account: call('updateLimits', match[1], body), accessGranted: false } });
  }
  if (match?.[2] === 'status' && request.method === 'PATCH') {
    const body = await readJson(request);
    const account = call('setActive', match[1], body);
    return json(response, 200, {
      data: {
        account,
        accessGranted: false,
        hostSitesSuspended: false,
      },
    });
  }
  if (match?.[2] === 'profile' && request.method === 'DELETE') {
    requireOwnerActor(actor);
    const body = await readJson(request);
    if (!body || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'revision') || !Object.hasOwn(body, 'confirmation')
      || !Number.isSafeInteger(body.revision) || body.revision < 1
      || body.confirmation !== `unregister-hosting-profile:${match[1]}:${body.revision}`) {
      throw new AuthError('hosting_profile_confirmation_required', 'Confirm removal of this profile using its current revision.');
    }
    const result = call('unregister', match[1], { revision: body.revision });
    return json(response, 200, { data: { ...result, loginDeleted: false, accessGranted: false } });
  }
  response.setHeader('allow', collection ? 'GET, POST' : ['limits', 'status'].includes(match[2]) ? 'PATCH' : match[2] === 'profile' ? 'DELETE' : 'GET');
  throw new AuthError('method_not_allowed', 'Unsupported hosting account operation.', 405);
}
