import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPhpSiteBootstrapManager,
  PhpSiteBootstrapManagerError,
  phpSiteBootstrapManagerInternals,
} from '../src/php-site-bootstrap-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-4dc352e64a14';
const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;
const applicationRoot = `/var/lib/yunpanel/apps/${applicationId}`;
const releasesDirectory = `${applicationRoot}/releases`;
const releaseDirectory = `${releasesDirectory}/${operationId}`;
const releaseDocumentRoot = `${releaseDirectory}/public`;
const currentRelease = `${applicationRoot}/current`;
const documentRoot = `${currentRelease}/public`;
const indexPath = `${releaseDocumentRoot}/index.php`;

function intent(overrides = {}) {
  return { websiteId, applicationId, unixUser, documentRoot, ...overrides };
}

function enoent() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

function identityManager({ satisfied = true } = {}) {
  return {
    inspect: async (value) => {
      assert.deepEqual(value, { user: unixUser, homeDirectory, websiteId, applicationId });
      if (!satisfied) return { satisfied: false, reason: 'website_identity_workspace_missing' };
      return { satisfied: true, user: unixUser, uid: 1201, gid: 1201, homeDirectory, homeMode: 0o750 };
    },
  };
}

function fakeHost({ aclInstalled = false } = {}) {
  const entries = new Map();
  const acls = new Map();
  const calls = [];

  function entry(file) {
    const value = entries.get(file);
    if (!value) throw enoent();
    return value;
  }

  const lstatFn = async (file) => {
    const value = entry(file);
    return {
      uid: value.uid ?? 0,
      gid: value.gid ?? 0,
      mode: value.mode ?? 0,
      isDirectory: () => value.type === 'directory',
      isFile: () => value.type === 'file',
      isSymbolicLink: () => value.type === 'symlink',
    };
  };
  const mkdirFn = async () => {};
  const readFileFn = async (file) => {
    const value = entry(file);
    if (value.type !== 'file') throw enoent();
    return value.content;
  };
  const writeFileFn = async (file, content, options = {}) => {
    if (options.flag === 'wx' && entries.has(file)) {
      const error = new Error('exists');
      error.code = 'EEXIST';
      throw error;
    }
    entries.set(file, { type: 'file', content: String(content), mode: options.mode ?? 0o600, uid: 0, gid: 0 });
  };
  const renameFn = async (source, target) => {
    const value = entry(source);
    entries.set(target, value);
    entries.delete(source);
  };
  const symlinkFn = async (target, file) => {
    if (entries.has(file)) {
      const error = new Error('exists');
      error.code = 'EEXIST';
      throw error;
    }
    entries.set(file, { type: 'symlink', target, mode: 0o777, uid: 0, gid: 0 });
  };
  const readlinkFn = async (file) => {
    const value = entry(file);
    if (value.type !== 'symlink') throw enoent();
    return value.target;
  };
  const readdirFn = async (directory) => {
    const base = entry(directory);
    if (base.type !== 'directory') throw enoent();
    const prefix = `${directory}/`;
    const children = new Set();
    for (const file of entries.keys()) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      if (relative && !relative.includes('/')) children.add(relative);
    }
    return [...children];
  };
  const rmFn = async (file, options = {}) => {
    if (options.recursive) {
      for (const key of [...entries.keys()]) {
        if (key === file || key.startsWith(`${file}/`)) entries.delete(key);
      }
      for (const key of [...acls.keys()]) {
        if (key === file || key.startsWith(`${file}/`)) acls.delete(key);
      }
      return;
    }
    entries.delete(file);
    acls.delete(file);
  };

  function aclEntry(raw) {
    if (raw.startsWith('d:u:')) return `default:user:${raw.slice(4)}`;
    if (raw.startsWith('u:')) return `user:${raw.slice(2)}`;
    return raw;
  }

  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/dpkg-query') {
      if (!aclInstalled) {
        const error = new Error('not installed');
        error.code = 1;
        throw error;
      }
      return { stdout: 'install ok installed\t2.3.1-1build1' };
    }
    if (file === '/usr/bin/apt-get') {
      aclInstalled = true;
      return { stdout: '' };
    }
    if (file === '/usr/bin/install') {
      const target = args.at(-1);
      const mode = Number.parseInt(args[args.indexOf('-m') + 1], 8);
      entries.set(target, { type: 'directory', mode, uid: 1201, gid: 1201 });
      return { stdout: '' };
    }
    if (file === '/usr/bin/chown') {
      const target = args.at(-1);
      const value = entry(target);
      value.uid = 1201;
      value.gid = 1201;
      return { stdout: '' };
    }
    if (file === '/usr/bin/chmod') {
      const target = args.at(-1);
      entry(target).mode = Number.parseInt(args[0], 8);
      return { stdout: '' };
    }
    if (file === '/usr/bin/setfacl') {
      const target = args.at(-1);
      const targetAcls = acls.get(target) ?? new Set();
      for (const raw of args[args.indexOf('-m') + 1].split(',')) targetAcls.add(aclEntry(raw));
      acls.set(target, targetAcls);
      return { stdout: '' };
    }
    if (file === '/usr/bin/getfacl') {
      const target = args.at(-1);
      return { stdout: `${[...(acls.get(target) ?? [])].join('\n')}\n` };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  return {
    entries,
    acls,
    calls,
    run,
    lstatFn,
    mkdirFn,
    readFileFn,
    readdirFn,
    readlinkFn,
    renameFn,
    rmFn,
    symlinkFn,
    writeFileFn,
    aclInstalled: () => aclInstalled,
  };
}

function manager(host, options = {}) {
  return createPhpSiteBootstrapManager({
    receiptRoot: '/var/lib/yunpanel/staging/php-sites',
    identityManager: options.identityManager ?? identityManager(),
    run: host.run,
    lstatFn: host.lstatFn,
    mkdirFn: host.mkdirFn,
    readFileFn: host.readFileFn,
    readdirFn: host.readdirFn,
    readlinkFn: host.readlinkFn,
    renameFn: host.renameFn,
    rmFn: host.rmFn,
    symlinkFn: host.symlinkFn,
    writeFileFn: host.writeFileFn,
  });
}

test('PHP bootstrap creates a site-owned release and grants only Nginx ACL access', async () => {
  const host = fakeHost();
  const bootstrap = manager(host);

  const result = await bootstrap.apply(intent(), { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'php-bootstrap');
  assert.equal(result.unixUser, unixUser);
  assert.equal(result.documentRoot, documentRoot);
  assert.equal(result.releaseDirectory, releaseDirectory);
  assert.equal(result.currentRelease, currentRelease);
  assert.equal(host.aclInstalled(), true);
  assert.equal(host.entries.get(applicationRoot)?.mode, 0o750);
  assert.equal(host.entries.get(releasesDirectory)?.mode, 0o750);
  assert.equal(host.entries.get(releaseDirectory)?.uid, 1201);
  assert.equal(host.entries.get(releaseDocumentRoot)?.gid, 1201);
  assert.equal(host.entries.get(indexPath)?.mode, 0o640);
  assert.equal(host.entries.get(currentRelease)?.target, releaseDirectory);
  assert.equal(host.entries.get(currentRelease)?.uid, 1201);
  assert.equal(host.acls.get(applicationRoot)?.has('user:www-data:--x'), true);
  assert.equal(host.acls.get(releaseDocumentRoot)?.has('user:www-data:r-x'), true);
  assert.equal(host.acls.get(releaseDocumentRoot)?.has('default:user:www-data:r-x'), true);
  assert.equal(host.acls.get(indexPath)?.has('user:www-data:r--'), true);
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), true);
});

test('PHP bootstrap is idempotent for the same durable operation', async () => {
  const host = fakeHost({ aclInstalled: true });
  const bootstrap = manager(host);
  const first = await bootstrap.apply(intent(), { operationId });
  const second = await bootstrap.apply(intent(), { operationId });

  assert.equal(first.satisfied, true);
  assert.equal(second.satisfied, true);
  assert.equal(second.releaseId, operationId);
  assert.equal(host.entries.get(indexPath)?.content, phpSiteBootstrapManagerInternals.bootstrapIndex);
});

test('PHP bootstrap refuses to mutate runtime paths before Website identity is ready', async () => {
  const host = fakeHost();
  const bootstrap = manager(host, { identityManager: identityManager({ satisfied: false }) });

  await assert.rejects(
    bootstrap.apply(intent(), { operationId }),
    (error) => error instanceof PhpSiteBootstrapManagerError && error.code === 'php_site_identity_required',
  );
  assert.equal(host.entries.has(applicationRoot), false);
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('PHP bootstrap refuses a pre-existing unowned runtime tree', async () => {
  const host = fakeHost({ aclInstalled: true });
  host.entries.set(applicationRoot, { type: 'directory', mode: 0o750, uid: 1201, gid: 1201 });
  const bootstrap = manager(host);

  await assert.rejects(
    bootstrap.apply(intent(), { operationId }),
    (error) => error instanceof PhpSiteBootstrapManagerError && error.code === 'php_site_bootstrap_conflict',
  );
});

test('PHP bootstrap inspection fails closed when Nginx ACL drifts', async () => {
  const host = fakeHost({ aclInstalled: true });
  const bootstrap = manager(host);
  await bootstrap.apply(intent(), { operationId });
  host.acls.get(releaseDocumentRoot)?.delete('user:www-data:r-x');

  await assert.rejects(
    bootstrap.inspect(intent(), { operationId }),
    (error) => error instanceof PhpSiteBootstrapManagerError && error.code === 'php_site_acl_drift',
  );
});

test('PHP bootstrap compensation removes only untouched operation-owned skeleton', async () => {
  const host = fakeHost({ aclInstalled: true });
  const bootstrap = manager(host);
  await bootstrap.apply(intent(), { operationId });

  const result = await bootstrap.compensate(intent(), { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.removed, true);
  assert.equal(result.receiptState, 'compensated');
  assert.equal(host.entries.has(applicationRoot), false);
  assert.equal(host.aclInstalled(), true);
});

test('PHP bootstrap compensation preserves user data and fails closed after edits', async () => {
  const host = fakeHost({ aclInstalled: true });
  const bootstrap = manager(host);
  await bootstrap.apply(intent(), { operationId });
  host.entries.set(`${releaseDocumentRoot}/custom.php`, {
    type: 'file', content: '<?php echo 1;', mode: 0o640, uid: 1201, gid: 1201,
  });

  await assert.rejects(
    bootstrap.compensate(intent(), { operationId }),
    (error) => error instanceof PhpSiteBootstrapManagerError && error.code === 'php_site_compensation_drift',
  );
  assert.equal(host.entries.has(`${releaseDocumentRoot}/custom.php`), true);
  assert.equal(host.entries.has(applicationRoot), true);
});
