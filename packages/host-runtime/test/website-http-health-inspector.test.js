import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteHttpHealthInspector,
  WebsiteHttpHealthError,
} from '../src/website-http-health-inspector.js';

test('Website health probes Nginx loopback with canonical Host routing until 2xx', async () => {
  let clock = 1_000;
  const calls = [];
  const responses = [
    { reachable: true, healthy: false, statusCode: 503 },
    { reachable: true, healthy: true, statusCode: 204 },
  ];
  const inspector = createWebsiteHttpHealthInspector({
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    retryDelayMs: 250,
    request: async (input) => {
      calls.push(input);
      return responses.shift();
    },
  });

  const result = await inspector.inspect({
    primaryDomain: 'Example.COM.',
    healthPath: '/healthz',
    timeoutSeconds: 5,
  });
  assert.deepEqual(result, {
    satisfied: true,
    adapter: 'nginx-http-health',
    primaryDomain: 'example.com',
    healthPath: '/healthz',
    statusCode: 204,
    attempts: 2,
    route: '127.0.0.1:80',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ primaryDomain, healthPath }) => ({ primaryDomain, healthPath })), [
    { primaryDomain: 'example.com', healthPath: '/healthz' },
    { primaryDomain: 'example.com', healthPath: '/healthz' },
  ]);
});

test('Website health returns actionable unhealthy evidence after the bounded deadline', async () => {
  let clock = 10_000;
  const inspector = createWebsiteHttpHealthInspector({
    now: () => clock,
    sleep: async () => { clock += 5_000; },
    retryDelayMs: 500,
    request: async () => ({ reachable: true, healthy: false, statusCode: 502 }),
  });

  const result = await inspector.inspect({ primaryDomain: 'api.example.test', healthPath: '/health', timeoutSeconds: 5 });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'website_health_status_unhealthy');
  assert.equal(result.statusCode, 502);
  assert.equal(result.route, '127.0.0.1:80');
});

test('Website health rejects unsafe routing inputs before issuing a request', async () => {
  let called = false;
  const inspector = createWebsiteHttpHealthInspector({
    request: async () => { called = true; return { reachable: true, healthy: true, statusCode: 200 }; },
  });
  await assert.rejects(
    inspector.inspect({ primaryDomain: 'example.com', healthPath: 'https://example.com/health', timeoutSeconds: 5 }),
    (error) => error instanceof WebsiteHttpHealthError && error.code === 'website_health_path_invalid',
  );
  assert.equal(called, false);
});
