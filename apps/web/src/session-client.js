let csrfToken = null;
let version = 0;

export function setSession(session) {
  const next = session?.csrfToken ?? null;
  if (next !== csrfToken) version += 1;
  csrfToken = next;
}

export function sessionVersion() { return version; }
export function sessionHeaders(method = 'GET') {
  return !['GET', 'HEAD'].includes(method.toUpperCase()) && csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

export async function requestJson(url, { method = 'GET', body, signal, notifyExpired = true } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/api/') || /[\\\r\n]/.test(url)) throw new Error('Only same-origin API paths are supported');
  const started = version;
  const checkCurrent = () => {
    if (signal?.aborted || started !== version) throw new DOMException('The request belongs to an obsolete session.', 'AbortError');
  };
  checkCurrent();
  let response;
  try {
    response = await fetch(url, {
      method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { ...sessionHeaders(method), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) { checkCurrent(); throw error; }
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  // A response started before login, logout or MFA rotation cannot mutate the new session.
  checkCurrent();
  if (!response.ok) {
    if (response.status === 401 && payload?.error?.code === 'unauthorized' && notifyExpired) {
      setSession(null);
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('yunpanel:session-expired'));
    }
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    error.code = payload?.error?.code ?? `http_${response.status}`;
    error.status = response.status;
    error.setupRequired = payload?.setupRequired === true;
    const retryAfter = Number(response.headers.get('retry-after'));
    error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    throw error;
  }
  return payload?.data;
}

export function authRequest(operation, options = {}) {
  return requestJson(`/api/auth/${operation}`, options);
}
