import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import {
  mailDkimTemplatePolicy,
  previewRspamdDkimSigningConfig,
} from '@yunpanel/config-templates';
import {
  createMailDkimEvidenceInspector,
  mailDkimActivatorInternals,
} from '../src/index.js';

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const publicKey = Buffer.from(pair.publicKey).toString('base64');
const policy = Object.freeze({ domain: 'example.com', selector: 'mail-2026', publicKey });

function bundle({ empty = false } = {}) {
  return empty
    ? { preview: previewRspamdDkimSigningConfig([]), keys: [] }
    : {
        preview: previewRspamdDkimSigningConfig([policy]),
        keys: [{ ...policy, privateKey: pair.privateKey }],
      };
}

function fixture(input, {
  keyMode = 0o640,
  keyGid = 119,
  keyContent = pair.privateKey,
  configDigestMatch = true,
  configtest = true,
  active = true,
  extraKeyName = null,
} = {}) {
  const files = new Map();
  files.set(mailDkimTemplatePolicy.configPath, Buffer.from(
    configDigestMatch ? input.preview.artifact.content : 'changed\n',
  ));
  for (const key of input.keys) {
    files.set(mailDkimTemplatePolicy.keyPath(key.domain, key.selector), Buffer.from(keyContent));
  }
  if (extraKeyName) {
    files.set(`${mailDkimTemplatePolicy.keyRoot}/${extraKeyName}`, Buffer.from(keyContent));
  }
  const directories = new Map([
    [mailDkimActivatorInternals.liveKeyParent, { mode: 0o750, uid: 0, gid: 119 }],
    [mailDkimTemplatePolicy.keyRoot, { mode: 0o750, uid: 0, gid: 119 }],
  ]);
  const calls = [];
  const inspector = createMailDkimEvidenceInspector({
    lstatFn: async (filePath) => {
      if (directories.has(filePath)) {
        const metadata = directories.get(filePath);
        return {
          ...metadata,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      }
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const isKey = filePath.startsWith(`${mailDkimTemplatePolicy.keyRoot}/`);
      return {
        mode: isKey ? keyMode : 0o640,
        uid: 0,
        gid: isKey ? keyGid : 0,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    readFileFn: async (filePath, encoding) => {
      const value = files.get(filePath);
      return encoding ? value.toString(encoding) : Buffer.from(value);
    },
    readdirFn: async (directory) => {
      assert.equal(directory, mailDkimTemplatePolicy.keyRoot);
      return [...files.keys()]
        .filter((filePath) => filePath.startsWith(`${mailDkimTemplatePolicy.keyRoot}/`))
        .map((filePath) => ({
          name: path.basename(filePath),
          isFile: () => true,
          isSymbolicLink: () => false,
        }));
    },
    run: async (file, args) => {
      calls.push([file, [...args]]);
      if (file === '/usr/bin/getent') {
        return { stdout: '_rspamd:x:113:119::/var/lib/rspamd:/usr/sbin/nologin\n', stderr: '' };
      }
      if (file === '/usr/bin/rspamadm' && !configtest) throw new Error('configtest failed');
      if (file === '/usr/bin/systemctl' && !active) throw new Error('inactive');
      return { stdout: '', stderr: '' };
    },
  });
  return { inspector, calls };
}

test('accepts exact live DKIM config, private-key identity and Rspamd health without leaking PEM', async () => {
  const input = bundle();
  const { inspector, calls } = fixture(input);
  const result = await inspector.inspect(input);
  assert.deepEqual(result, {
    satisfied: true,
    result: {
      version: 1,
      previewSha256: input.preview.sha256,
      applied: true,
      sideEffects: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /BEGIN PRIVATE KEY|privateKey/);
  assert.deepEqual(calls, [
    ['/usr/bin/getent', ['passwd', '_rspamd']],
    ['/usr/bin/rspamadm', ['configtest']],
    ['/usr/bin/systemctl', ['is-active', '--quiet', 'rspamd']],
  ]);
});

test('accepts deterministic empty signing teardown only when the managed live key set is also empty', async () => {
  const input = bundle({ empty: true });
  const clean = fixture(input);
  const result = await clean.inspector.inspect(input);
  assert.equal(result.satisfied, true);
  assert.equal(result.result.previewSha256, input.preview.sha256);

  const stale = fixture(input, { extraKeyName: 'example.com.old.key' });
  assert.deepEqual(await stale.inspector.inspect(input), { satisfied: false, result: null });
});

test('fails closed on config drift, unsafe key metadata, private/public mismatch, stale/unknown key entries or unhealthy Rspamd', async () => {
  const input = bundle();
  for (const options of [
    { configDigestMatch: false },
    { keyMode: 0o600 },
    { keyGid: 0 },
    { keyContent: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    { extraKeyName: 'example.com.old.key' },
    { extraKeyName: 'unexpected.txt' },
    { configtest: false },
    { active: false },
  ]) {
    const { inspector } = fixture(input, options);
    assert.deepEqual(await inspector.inspect(input), { satisfied: false, result: null });
  }
});
