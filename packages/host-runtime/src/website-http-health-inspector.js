import http from 'node:http';
import { normalizeDomainSet } from '@yunpanel/shared';

const HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

export class WebsiteHttpHealthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteHttpHealthError';
    this.code = code;
  }
}

function normalizeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteHttpHealthError('website_health_spec_invalid', 'Website health specification is invalid');
  }
  let primaryDomain;
  try { primaryDomain = normalizeDomainSet(value.primaryDomain, []).primary; }
  catch { throw new WebsiteHttpHealthError('website_health_domain_invalid', 'Website health hostname is invalid'); }
  const healthPath = value.healthPath ?? '/health';
  if (typeof healthPath !== 'string' || healthPath.length > 200
    || !HEALTH_PATH_PATTERN.test(healthPath) || healthPath.includes('//')) {
    throw new WebsiteHttpHealthError('website_health_path_invalid', 'Website health path is invalid');
  }
  const timeoutSeconds = value.timeoutSeconds ?? 30;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 120) {
    throw new WebsiteHttpHealthError('website_health_timeout_invalid', 'Website health timeout must be between 5 and 120 seconds');
  }
  return Object.freeze({ primaryDomain, healthPath, timeoutSeconds });
}

function defaultRequest({ primaryDomain, healthPath, timeoutMs }) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port: 80,
      path: healthPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        host: primaryDomain,
        connection: 'close',
        'user-agent': 'YunPanel-Health/1',
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      resolve(Object.freeze({
        reachable: true,
        healthy: statusCode >= 200 && statusCode < 300,
        statusCode,
      }));
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(Object.freeze({ reachable: false, healthy: false, statusCode: null }));
    });
    request.on('error', () => resolve(Object.freeze({ reachable: false, healthy: false, statusCode: null })));
    request.end();
  });
}

export function createWebsiteHttpHealthInspector({
  request = defaultRequest,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  retryDelayMs = 500,
  requestTimeoutMs = 2_000,
} = {}) {
  if (typeof request !== 'function' || typeof now !== 'function' || typeof sleep !== 'function'
    || !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 10_000) {
    throw new WebsiteHttpHealthError('website_health_dependencies_invalid', 'Website health inspector dependencies are invalid');
  }

  async function inspect(rawSpec) {
    const spec = normalizeSpec(rawSpec);
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new WebsiteHttpHealthError('website_health_clock_invalid', 'Website health inspector clock is invalid');
    }
    const deadline = startedAt + spec.timeoutSeconds * 1_000;
    let attempts = 0;
    let lastStatusCode = null;
    let lastReachable = false;

    while (true) {
      attempts += 1;
      const remaining = Math.max(100, deadline - now());
      const result = await request({
        primaryDomain: spec.primaryDomain,
        healthPath: spec.healthPath,
        timeoutMs: Math.min(requestTimeoutMs, remaining),
      });
      lastReachable = result?.reachable === true;
      lastStatusCode = Number.isInteger(result?.statusCode) ? result.statusCode : null;
      if (result?.healthy === true && lastStatusCode >= 200 && lastStatusCode < 300) {
        return Object.freeze({
          satisfied: true,
          adapter: 'nginx-http-health',
          primaryDomain: spec.primaryDomain,
          healthPath: spec.healthPath,
          statusCode: lastStatusCode,
          attempts,
          route: '127.0.0.1:80',
        });
      }
      if (now() >= deadline) break;
      await sleep(Math.min(retryDelayMs, Math.max(0, deadline - now())));
    }

    return Object.freeze({
      satisfied: false,
      reason: lastReachable ? 'website_health_status_unhealthy' : 'website_health_unreachable',
      adapter: 'nginx-http-health',
      primaryDomain: spec.primaryDomain,
      healthPath: spec.healthPath,
      statusCode: lastStatusCode,
      attempts,
      route: '127.0.0.1:80',
    });
  }

  return Object.freeze({ inspect });
}

export const websiteHttpHealthInternals = Object.freeze({
  normalizeSpec,
  defaultRequest,
  healthPathPattern: HEALTH_PATH_PATTERN,
});
