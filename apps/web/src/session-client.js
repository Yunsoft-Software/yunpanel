let csrfToken = null;
let generation = 0;
let sessionChangePending = false;

export function setSession(session) {
  const next = session?.csrfToken ?? null;
  if (next !== csrfToken) generation += 1;
  csrfToken = next;
}

export const sessionGeneration = () => generation;
export const isSessionChangePending = () => sessionChangePending;

export function sessionHeaders(method = 'GET') {
  return !['GET', 'HEAD'].includes(method.toUpperCase()) && csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

function staleSessionError() {
  const error = new Error('The session changed while this request was running.');
  error.code = 'session_superseded';
  error.status = 409;
  return error;
}

export async function requestJson(url, { method = 'GET', body, signal, notifyExpired = true, changesSession = false } = {}) {
  if (!url.startsWith('/api/')) throw new Error('Only same-origin API paths are supported');
  if (changesSession && sessionChangePending) throw staleSessionError();
  if (changesSession) { sessionChangePending = true; generation += 1; }
  const requestedGeneration = generation;
  try {
    const response = await fetch(url, {
      method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { ...sessionHeaders(method), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (requestedGeneration !== generation || (!changesSession && sessionChangePending)) throw staleSessionError();
    if (!response.ok) {
      if (response.status === 401 && payload?.error?.code === 'unauthorized' && notifyExpired) {
        setSession(null);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('yunpanel:session-expired'));
      }
      const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
      error.code = payload?.error?.code ?? `http_${response.status}`;
      error.status = response.status;
      error.setupRequired = payload?.setupRequired === true;
      throw error;
    }
    const data = payload?.data;
    if (changesSession) setSession(data?.session ?? (data?.user ? data : null));
    return data;
  } finally {
    if (changesSession) sessionChangePending = false;
  }
}

export function authRequest(operation, options = {}) {
  return requestJson(`/api/auth/${operation}`, options);
}
