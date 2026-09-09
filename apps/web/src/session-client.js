let csrfToken = null;

export function setSession(session) {
  csrfToken = session?.csrfToken ?? null;
}

export function sessionHeaders(method = 'GET') {
  return !['GET', 'HEAD'].includes(method.toUpperCase()) && csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

export async function requestJson(url, { method = 'GET', body, signal, notifyExpired = true } = {}) {
  if (!url.startsWith('/api/')) throw new Error('Only same-origin API paths are supported');
  const response = await fetch(url, {
    method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { ...sessionHeaders(method), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && payload?.error?.code === 'unauthorized') {
      if (notifyExpired) {
        setSession(null);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('yunpanel:session-expired'));
      }
    }
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    error.code = payload?.error?.code ?? `http_${response.status}`;
    error.status = response.status;
    error.setupRequired = payload?.setupRequired === true;
    throw error;
  }
  return payload?.data;
}

export function authRequest(operation, options = {}) {
  return requestJson(`/api/auth/${operation}`, options);
}
