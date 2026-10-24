import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createWebsiteMailBackupGuard } from '../src/website-mail-backup-guard.js';

test('mail writes are blocked during a website restore while reads and unrelated writes continue', async () => {
  const guard = createWebsiteMailBackupGuard({ localServerId: 'owned-server', jobRegistry: {
    listJobs: async ({ serverId }) => {
      assert.equal(serverId, 'owned-server');
      return [{ operation: OPERATIONS.WEBSITE_BACKUP_ACTION, status: 'running' }];
    },
  } });
  for (const path of ['/api/mailboxes', '/api/mailboxes/owned/password', '/api/mail-aliases/owned', '/api/mail-domains/owned', '/api/roundcube/mappings', '/api/servers/owned/mail-service-identity']) {
    let failure;
    await guard({ method: 'PATCH', path }, {}, error => { failure = error; });
    assert.equal(failure.code, 'website_mail_backup_job_conflict');
    assert.equal(failure.status, 409);
  }
  for (const request of [{ method: 'GET', path: '/api/mailboxes' }, { method: 'POST', path: '/api/servers/owned/databases' }]) {
    let failure;
    await guard(request, {}, error => { failure = error; });
    assert.equal(failure, undefined);
  }
});

test('an unreadable backup queue denies a mail write without leaking the underlying error', async () => {
  const guard = createWebsiteMailBackupGuard({ localServerId: 'owned-server', jobRegistry: { listJobs: async () => { throw new Error('private infrastructure failure'); } } });
  let failure;
  await guard({ method: 'PUT', path: '/api/mailboxes/owned/quota' }, {}, error => { failure = error; });
  assert.equal(failure.code, 'website_mail_backup_state_unavailable');
  assert.doesNotMatch(failure.message, /private infrastructure/);
});

test('WordPress pre-action backup protects the same mail metadata even though its outer job is a PHP action', async () => {
  const guard = createWebsiteMailBackupGuard({ localServerId: 'owned-server', jobRegistry: { listJobs: async () => [
    { operation: OPERATIONS.WEBSITE_PHP_ACTION, payload: { actionId: 'wp.toolkit' }, status: 'running' },
  ] } });
  let failure;
  await guard({ method: 'POST', path: '/api/mailboxes/owned/password' }, {}, error => { failure = error; });
  assert.equal(failure.code, 'website_mail_backup_job_conflict');
});
