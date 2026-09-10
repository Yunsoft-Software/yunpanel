import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import { attachManagementAudit, classifyManagementMutation } from '../src/management-audit.js';

class Response extends EventEmitter {
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
  }
}

test('current management mutation routes map to bounded action and resource identities', () => {
  const cases = [
    ['POST', '/api/applications', 'application.create', 'application', 'new'],
    ['POST', '/api/applications/app-1/deploy', 'application.deploy', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/rollback', 'application.rollback', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/restart', 'application.restart', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/status/refresh', 'application.status.refresh', 'application', 'app-1'],
    ['PUT', '/api/applications/app-1/environment/API_SECRET', 'application.environment.updated', 'application', 'app-1'],
    ['DELETE', '/api/applications/app-1/environment/API_SECRET', 'application.environment.deleted', 'application', 'app-1'],
    ['POST', '/api/domains', 'domain.create', 'domain', 'new'],
    ['POST', '/api/domains/domain-1/stage', 'domain.stage', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/activate', 'domain.activate', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/certificates/issue', 'certificate.issue', 'domain', 'domain-1'],
    ['POST', '/api/certificates/cert-1/renew', 'certificate.renew', 'certificate', 'cert-1'],
    ['POST', '/api/jobs/job-1/cancel', 'job.cancel', 'job', 'job-1'],
    ['POST', '/api/servers/server-1/system/packages/inspect', 'system.packages.inspect', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/system/upgrade', 'system.upgrade', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/services/inspect', 'system.services.inspect', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/services/nginx/install', 'service.install', 'service', 'server-1:nginx'],
    ['POST', '/api/servers/server-1/services/nginx/control', 'service.control', 'service', 'server-1:nginx'],
    ['POST', '/api/servers/server-1/databases/inspect', 'database.inspect', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/databases', 'database.create', 'server', 'server-1'],
    ['DELETE', '/api/servers/server-1/databases/app_db', 'database.delete', 'database', 'app_db'],
  ];
  for (const [method, pathname, action, resourceType, resourceId] of cases) {
    assert.deepEqual(classifyManagementMutation(method, pathname), { action, resourceType, resourceId });
  }
  assert.equal(classifyManagementMutation('GET', '/api/servers/server-1/databases'), null);
  assert.equal(classifyManagementMutation('POST', '/api/users'), null);
  assert.equal(classifyManagementMutation('POST', '/api/auth/logout'), null);
  assert.equal(classifyManagementMutation('POST', '/api/servers/enroll'), null);
});

test('environment key and request body never enter management audit metadata', () => {
  const events = [];
  const response = new Response(204);
  const request = {
    method: 'PUT',
    auth: { user: { id: 'owner-1' } },
    body: { value: 'TOP-SECRET', secret: true },
  };
  attachManagementAudit({
    request,
    response,
    pathname: '/api/applications/app-1/environment/TOP_SECRET_KEY',
    audit: { record(event) { events.push(event); } },
  });
  response.emit('finish');
  assert.equal(JSON.stringify(events).includes('TOP-SECRET'), false);
  assert.equal(JSON.stringify(events).includes('TOP_SECRET_KEY'), false);
  assert.deepEqual(events, [
    { actorId: 'owner-1', action: 'application.environment.updated', resourceType: 'application', resourceId: 'app-1', outcome: 'accepted' },
    { actorId: 'owner-1', action: 'application.environment.updated', resourceType: 'application', resourceId: 'app-1', outcome: 'succeeded', code: null },
  ]);
});

test('audit acceptance failure blocks the management mutation boundary', () => {
  const response = new Response(202);
  assert.throws(
    () => attachManagementAudit({
      request: { method: 'POST', auth: { user: { id: 'owner-1' } } },
      response,
      pathname: '/api/applications/app-1/deploy',
      audit: { record() { throw new Error('SECRET=/root/private/audit'); } },
    }),
    (error) => error instanceof AuthError && error.code === 'audit_unavailable' && error.status === 503
      && !/SECRET|\/root\/private/.test(error.message),
  );
  assert.equal(response.listenerCount('finish'), 0);
});

test('async 202 response keeps only accepted event until job lifecycle records terminal result', () => {
  const events = [];
  const response = new Response(202);
  attachManagementAudit({
    request: { method: 'POST', auth: { user: { id: 'owner-1' } } },
    response,
    pathname: '/api/applications/app-1/deploy',
    audit: { record(event) { events.push(event); } },
  });
  response.emit('finish');
  assert.deepEqual(events, [
    { actorId: 'owner-1', action: 'application.deploy', resourceType: 'application', resourceId: 'app-1', outcome: 'accepted' },
  ]);
});

test('synchronous handler failure records only status code, never response body', () => {
  const events = [];
  const response = new Response(409);
  attachManagementAudit({
    request: { method: 'POST', auth: { user: { id: 'owner-1' } }, body: { confirmation: 'secret-confirmation' } },
    response,
    pathname: '/api/domains/domain-1/activate',
    audit: { record(event) { events.push(event); } },
  });
  response.emit('finish');
  assert.deepEqual(events[1], {
    actorId: 'owner-1',
    action: 'domain.activate',
    resourceType: 'domain',
    resourceId: 'domain-1',
    outcome: 'failed',
    code: 'http_409',
  });
  assert.equal(JSON.stringify(events).includes('secret-confirmation'), false);
});
