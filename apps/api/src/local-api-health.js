import http from 'node:http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3001;
const MAX_BODY_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 2000;

export class LocalApiHealthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalApiHealthError';
    this.code = code;
  }
}

function normalizeHost(value) {
  const host = value == null || value === '' ? DEFAULT_HOST : value;
  if (typeof host !== 'string' || !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new LocalApiHealthError('local_api_health_host_unsafe', 'Local API health validation requires a loopback API host');
  }
  return host.toLowerCase();
}

function normalizePort(value) {
  const port = value == null || value === '' ? DEFAULT_PORT : Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== String(value ?? DEFAULT_PORT).trim()) {
    throw new LocalApiHealthError('local_api_health_port_invalid', 'Local API health validation requires a valid API port');
  }
  return port;
}

function normalizeTimeout(value) {
  if (!Number.isInteger(value) || value < 100 || value > 10_000) {
    throw new LocalApiHealthError('local_api_health_timeout_invalid', 'Local API health timeout is invalid');
  }
  return value;
}

export function resolveLocalApiHealthTarget({ env = process.env } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new LocalApiHealthError('local_api_health_environment_invalid', 'Local API health environment is invalid');
  }
  return Object.freeze({
    host: normalizeHost(env.YUNPANEL_API_HOST),
    port: normalizePort(env.YUNPANEL_API_PORT),
  });
}

export async function checkLocalApiHealth({
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  request = http.request,
} = {}) {
  if (typeof request !== 'function') {
    throw new LocalApiHealthError('local_api_health_dependencies_invalid', 'Local API health probe dependencies are invalid');
  }
  const { host, port } = resolveLocalApiHealthTarget({ env });
  const timeout = normalizeTimeout(timeoutMs);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      reject(new LocalApiHealthError(code, message));
    };
    let probe;
    try {
      probe = request({
        host,
        port,
        path: '/api/health',
        method: 'GET',
        timeout,
        headers: {
          accept: 'application/json',
          connection: 'close',
        },
      }, (response) => {
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            response.destroy();
            fail('local_api_health_response_invalid', 'Local API health response is invalid');
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => fail('local_api_health_unavailable', 'Local API health endpoint is unavailable'));
        response.on('end', () => {
          if (settled) return;
          if (response.statusCode !== 200) {
            fail('local_api_health_unhealthy', 'Local API health endpoint did not report success');
            return;
          }
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            fail('local_api_health_response_invalid', 'Local API health response is invalid');
            return;
          }
          if (!body || typeof body !== 'object' || Array.isArray(body) || body.status !== 'ok') {
            fail('local_api_health_unhealthy', 'Local API health endpoint did not report success');
            return;
          }
          settled = true;
          resolve(Object.freeze({ healthy: true, host, port, statusCode: 200 }));
        });
      });
    } catch {
      fail('local_api_health_unavailable', 'Local API health endpoint is unavailable');
      return;
    }
    probe.on('timeout', () => {
      probe.destroy();
      fail('local_api_health_timeout', 'Local API health endpoint timed out');
    });
    probe.on('error', () => fail('local_api_health_unavailable', 'Local API health endpoint is unavailable'));
    probe.end();
  });
}

export const localApiHealthInternals = Object.freeze({
  loopbackHosts: Object.freeze([...LOOPBACK_HOSTS]),
  defaultHost: DEFAULT_HOST,
  defaultPort: DEFAULT_PORT,
  maxBodyBytes: MAX_BODY_BYTES,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  normalizeHost,
  normalizePort,
  normalizeTimeout,
});
