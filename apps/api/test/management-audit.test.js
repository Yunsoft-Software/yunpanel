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
    ['POST', '/api/terminal/capabilities', 'terminal.capability.issued', 'terminal', 'new'],
    ['POST', '/api/applications/app-1/deploy', 'application.deploy', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/rollback', 'application.rollback', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/restart', 'application.restart', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/process', 'application.process', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/status/refresh', 'application.status.refresh', 'application', 'app-1'],
    ['PUT', '/api/applications/app-1/environment/API_SECRET', 'application.environment.updated', 'application', 'app-1'],
    ['DELETE', '/api/applications/app-1/environment/API_SECRET', 'application.environment.deleted', 'application', 'app-1'],
    ['PUT', '/api/applications/app-1/deployment-credential', 'application.git_credential.updated', 'application', 'app-1'],
    ['DELETE', '/api/applications/app-1/deployment-credential', 'application.git_credential.deleted', 'application', 'app-1'],
    ['PUT', '/api/applications/app-1/github-webhook', 'application.github_webhook.updated', 'application', 'app-1'],
    ['DELETE', '/api/applications/app-1/github-webhook', 'application.github_webhook.deleted', 'application', 'app-1'],
    ['POST', '/api/applications/app-1/environment/import', 'application.environment.imported', 'application', 'app-1'],
    ['POST', '/api/domains', 'domain.create', 'domain', 'new'],
    ['POST', '/api/mailboxes', 'mailbox.create', 'mailbox', 'new'],
    ['POST', '/api/mailboxes/mailbox-1/password', 'mailbox.password.rotate', 'mailbox', 'mailbox-1'],
    ['PATCH', '/api/mailboxes/mailbox-1', 'mailbox.update', 'mailbox', 'mailbox-1'],
    ['DELETE', '/api/mailboxes/mailbox-1', 'mailbox.delete', 'mailbox', 'mailbox-1'],
    ['POST', '/api/mail-domains/mail-domain-1/dkim/local-dns-retirement-preview', 'mail.dkim.local_dns_retirement.preview', 'mail_domain', 'mail-domain-1'],
    ['POST', '/api/mail-domains/mail-domain-1/dkim/local-dns-retirement-apply', 'mail.dkim.local_dns_retirement.apply', 'mail_domain', 'mail-domain-1'],
    ['POST', '/api/domains/domain-1/reparent-preview', 'domain.reparent.preview', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/reparent', 'domain.reparent', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/update-preview', 'domain.update.preview', 'domain', 'domain-1'],
    ['PATCH', '/api/domains/domain-1', 'domain.update', 'domain', 'domain-1'],
    ['POST', '/api/websites/website-1/update-preview', 'website.update.preview', 'website', 'website-1'],
    ['POST', '/api/websites/website-1/sftp/keys', 'website.sftp_key.add', 'website', 'website-1'],
    ['POST', '/api/websites/website-1/sftp/keys/key-1/revoke', 'website.sftp_key.revoke', 'website', 'website-1'],
    ['POST', '/api/websites/website-1/sftp/keys/key-1/rotate', 'website.sftp_key.rotate', 'website', 'website-1'],
    ['POST', '/api/websites/website-1/sftp/keys/reconcile', 'website.sftp_key.reconcile', 'website', 'website-1'],
    ['PATCH', '/api/websites/website-1', 'website.update', 'website', 'website-1'],
    ['POST', '/api/domains/domain-1/stage', 'domain.stage', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/activate', 'domain.activate', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/dns/dnssec/preview', 'dns.dnssec.preview', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/dns/dnssec/apply', 'dns.dnssec.apply', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/dns/dnssec/rollover/apply', 'dns.dnssec.rollover.apply', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/dns/dnssec/rollover/operations/operation-1/continue', 'dns.dnssec.rollover.continue', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/certificates/custom-preview', 'certificate.custom.preview', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/certificates/custom', 'certificate.custom.import', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/certificates/certificate-1/select-preview', 'certificate.select.preview', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/certificates/certificate-1/select', 'certificate.select', 'domain', 'domain-1'],
    ['POST', '/api/domains/domain-1/certificates/issue', 'certificate.issue', 'domain', 'domain-1'],
    ['PUT', '/api/dns-zones/zone-1/provider-credential', 'dns.provider.configure', 'dns_zone', 'zone-1'],
    ['DELETE', '/api/dns-zones/zone-1/provider-credential', 'dns.provider.delete', 'dns_zone', 'zone-1'],
    ['POST', '/api/dns-zones/zone-1/readiness/refresh', 'dns.readiness.refresh', 'dns_zone', 'zone-1'],
    ['POST', '/api/dns-zones/zone-1/records/preview', 'dns.record.preview', 'dns_zone', 'zone-1'],
    ['POST', '/api/dns-zones/zone-1/records/apply', 'dns.record.apply', 'dns_zone', 'zone-1'],
    ['POST', '/api/servers/server-1/dns/authoritative/preview', 'dns.authoritative.preview', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/dns/authoritative/apply', 'dns.authoritative.apply', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/dns/authoritative/recovery/resolve', 'dns.authoritative.recovery.resolve', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/dns/authoritative/recovery/retry', 'dns.authoritative.recovery.retry', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/dns/authoritative/rollback', 'dns.authoritative.rollback', 'server', 'server-1'],
    ['POST', '/api/certificates/cert-1/renew', 'certificate.renew', 'certificate', 'cert-1'],
    ['POST', '/api/jobs/job-1/cancel', 'job.cancel', 'job', 'job-1'],
    ['POST', '/api/servers/server-1/system/packages/inspect', 'system.packages.inspect', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/system/upgrade', 'system.upgrade', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/node-runtimes/inspect', 'node_runtime.inspect', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/node-runtimes/24/install', 'node_runtime.install', 'server', 'server-1:24'],
    ['POST', '/api/servers/server-1/services/inspect', 'system.services.inspect', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/services/nginx/install', 'service.install', 'service', 'server-1:nginx'],
    ['POST', '/api/servers/server-1/services/nginx/control', 'service.control', 'service', 'server-1:nginx'],
    ['POST', '/api/servers/server-1/databases/inspect', 'database.inspect', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/databases', 'database.create', 'server', 'server-1'],
    ['POST', '/api/servers/server-1/databases/app_db/backup', 'database.backup', 'database', 'app_db'],
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

test('Git credential body never enters common audit metadata', () => {
  const events = [];
  const response = new Response(200);
  const token = 'github_pat_private_audit_value';
  attachManagementAudit({
    request: { method: 'PUT', auth: { user: { id: 'owner-1' } }, body: { type: 'github_token', token } },
    response,
    pathname: '/api/applications/app-1/deployment-credential',
    audit: { record(event) { events.push(event); } },
  });
  response.emit('finish');
  assert.equal(JSON.stringify(events).includes(token), false);
  assert.deepEqual(events.map((event) => event.action), [
    'application.git_credential.updated', 'application.git_credential.updated',
  ]);
});

test('SFTP public-key material never enters common audit metadata', () => {
  const events = [];
  const response = new Response(201);
  const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIprivate-looking-public-material';
  attachManagementAudit({
    request: {
      method: 'POST',
      auth: { user: { id: 'owner-1' } },
      body: { label: 'Private laptop label', publicKey },
    },
    response,
    pathname: '/api/websites/website-1/sftp/keys',
    audit: { record(event) { events.push(event); } },
  });
  response.emit('finish');
  assert.deepEqual(events.map((event) => event.action), [
    'website.sftp_key.add', 'website.sftp_key.add',
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-looking|Private laptop|publicKey|label/);
});

test('mailbox password and mutation body never enter common audit metadata', () => {
  const events = [];
  const response = new Response(200);
  attachManagementAudit({
    request: {
      method: 'POST',
      auth: { user: { id: 'owner-1' } },
      body: { expectedRevision: 4, password: 'private mailbox value', confirmation: 'do-not-log' },
    },
    response,
    pathname: '/api/mailboxes/mailbox-1/password',
    audit: { record(event) { events.push(event); } },
  });
  response.emit('finish');
  assert.deepEqual(events.map((event) => event.action), [
    'mailbox.password.rotate', 'mailbox.password.rotate',
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private mailbox value|expectedRevision|confirmation|do-not-log/);
});

test('environment import content never enters common audit metadata', () => {
  const events = [];
  const response = new Response(200);
  attachManagementAudit({
    request: { method: 'POST', auth: { user: { id: 'owner-1' } }, body: { content: 'PRIVATE_TOKEN=do-not-log', mode: 'merge' } },
    response,
    pathname: '/api/applications/app-1/environment/import',
    audit: { record(event) { events.push(event); } },
  });
  response.emit('finish');
  assert.deepEqual(events.map((event) => event.action), [
    'application.environment.imported', 'application.environment.imported',
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_TOKEN|do-not-log|content|mode/);
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
