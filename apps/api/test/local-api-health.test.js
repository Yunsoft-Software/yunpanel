import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  checkLocalApiHealth,
  LocalApiHealthError,
  resolveLocalApiHealthTarget,
} from '../src/local-api-health.js';

function requestFixture({ statusCode = 200, body = '{"status":"ok"}', requestError = null, timeout = false } = {}) {
  const calls = [];
  const request = (options, onResponse) => {
    calls.push(options);
    const probe = new EventEmitter();
    probe.destroy = () => {};
    probe.end = () => {
      queueMicrotask(() => {
        if (timeout) {
          probe.emit('timeout');
          return;
        }
        if (requestError) {
          probe.emit('error', requestError);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.destroy = () => {};
        onResponse(response);
        if (body != null) response.emit('data', Buffer.from(body));
        response.emit('end');
      });
    };
    return probe;
  };
  return { calls, request };
}

test('health target is restricted to loopback API bindings', () => {
  assert.deepEqual(resolveLocalApiHealthTarget({ env: {} }), { host: '127.0.0.1', port: 3001 });
  assert.deepEqual(resolveLocalApiHealthTarget({ env: { YUNPANEL_API_HOST: '::1', YUNPANEL_API_PORT: '4011' } }), { host: '::1', port: 4011 });
  assert.throws(
    () => resolveLocalApiHealthTarget({ env: { YUNPANEL_API_HOST: '0.0.0.0' } }),
    (error) => error instanceof LocalApiHealthError && error.code === 'local_api_health_host_unsafe',
  );
  assert.throws(
    () => resolveLocalApiHealthTarget({ env: { YUNPANEL_API_PORT: '3001oops' } }),
    (error) => error instanceof LocalApiHealthError && error.code === 'local_api_health_port_invalid',
  );
});

test('health probe performs an unauthenticated bounded loopback GET only', async () => {
  const fixture = requestFixture();
  const result = await checkLocalApiHealth({
    env: { YUNPANEL_API_HOST: '127.0.0.1', YUNPANEL_API_PORT: '3001' },
    request: fixture.request,
  });
  assert.deepEqual(result, { healthy: true, host: '127.0.0.1', port: 3001, statusCode: 200 });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].method, 'GET');
  assert.equal(fixture.calls[0].path, '/api/health');
  assert.equal(Object.hasOwn(fixture.calls[0].headers, 'authorization'), false);
  assert.equal(Object.hasOwn(fixture.calls[0].headers, 'cookie'), false);
});

test('non-200, malformed and oversized health responses fail closed', async () => {
  for (const [options, code] of [
    [{ statusCode: 503, body: '{"status":"ok"}' }, 'local_api_health_unhealthy'],
    [{ body: 'not-json' }, 'local_api_health_response_invalid'],
    [{ body: '{"status":"down"}' }, 'local_api_health_unhealthy'],
    [{ body: 'x'.repeat(5000) }, 'local_api_health_response_invalid'],
  ]) {
    const fixture = requestFixture(options);
    await assert.rejects(
      checkLocalApiHealth({ env: {}, request: fixture.request }),
      (error) => error instanceof LocalApiHealthError && error.code === code,
    );
  }
});

test('transport errors and timeout do not expose raw network error text', async () => {
  for (const [options, code] of [
    [{ requestError: new Error('SECRET=/root/private/socket') }, 'local_api_health_unavailable'],
    [{ timeout: true }, 'local_api_health_timeout'],
  ]) {
    const fixture = requestFixture(options);
    await assert.rejects(
      checkLocalApiHealth({ env: {}, request: fixture.request }),
      (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /SECRET|\/root\/private|socket/i);
        return true;
      },
    );
  }
});
