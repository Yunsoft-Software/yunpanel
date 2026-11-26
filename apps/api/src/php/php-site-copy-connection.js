import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWebsitePathContract } from '@yunpanel/host-runtime';
import { siteFileManagerInternals } from '../files/site-file-manager.js';

const WORKER_PATH = fileURLToPath(new URL('./php-site-copy-connection-worker.js', import.meta.url));
const { appUnixUser, execFileWithInput, parseManagedAccount } = siteFileManagerInternals;

function fail(code = 'php_copy_connection_invalid') {
  const message = code === 'php_copy_connection_exists'
    ? 'Hedefte mevcut bir PHP veritabanı bağlantısı var.' : 'Sitenin özel PHP veritabanı bağlantısı doğrulanamadı.';
  return Object.assign(new Error(message), { code, status: 409 });
}

export function createPhpSiteCopyConnection({ databaseCredentialRegistry }) {
  async function materialize(scope) {
    const { database, websiteId, applicationId, unixUser } = scope;
    let credential;
    try {
      credential = await databaseCredentialRegistry.materializeCredential(database.credentialId, {
        expectedRevision: database.credentialRevision,
      });
    } catch { throw fail(); }
    if (!credential || credential.id !== database.credentialId || credential.databaseBindingId !== database.bindingId
      || credential.websiteId !== websiteId || credential.applicationId !== applicationId || credential.siteUnixUser !== unixUser
      || credential.databaseName !== database.databaseName || credential.host !== 'localhost') throw fail();
    const { databaseName, host, username, password } = credential;
    return { databaseName, host, username, password };
  }

  async function operate(scope, action) {
    const { websiteId, applicationId, unixUser, homeDirectory, database } = scope;
    const { workspace } = createWebsitePathContract({ websiteId, applicationId });
    if (process.getuid?.() !== 0 || unixUser !== appUnixUser(applicationId) || homeDirectory !== workspace.homeDirectory) throw fail();
    let response;
    try {
      const passwd = await readFile('/etc/passwd', 'utf8');
      const account = parseManagedAccount(passwd, unixUser);
      if (account.home !== homeDirectory) throw fail();
      const config = { version: 1, bindingId: database.bindingId, credentialId: database.credentialId, ...await materialize(scope) };
      const input = JSON.stringify({ action, home: homeDirectory, config });
      const { stdout } = await execFileWithInput('/usr/sbin/runuser', ['-u', unixUser, '--', process.execPath, WORKER_PATH], {
        cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', maxBuffer: 8_192, timeout: 10_000,
      }, input);
      response = JSON.parse(stdout);
    } catch { throw fail(); }
    if (response?.ok !== true) throw fail(response?.error === 'php_copy_connection_exists' ? response.error : undefined);
    if (action === 'inspect' && response.data === null) return null;
    if (response.data?.version !== 1 || response.data.bindingId !== database.bindingId
      || response.data.credentialId !== database.credentialId) throw fail();
    return { version: 1, bindingId: database.bindingId, credentialId: database.credentialId };
  }

  return Object.freeze({ materialize, inspect: (scope) => operate(scope, 'inspect'), create: (scope) => operate(scope, 'create') });
}
