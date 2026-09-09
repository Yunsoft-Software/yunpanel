import { randomBytes } from 'node:crypto';
import { AuthError, safeEqual } from './auth-error.js';
import { createOwnerMfaPolicy } from './owner-mfa-policy.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const AGENT_ROUTES = [
  ['POST', /^\/api\/servers\/enroll$/],
  ['POST', /^\/api\/servers\/[^/%]+\/heartbeat$/],
  ['GET', /^\/api\/servers\/[^/%]+\/commands\/next$/],
  ['GET', /^\/api\/servers\/[^/%]+\/applications\/[^/%]+\/environment$/],
  ['POST', /^\/api\/servers\/[^/%]+\/commands\/[^/%]+\/result$/],
];

export function isAgentRoute(method, pathname) {
  return AGENT_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(pathname));
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

/** Authentication is checked BEFORE the legacy application's handler, on every deployed API request. */
export function createAuthenticatedApi({ createHandler, store, publicOrigin, development = false }) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error('YUNPANEL_PUBLIC_ORIGIN is required'); }
  const localDevelopment = development && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !localDevelopment)) {
    throw new Error('Panel origin must be an exact HTTPS origin (HTTP is only allowed for loopback development)');
  }
  // Only explicit loopback HTTP development is exempt. HTTPS always enforces MFA.
  const ownerPolicy = createOwnerMfaPolicy({ store, required: !localDevelopment });
  const cookieName = localDevelopment ? 'yunpanel_session' : '__Host-yunpanel_session';
  const mfaCookieName = localDevelopment ? 'yunpanel_mfa' : '__Host-yunpanel_mfa';
  const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${localDevelopment ? '' : '; Secure'}`;
  // Transitional adapter only: fresh per process, never configured, returned, or sent across a socket.
  // This preserves existing domain/deploy handlers while removing the public bootstrap-token boundary.
  const internalToken = randomBytes(32).toString('base64url');
  const handler = createHandler({ adminToken: internalToken });

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
    if (pathname.startsWith('/api/panel/')) {
      pathname = `/api/${pathname.slice('/api/panel/'.length)}`;
      request.url = pathname + url.search;
    }
    if (pathname === '/api/health' && SAFE_METHODS.has(request.method)) return json(response, 200, { status: 'ok' });
    if (!pathname.startsWith('/api/')) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    if (pathname.startsWith('/api/dev/') && !development) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });

    // These exact legacy transport routes still use their own enrollment/agent credentials.
    // Browser traffic cannot enter them; remove them alongside the agentless migration.
    if (isAgentRoute(request.method, pathname)) {
      if (request.headers.origin || request.headers.cookie) throw new AuthError('agent_channel_only', 'This route is not a browser management endpoint.', 403);
      return handler(request, response);
    }
    const rawToken = readCookie(request, cookieName);
    const challengeToken = readCookie(request, mfaCookieName);
    const peer = request.socket.remoteAddress ?? 'unknown'; // Never trust caller-supplied forwarding headers.
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
      // A stale request may arrive after another request rotated the cookie.
      // Do not erase the newer browser cookie; explicit logout still clears it.
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
    // Do not give a broad "read" role access to secrets or undeclared legacy read endpoints.
    const authorized = ownerPolicy.requireManagement(store.getSession(rawToken));
    if (!SAFE_METHODS.has(request.method)) store.getSession(rawToken, { touch: true });
    request.auth = authorized;
    request.headers.authorization = `Bearer ${internalToken}`;
    return handler(request, response);
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
