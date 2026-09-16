import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeApplicationUser } from '../src/systemd.js';
import { renderWebsiteSftpMatch, sftpSitePaths, sftpTemplatePolicy } from '../src/sftp.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = nodeApplicationUser(applicationId);

test('Website SFTP uses a root-managed AuthorizedKeysFile outside the site-owned home', () => {
  const paths = sftpSitePaths({ applicationId, unixUser });
  assert.equal(sftpTemplatePolicy.authorizedKeysRoot, '/etc/ssh/yunpanel-authorized-keys');
  assert.equal(paths.authorizedKeysPath, `/etc/ssh/yunpanel-authorized-keys/${unixUser}`);
  assert.equal(paths.authorizedKeysPath.startsWith(paths.sourceDirectory), false);

  const sshd = renderWebsiteSftpMatch({ applicationId, unixUser });
  assert.match(
    sshd,
    new RegExp(`^  AuthorizedKeysFile /etc/ssh/yunpanel-authorized-keys/${unixUser}$`, 'm'),
  );
  assert.match(sshd, /^  PubkeyAuthentication yes$/m);
  assert.match(sshd, /^  PasswordAuthentication no$/m);
});
