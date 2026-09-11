import test from 'node:test';
import assert from 'node:assert/strict';
import { requirePanelRouteAccess } from '../src/panel-http-guard.js';

const owner = {
  user: { id: 'owner-1', role: 'owner' },
  security: { managementAllowed: true },
  access: { mode: 'management', permissions: ['*'] },
};
const reader = {
  user: { id: 'reader-1', role: 'read_only' },
  security: { managementAllowed: false },
  access: {
    mode: 'read_only',
    permissions: ['servers.read', 'applications.read', 'domains.read', 'certificates.read', 'dns_zones.read', 'mail_domains.read', 'mailboxes.read'],
  },
};

function run({ auth = null, method = 'GET', url = '/api/servers', authorization } = {}) {
  const result = { next: false, status: null, payload: null };
  const request = { auth, method, originalUrl: url, headers: authorization ? { authorization } : {} };
  const response = {
    status(code) { result.status = code; return this; },
    json(payload) { result.payload = payload; return this; },
  };
  requirePanelRouteAccess(request, response, () => { result.next = true; });
  return result;
}

test('server-derived Owner management context passes', () => {
  assert.equal(run({ auth: owner, method: 'POST', url: '/api/domains' }).next, true);
});

test('bearer headers cannot substitute for request.auth', () => {
  const result = run({ authorization: 'Bearer development-admin-token' });
  assert.equal(result.next, false);
  assert.equal(result.status, 401);
  assert.equal(result.payload.error.code, 'unauthorized');
});

test('read-only context is limited by exact resource and method rules', () => {
  assert.equal(run({ auth: reader, url: '/api/servers' }).next, true);
  assert.equal(run({ auth: reader, url: '/api/applications/app-1' }).next, true);
  assert.equal(run({ auth: reader, url: '/api/dns-zones' }).next, true);
  assert.equal(run({ auth: reader, url: '/api/mail-domains/mail-1' }).next, true);
  assert.equal(run({ auth: reader, url: '/api/mail-domains/mail-1/config-preview' }).next, true);
  assert.equal(run({ auth: reader, url: '/api/mailboxes/mailbox-1' }).next, true);
  assert.equal(run({ auth: reader, url: '/api/jobs' }).status, 403);
  assert.equal(run({ auth: reader, url: '/api/servers/server-1/logs/nginx' }).status, 403);
  assert.equal(run({ auth: reader, method: 'POST', url: '/api/domains' }).status, 403);
});

test('wildcard permissions cannot elevate a read-only or unenrolled Owner context', () => {
  assert.equal(run({ auth: { ...reader, access: { mode: 'read_only', permissions: ['*'] } }, method: 'POST', url: '/api/domains' }).status, 403);
  assert.equal(run({ auth: { ...owner, security: { managementAllowed: false } }, url: '/api/servers' }).status, 403);
});
