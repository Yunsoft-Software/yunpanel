import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeApplicationUser } from '../src/systemd.js';
import {
  renderWebsiteSftpMatch,
  renderWebsiteSftpMountUnit,
  sftpSitePaths,
  SftpTemplateError,
} from '../src/sftp.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = nodeApplicationUser(applicationId);

function input(overrides = {}) {
  return { applicationId, unixUser, ...overrides };
}

test('Website SFTP template chroots the exact managed user around a bind-mounted site root', () => {
  const paths = sftpSitePaths(input());
  assert.equal(paths.sourceDirectory, `/var/lib/yunpanel/data/${applicationId}`);
  assert.equal(paths.chrootDirectory, `/var/lib/yunpanel/sftp-chroots/${applicationId}`);
  assert.equal(paths.mountDirectory, `/var/lib/yunpanel/sftp-chroots/${applicationId}/site`);

  const sshd = renderWebsiteSftpMatch(input());
  assert.match(sshd, new RegExp(`^Match User ${unixUser}$`, 'm'));
  assert.match(sshd, new RegExp(`^  ChrootDirectory /var/lib/yunpanel/sftp-chroots/${applicationId}$`, 'm'));
  assert.match(sshd, /^  ForceCommand internal-sftp -d \/site -u 0027$/m);
  assert.match(sshd, /^  PasswordAuthentication no$/m);
  assert.match(sshd, /^  PubkeyAuthentication yes$/m);
  assert.match(sshd, /^  AllowTcpForwarding no$/m);
  assert.match(sshd, /^  AllowAgentForwarding no$/m);
  assert.doesNotMatch(sshd, /ForceCommand .*\/bin\/sh/);

  const mount = renderWebsiteSftpMountUnit(input());
  assert.match(mount, new RegExp(`^What=/var/lib/yunpanel/data/${applicationId}$`, 'm'));
  assert.match(mount, new RegExp(`^Where=/var/lib/yunpanel/sftp-chroots/${applicationId}/site$`, 'm'));
  assert.match(mount, /^Options=bind,nosuid,nodev,noexec$/m);
});

test('Website SFTP template refuses a user that is not the canonical Application identity', () => {
  assert.throws(
    () => renderWebsiteSftpMatch(input({ unixUser: 'yunapp-aaaaaaaaaaaa' })),
    (error) => error instanceof SftpTemplateError && error.code === 'sftp_identity_mismatch',
  );
});
