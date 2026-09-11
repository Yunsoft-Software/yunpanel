import test from 'node:test';
import assert from 'node:assert/strict';
import { describePanelAccess, readOnlyPermission, requireReadOnlyRequest, READ_ONLY_PERMISSIONS } from '../src/panel-access.js';

const reader = { id: 's1', user: { id: 'reader', role: 'read_only' }, csrfToken: 'csrf', security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: false } };
const owner = { ...reader, user: { id: 'owner', role: 'owner' }, security: { ownerMfaRequired: true, enrollmentRequired: false, managementAllowed: true } };

test('describes owner and read-only capability surfaces without client input', () => {
  assert.deepEqual(describePanelAccess(reader).access, { mode: 'read_only', permissions: [...READ_ONLY_PERMISSIONS] });
  assert.deepEqual(describePanelAccess(owner).access, { mode: 'management', permissions: ['*'] });
  assert.deepEqual(describePanelAccess({ ...owner, security: { ...owner.security, managementAllowed: false } }).access, { mode: 'self_service', permissions: [] });
});

test('read-only inventory rules are exact and expose only safe Website nested domains', () => {
  for (const [path, permission] of [
    ['/api/servers', 'servers.read'], ['/api/servers/server-1', 'servers.read'],
    ['/api/websites', 'websites.read'], ['/api/websites/website-1', 'websites.read'], ['/api/websites/website-1/domains', 'websites.read'],
    ['/api/applications', 'applications.read'], ['/api/applications/app-1', 'applications.read'],
    ['/api/domains/domain-1', 'domains.read'], ['/api/certificates/cert-1', 'certificates.read'],
    ['/api/dns-zones', 'dns_zones.read'], ['/api/dns-zones/zone-1', 'dns_zones.read'],
    ['/api/mail-domains', 'mail_domains.read'], ['/api/mail-domains/mail-1', 'mail_domains.read'],
    ['/api/mail-domains/mail-1/config-preview', 'mail_domains.read'],
    ['/api/mailboxes', 'mailboxes.read'], ['/api/mailboxes/mailbox-1', 'mailboxes.read'],
  ]) assert.equal(readOnlyPermission('GET', path), permission);
  for (const path of [
    '/api/jobs', '/api/users', '/api/audit', '/api/websites/website-1/environment', '/api/websites/website-1/domains/extra',
    '/api/applications/app-1/environment', '/api/applications/app-1/status', '/api/dev/servers', '/api/servers/server-1/system/packages/inspect',
  ]) assert.equal(readOnlyPermission('GET', path), null);
  assert.equal(readOnlyPermission('POST', '/api/websites'), null);
  assert.equal(readOnlyPermission('POST', '/api/domains'), null);
});

test('read-only request guard rejects mutations, sensitive reads and other roles', () => {
  assert.equal(requireReadOnlyRequest(reader, 'HEAD', '/api/websites').access.mode, 'read_only');
  assert.equal(requireReadOnlyRequest(reader, 'HEAD', '/api/websites/website-1/domains').access.mode, 'read_only');
  assert.equal(requireReadOnlyRequest(reader, 'HEAD', '/api/domains').access.mode, 'read_only');
  assert.throws(() => requireReadOnlyRequest(reader, 'POST', '/api/websites'), { status: 403, code: 'forbidden' });
  assert.throws(() => requireReadOnlyRequest(reader, 'POST', '/api/domains'), { status: 403, code: 'forbidden' });
  assert.throws(() => requireReadOnlyRequest(reader, 'GET', '/api/jobs'), { status: 403, code: 'forbidden' });
  assert.throws(() => requireReadOnlyRequest(owner, 'GET', '/api/servers'), { status: 403, code: 'forbidden' });
  assert.throws(() => requireReadOnlyRequest(null, 'GET', '/api/servers'), { status: 401, code: 'unauthorized' });
});
