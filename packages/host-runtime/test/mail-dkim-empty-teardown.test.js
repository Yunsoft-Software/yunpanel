import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mailDkimTemplatePolicy,
  previewRspamdDkimSigningConfig,
} from '@yunpanel/config-templates';
import {
  createMailDkimActivator,
  mailDkimActivatorInternals,
} from '../src/index.js';

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dkim-empty-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function mappedFs(root) {
  const owners = new Map();
  const mapPath = (value) => path.join(root, value.replace(/^\/+/, ''));
  return {
    mapPath,
    setOwner(value, uid, gid) { owners.set(mapPath(value), { uid, gid }); },
    lstatFn: async (value) => {
      const target = mapPath(value);
      const metadata = await lstat(target);
      const owner = owners.get(target);
      if (!owner) return metadata;
      return new Proxy(metadata, {
        get(object, property) {
          if (property === 'uid') return owner.uid;
          if (property === 'gid') return owner.gid;
          const resolved = object[property];
          return typeof resolved === 'function' ? resolved.bind(object) : resolved;
        },
      });
    },
    mkdirFn: (value, options) => mkdir(mapPath(value), options),
    readFileFn: (value, options) => readFile(mapPath(value), options),
    renameFn: (from, to) => rename(mapPath(from), mapPath(to)),
    rmFn: (value, options) => rm(mapPath(value), options),
    rmdirFn: (value) => rmdir(mapPath(value)),
    writeFileFn: (value, content, options) => writeFile(mapPath(value), content, options),
    chmodFn: (value, mode) => chmod(mapPath(value), mode),
    chownFn: async (value, uid, gid) => { owners.set(mapPath(value), { uid, gid }); },
  };
}

async function directory(mapped, value, mode = 0o755, uid = 0, gid = 0) {
  await mkdir(mapped.mapPath(value), { recursive: true, mode });
  await chmod(mapped.mapPath(value), mode);
  mapped.setOwner(value, uid, gid);
}

test('zero-key DKIM teardown writes deterministic empty Rspamd signing state and still validates/reloads/health-checks', async () => withTempDirectory(async (root) => {
  const mapped = mappedFs(root);
  await directory(mapped, '/etc/rspamd');
  await directory(mapped, '/etc/rspamd/local.d');
  const calls = [];
  const activator = createMailDkimActivator({
    backupRoot: '/var/lib/yunpanel/recovery/mail-dkim-empty-test',
    run: async (file, args) => {
      calls.push([file, [...args]]);
      if (file === '/usr/bin/getent') {
        return { stdout: '_rspamd:x:113:119::/var/lib/rspamd:/usr/sbin/nologin\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    ...mapped,
  });
  const preview = previewRspamdDkimSigningConfig([]);
  const result = await activator.activate({ preview, keys: [] }, { transactionId: 'mail-dkim-empty-001' });

  assert.deepEqual(result, {
    version: 1,
    previewSha256: preview.sha256,
    applied: true,
    sideEffects: true,
  });
  assert.equal(await readFile(mapped.mapPath(mailDkimTemplatePolicy.configPath), 'utf8'), preview.artifact.content);
  assert.deepEqual(await readdir(mapped.mapPath(mailDkimTemplatePolicy.keyRoot)), []);
  const keyRoot = await mapped.lstatFn(mailDkimTemplatePolicy.keyRoot);
  assert.equal(keyRoot.mode & 0o7777, mailDkimActivatorInternals.liveKeyDirectoryMode);
  assert.equal(keyRoot.uid, 0);
  assert.equal(keyRoot.gid, 119);
  assert.deepEqual(calls, [
    ['/usr/bin/getent', ['passwd', '_rspamd']],
    ['/usr/bin/rspamadm', ['configtest']],
    ['/usr/bin/systemctl', ['reload', 'rspamd']],
    ['/usr/bin/systemctl', ['is-active', '--quiet', 'rspamd']],
  ]);
}));
