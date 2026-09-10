import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import { handleAuditRead, parseAuditQuery } from '../src/audit-http.js';

function responseRecorder() {
  const headers = new Map();
  return {
    headers,
    response: { setHeader(name, value) { headers.set(name.toLowerCase(), value); } },
  };
}

test('audit query accepts bounded pagination and exact actor/resource filters', () => {
  const query = new URLSearchParams({ limit: '25', offset: '50', actorId: 'owner-1', resourceType: 'job', resourceId: 'job-1' });
  assert.deepEqual(parseAuditQuery(query), {
    limit: 25,
    offset: 50,
    actorId: 'owner-1',
    resourceType: 'job',
    resourceId: 'job-1',
  });
  assert.deepEqual(parseAuditQuery(new URLSearchParams()), {
    limit: 50,
    offset: 0,
    actorId: null,
    resourceType: null,
    resourceId: null,
  });
});

test('audit query rejects unknown duplicate and incomplete filters', () => {
  for (const query of [
    new URLSearchParams('unknown=x'),
    new URLSearchParams('limit=10&limit=20'),
    new URLSearchParams('limit=-1'),
    new URLSearchParams('offset=nope'),
    new URLSearchParams('resourceType=job'),
    new URLSearchParams('resourceId=job-1'),
  ]) {
    assert.throws(
      () => parseAuditQuery(query),
      (error) => error instanceof AuthError && error.code === 'invalid_audit_query',
    );
  }
});

test('audit read forwards only normalized filters and bounded store output', () => {
  const calls = [];
  const { response } = responseRecorder();
  const payloads = [];
  const page = { events: [{ id: 1, actorId: 'owner-1', action: 'user.updated', resourceType: 'user', resourceId: 'user-2', outcome: 'succeeded', code: null, createdAt: 1 }], total: 1, offset: 0, limit: 50 };
  const result = handleAuditRead({
    request: { method: 'GET' },
    response,
    query: new URLSearchParams('actorId=owner-1'),
    store: { audit: { list(input) { calls.push(input); return page; } } },
    json(_response, status, payload) { payloads.push({ status, payload }); return payload; },
  });
  assert.deepEqual(calls, [{ limit: 50, offset: 0, actorId: 'owner-1', resourceType: null, resourceId: null }]);
  assert.deepEqual(payloads, [{ status: 200, payload: { data: page } }]);
  assert.deepEqual(result, { data: page });
});

test('audit read is GET-only and fails closed when store is unavailable', () => {
  const { response, headers } = responseRecorder();
  assert.throws(
    () => handleAuditRead({ request: { method: 'POST' }, response, query: new URLSearchParams(), store: {}, json() {} }),
    (error) => error instanceof AuthError && error.code === 'method_not_allowed' && error.status === 405,
  );
  assert.equal(headers.get('allow'), 'GET');

  assert.throws(
    () => handleAuditRead({ request: { method: 'GET' }, response, query: new URLSearchParams(), store: {}, json() {} }),
    (error) => error instanceof AuthError && error.code === 'audit_unavailable' && error.status === 503,
  );
});
