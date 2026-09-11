import { handleAuditRead } from './audit-http.js';
import { isIP } from 'node:net';
import { withAuditActor } from './audit-request-context.js';
import { AuthError, safeEqual } from './auth-error.js';
import { attachManagementAudit } from './management-audit.js';
import { createOwnerMfaPolicy } from './owner-mfa-policy.js';
import { requireReadOnlyRequest } from './panel-access.js';
import { handleUserAdmin } from './user-admin-http.js';
import { isGithubWebhookPath } from './github-webhook-http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const PROXY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TRUSTED_PROXY_DEFAULT = '127.0.0.1,::1';
const AGENT_ROUTES = [
  ['POST', /^\/api\/servers\/[^/%]+\/heartbeat$/],
  ['GET', /^\/api\/servers\/[^/%]+\/commands\/next$/],
  ['GET', /^\/api\/servers\/[^/%]+\/applications\/[^/%]+\/environment$/],
  ['GET', /^\/api\/servers\/[^/%]+\/applications\/[^/%]+\/deployment-credential$/],
  ['POST', /^\/api\/servers\/[^/%]+\/commands\/[^/%]+\/result$/],
];

export function isAgentRoute(method, pathname) {
  return AGENT_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(pathname));
}

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const candidate = trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version === 6) return new URL(`http://[${candidate}]`).hostname.slice(1, -1);
  return null;
}

function parseTrustedProxies(value) {
  const entries = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const normalized = entries.map(normalizeIp);
  if (entries.length === 0 || normalized.some((entry) => entry === null)) throw new Error('YUNPANEL_TRUSTED_PROXY_IPS must contain only IP addresses');
  return new Set(normalized);
}

function requestPeer(request, { proxyToken, trustedProxies }) {
  const peer = normalizeIp(request.socket.remoteAddress);
  if (!peer) throw new AuthError('client_address_invalid', 'Client address could not be verified.', 400);
  const clientHeader = request.headers['x-yunpanel-client-ip'];
  const tokenHeader = request.headers['x-yunpanel-proxy-token'];
  const standardForwarding = ['forwarded', 'x-forwarded-for', 'x-real-ip'].some((name) => request.headers[name] !== undefined);
  const hasInternalHeaders = clientHeader !== undefined || tokenHeader !== undefined;
  if (standardForwarding || (hasInternalHeaders && (!trustedProxies.has(peer)
    || typeof proxyToken !== 'string' || !safeEqual(tokenHeader, proxyToken)))) {
    throw new AuthError('proxy_headers_forbidden', 'Proxy headers could not be verified.', 400);
  }
  if (!hasInternalHeaders) return peer;
  const clientIp = typeof clientHeader === 'string' && !clientHeader.includes(',') ? normalizeIp(clientHeader) : null;
  if (!clientIp || typeof tokenHeader !== 'string') throw new AuthError('client_address_invalid', 'Client address could not be verified.', 400);
  return clientIp;
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(status === 204 ? undefined : JSON.stringify(payload));
}

function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError('json_required', 'Send an application/json request.', 415);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        if (!rejected) reject(new AuthError('body_too_large', 'Request body is too large.', 413));
        rejected = true;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        resolve(body);
      } catch { reject(new AuthError('invalid_json', 'Enter a valid JSON object.')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new AuthError('request_aborted', 'Request was interrupted.')));
  });
}

/** Authentication is checked BEFORE the application's handler, on every deployed API request. */
export function createAuthenticatedApi({
  createHandler,
  store,
  publicOrigin,
  development = false,
  proxyToken,
  trustedProxyIps = TRUSTED_PROXY_DEFAULT,
  publicWebhookHandler = null,
}) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error('YUNPANEL_PUBLIC_ORIGIN is required'); }
  const localDevelopment = development && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !localDevelopment)) {
    throw new Error('Panel origin must be an exact HTTPS origin (HTTP is only allowed for loopback development)');
  }
  const ownerPolicy = createOwnerMfaPolicy({ store, required: !localDevelopment });
  const trustedProxies = parseTrustedProxies(trustedProxyIps);
  if (proxyToken !== undefined && (typeof proxyToken !== 'string' || !PROXY_TOKEN_PATTERN.test(proxyToken))) {
    throw new Error('YUNPANEL_INTERNAL_PROXY_TOKEN is invalid');
  }
  const cookieName = localDevelopment ? 'yunpanel_session' : '__Host-yunpanel_session';
  const mfaCookieName = localDevelopment ? 'yunpanel_mfa' : '__Host-yunpanel_mfa';
  const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${localDevelopment ? '' : '; Secure'}`;
  const handler = createHandler();
  if (publicWebhookHandler !== null && typeof publicWebhookHandler !== 'function') {
    throw new TypeError('Public webhook handler must be a function');
  }

  const readCookie = (request, name) => {
    const entries = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
    if (entries.length > 1) throw new AuthError('invalid_cookie', 'Ambiguous authentication cookie.');
    return entries[0]?.slice(name.length + 1) ?? null;
  };
  const checkOrigin = (request) => {
    if (request.headers.origin !== publicOrigin || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
      throw new AuthError('origin_forbidden', 'Cross-origin requests are not allowed.', 403);
    }
  };
  const writeCookie = (response, name, value, maxAge) => {
    const existing = response.getHeader('set-cookie') ?? [];
    const lifetime = value ? (maxAge === undefined ? '' : `; Max-Age=${maxAge}`) : '; Max-Age=0';
    response.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : [existing]), `${name}=${value}; ${cookieOptions}${lifetime}`]);
  };
  const setCookie = (response, value) => writeCookie(response, cookieName, value);
  const setMfaCookie = (response, value) => writeCookie(response, mfaCookieName, value, 300);

  async function handle(request, response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new AuthError('invalid_path', 'Invalid request path.');
    const url = new URL(request.url, 'http://api.local');
    let pathname = url.pathname;
    const githubWebhookPath = isGithubWebhookPath(pathname);
    if (pathname.startsWith('/api/panel/')) {
      pathname = `/api/${pathname.slice('/api/panel/'.length)}`;
      request.url = pathname + url.search;
    }
    if (pathname === '/api/health' && SAFE_METHODS.has(request.method)) return json(response, 200, { status: 'ok' });
    if (!pathname.startsWith('/api/')) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    if (pathname.startsWith('/api/dev/') && !development) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });

    if (githubWebhookPath) {
      requestPeer(request, { proxyToken, trustedProxies });
      if (!publicWebhookHandler) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      await publicWebhookHandler(request, response, pathname);
      return;
    }

    if (isAgentRoute(request.method, pathname)) {
      if (request.headers.origin || request.headers.cookie) throw new AuthError('agent_channel_only', 'This route is not a browser management endpoint.', 403);
      return handler(request, response);
    }
    const rawToken = readCookie(request, cookieName);
    const challengeToken = readCookie(request, mfaCookieName);
    const peer = requestPeer(request, { proxyToken, trustedProxies });
    if (pathname === '/api/auth/login' || pathname === '/api/auth/setup') {
      if (request.method !== 'POST') throw new AuthError('method_not_allowed', 'Use POST.', 405);
      checkOrigin(request);
      const body = await readJson(request);
      if (pathname === '/api/auth/setup') {
        const user = await store.completeSetup({ setupToken: body.setupToken, username: body.username, password: body.password, peer });
        return json(response, 201, { data: user });
      }
      const result = await store.login({ username: body.username, password: body.password, peer, previousToken: rawToken });
      if (challengeToken) store.mfa.cancelLogin(challengeToken);
      if (result.mfaRequired) {
        setCookie(response, '');
        setMfaCookie(response, result.challengeToken);
        return json(response, 202, { data: { mfaRequired: true, expiresAt: result.expiresAt } });
      }
      setCookie(response, result.token);
      setMfaCookie(response, '');
      return json(response, 200, { data: ownerPolicy.describe(result.session) });
    }
    if (pathname === '/api/auth/mfa/verify' || pathname === '/api/auth/mfa/cancel') {
      if (request.method !== 'POST') throw new AuthError('method_not_allowed', 'Use POST.', 405);
      checkOrigin(request);
      if (pathname.endsWith('/cancel')) {
        store.mfa.cancelLogin(challengeToken);
        setMfaCookie(response, '');
        return json(response, 204);
      }
      const body = await readJson(request);
      const result = store.mfa.completeLogin(challengeToken, { code: body.code, method: body.method }, peer);
      setCookie(response, result.token);
      setMfaCookie(response, '');
      return json(response, 200, { data: ownerPolicy.describe(result.session) });
    }

    const session = store.getSession(rawToken);
    if (!session) {
      return json(response, 401, { error: { code: 'unauthorized', message: 'Sign in to continue.' }, setupRequired: pathname === '/api/auth/session' ? !store.configured() : undefined });
    }
    if (!SAFE_METHODS.has(request.method)) {
      checkOrigin(request);
      if (!safeEqual(request.headers['x-csrf-token'], session.csrfToken)) throw new AuthError('csrf_invalid', 'Session verification failed. Reload the page.', 403);
    }
    if (pathname.startsWith('/api/auth/')) {
      if (pathname === '/api/auth/session' && request.method === 'GET') return json(response, 200, { data: ownerPolicy.describe(session) });
      if (pathname === '/api/auth/security' && request.method === 'GET') return json(response, 200, { data: ownerPolicy.describe(session).security });
      if (pathname === '/api/auth/sessions' && request.method === 'GET') return json(response, 200, { data: store.listSessions(rawToken) });
      if (pathname === '/api/auth/keep-alive' && request.method === 'POST') return json(response, 200, { data: ownerPolicy.describe(store.getSession(rawToken, { touch: true })) });
      if (pathname === '/api/auth/mfa' && request.method === 'GET') return json(response, 200, { data: store.mfa.status(rawToken) });
      if (pathname === '/api/auth/mfa/enroll' && request.method === 'POST') {
        const body = await readJson(request);
        return json(response, 200, { data: await store.mfa.beginEnrollment(rawToken, body.password) });
      }
      if (pathname === '/api/auth/mfa/enroll/cancel' && request.method === 'POST') {
        store.mfa.cancelEnrollment(rawToken);
        setMfaCookie(response, '');
        return json(response, 204);
      }
      if (['/api/auth/mfa/confirm', '/api/auth/mfa/recovery'].includes(pathname) && request.method === 'POST') {
        const body = await readJson(request);
        const result = pathname.endsWith('/confirm') ? store.mfa.confirmEnrollment(rawToken, body.code)
          : await store.mfa.regenerateRecovery(rawToken, body.password, { code: body.code, method: body.method });
        setCookie(response, result.token);
        setMfaCookie(response, '');
        return json(response, 200, { data: { session: ownerPolicy.describe(result.session), recoveryCodes: result.recoveryCodes } });
      }
      if (pathname === '/api/auth/mfa/disable' && request.method === 'POST') {
        const body = await readJson(request);
        await store.mfa.disable(rawToken, body.password, { code: body.code, method: body.method });
        setCookie(response, '');
        setMfaCookie(response, '');
        return json(response, 204);
      }
      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        store.revokeSession(rawToken);
        if (challengeToken) store.mfa.cancelLogin(challengeToken);
        setCookie(response, '');
        setMfaCookie(response, '');
        return json(response, 204);
      }
      if (pathname === '/api/auth/logout-all' && request.method === 'POST') {
        store.revokeAll(rawToken);
        setCookie(response, '');
        setMfaCookie(response, '');
        return json(response, 204);
      }
      if (pathname === '/api/auth/password' && request.method === 'POST') {
        const body = await readJson(request);
        await store.changePassword(rawToken, body.currentPassword, body.newPassword);
        setCookie(response, '');
        setMfaCookie(response, '');
        return json(response, 204);
      }
      const sessionMatch = /^\/api\/auth\/sessions\/([a-f0-9-]{36})$/.exec(pathname);
      if (sessionMatch && request.method === 'DELETE') {
        store.revokeSession(rawToken, sessionMatch[1]);
        if (sessionMatch[1] === session.id) setCookie(response, '');
        return json(response, 204);
      }
      return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    }
    const authorized = session.user.role === 'read_only'
      ? requireReadOnlyRequest(ownerPolicy.describe(session), request.method, pathname)
      : ownerPolicy.requireManagement(session);
    if (!SAFE_METHODS.has(request.method)) store.getSession(rawToken, { touch: true });
    request.auth = authorized;
    return withAuditActor(authorized.user.id, () => {
      attachManagementAudit({ request, response, pathname, audit: store.audit });
      if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
        return handleUserAdmin({ request, response, pathname, query: url.searchParams, store, rawToken, requireManagement: ownerPolicy.requireManagement, readJson, json });
      }
      if (pathname === '/api/audit') return handleAuditRead({ request, response, query: url.searchParams, store, json });
      return handler(request, response);
    });
  }

  return (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      if (error instanceof AuthError) {
        if (error.retryAfter) response.setHeader('retry-after', String(error.retryAfter));
        json(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        json(response, 503, { error: { code: 'auth_unavailable', message: 'Authentication is temporarily unavailable.' } });
      }
    });
  };
}

export const authHttpInternals = Object.freeze({ normalizeIp, parseTrustedProxies, requestPeer });
