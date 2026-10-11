import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createNodeRuntimeManager,
  NodeRuntimeManagerError,
  nodeRuntimeInternals,
} from '../src/node-runtime-manager.js';

test('runtime manifest accepts only the requested official Linux architecture artifact', () => {
  const checksum = 'a'.repeat(64);
  assert.deepEqual(
    nodeRuntimeInternals.archiveFromShasums(`${checksum}  node-v24.21.0-linux-x64.tar.xz\n`, 24, 'x64'),
    { checksum, fileName: 'node-v24.21.0-linux-x64.tar.xz', version: 'v24.21.0' },
  );
  assert.throws(
    () => nodeRuntimeInternals.archiveFromShasums(`${checksum}  node-v24.21.0-linux-arm64.tar.xz\n`, 24, 'x64'),
    NodeRuntimeManagerError,
  );
});

test('managed install verifies checksum, activates one major atomically and leaves panel Node untouched', async (t) => {
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-runtimes-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const calls = [];
  const checksum = 'b'.repeat(64);
  const manager = createNodeRuntimeManager({
    runtimeRoot,
    architecture: 'x64',
    supportedMajors: [24],
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/local/bin/node') return { stdout: 'v24.18.1\n' };
      if (file === '/usr/bin/node') return { stdout: 'v22.23.2\n' };
      if (file === '/usr/bin/curl' && args.includes('--output')) {
        const output = args[args.indexOf('--output') + 1];
        if (output.endsWith('SHASUMS256.txt')) {
          await writeFile(output, `${checksum}  node-v24.21.0-linux-x64.tar.xz\n`);
        } else {
          await writeFile(output, 'verified archive fixture');
        }
        return { stdout: '' };
      }
      if (file === '/usr/bin/sha256sum') return { stdout: `${checksum}  ${args[0]}\n` };
      if (file === '/usr/bin/tar' && args[0] === '--extract') {
        const extractPath = args[args.indexOf('--directory') + 1];
        await mkdir(path.join(extractPath, 'bin'), { recursive: true });
        await mkdir(path.join(extractPath, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
        await writeFile(path.join(extractPath, 'bin', 'node'), 'node', { mode: 0o755 });
        await writeFile(path.join(extractPath, 'bin', 'corepack'), 'corepack', { mode: 0o755 });
        await writeFile(path.join(extractPath, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm', { mode: 0o755 });
        await symlink('../lib/node_modules/npm/bin/npm-cli.js', path.join(extractPath, 'bin', 'npm'));
        return { stdout: '' };
      }
      if (file.endsWith('/bin/corepack')) {
        const bin = args[args.indexOf('--install-directory') + 1];
        await writeFile(path.join(bin, 'pnpm'), 'pnpm', { mode: 0o755 });
        await writeFile(path.join(bin, 'yarn'), 'yarn', { mode: 0o755 });
        return { stdout: '' };
      }
      if (file.endsWith('/v24/bin/node') || file.includes('.install-v24-') && file.endsWith('/runtime/bin/node')) {
        return { stdout: 'v24.21.0\n' };
      }
      if (args[0] === '--version' && ['/usr/bin/curl', '/usr/bin/tar', '/usr/bin/sha256sum'].includes(file)) return { stdout: 'tool\n' };
      throw Object.assign(new Error('missing fixture executable'), { code: 'ENOENT' });
    },
  });

  const installed = await manager.install(24);
  assert.equal(installed.changed, true);
  assert.equal(installed.runtime.version, 'v24.21.0');
  assert.deepEqual(installed.runtime.packageManagers, ['npm', 'pnpm', 'yarn']);
  assert.equal(installed.inventory.panelRuntime.version, 'v24.18.1');
  assert.ok(calls.filter(([file]) => file === '/usr/local/bin/node').every(([, args]) => args[0] === '--version'));
  assert.equal(calls.some(([, args]) => args.includes('node-v24.21.0-linux-x64.tar.xz')), false);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/curl' && args.at(-1).endsWith('/node-v24.21.0-linux-x64.tar.xz')));

  const repeated = await manager.install(24);
  assert.equal(repeated.changed, false);
  for (const entry of ['', 'v24', 'v24/bin', 'v24/bin/node', 'v24/lib/node_modules/npm/bin/npm-cli.js']) {
    assert.equal((await lstat(path.join(runtimeRoot, entry))).mode & 0o7777, 0o755, entry);
  }
  await chmod(path.join(runtimeRoot, 'v24', 'bin', 'node'), 0o700);
  assert.equal((await manager.install(24)).changed, true);
  assert.equal((await lstat(path.join(runtimeRoot, 'v24', 'bin', 'node'))).mode & 0o7777, 0o755);

  const outsideFile = path.join(runtimeRoot, 'outside-private');
  await writeFile(outsideFile, 'private', { mode: 0o600 });
  await symlink('../../outside-private', path.join(runtimeRoot, 'v24', 'bin', 'escape'));
  await assert.rejects(manager.install(24), { code: 'node_runtime_entry_invalid' });
  assert.equal((await lstat(outsideFile)).mode & 0o7777, 0o600);
});

test('unsupported major and checksum mismatch never activate a runtime', async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-runtime-reject-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const manager = createNodeRuntimeManager({
    runtimeRoot,
    architecture: 'arm64',
    supportedMajors: [24],
    run: async (file, args) => {
      if (file === '/usr/local/bin/node') return { stdout: 'v24.18.1\n' };
      if (file === '/usr/bin/curl' && args.includes('--output')) {
        const output = args[args.indexOf('--output') + 1];
        await writeFile(output, output.endsWith('SHASUMS256.txt')
          ? `${'c'.repeat(64)}  node-v24.21.0-linux-arm64.tar.xz\n`
          : 'archive');
        return { stdout: '' };
      }
      if (file === '/usr/bin/sha256sum') return { stdout: `${'d'.repeat(64)}  ${args[0]}\n` };
      if (args[0] === '--version') return { stdout: 'tool\n' };
      throw new Error('unexpected command');
    },
  });
  await assert.rejects(manager.install(22), { code: 'node_runtime_unsupported' });
  await assert.rejects(manager.install(24), { code: 'node_runtime_checksum_mismatch' });
  await assert.rejects(readFile(path.join(runtimeRoot, 'v24', 'bin', 'node')), { code: 'ENOENT' });
});
