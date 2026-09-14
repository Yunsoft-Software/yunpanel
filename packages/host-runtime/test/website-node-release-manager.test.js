import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createApplicationIdentity } from '../src/application-identity.js';
import {
  createWebsiteNodeReleaseManager,
  WebsiteNodeReleaseError,
  websiteNodeReleaseInternals,
} from '../src/website-node-release-manager.js';

const APPLICATION_ID = '8d3de1c5-a95d-4df6-9c0c-39997ed57d60';
const DEPLOYMENT_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const PREVIOUS_RELEASE_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const USER_UID = 1201;
const USER_GID = 1201;
const COMMIT_SHA = 'a'.repeat(40);

function enoent() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

function fakeStat({ type, uid = USER_UID, gid = USER_GID, mode = 0o750, mtimeMs = 1 } = {}) {
  return {
    uid,
    gid,
    mode,
    mtimeMs,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink',
  };
}

function createHarness({ previousReleaseId = null } = {}) {
  const identity = createApplicationIdentity(APPLICATION_ID);
  const directories = new Map();
  const files = new Map();
  const symlinks = new Map();
  const calls = [];
  let gitCheckoutCount = 0;

  directories.set(identity.paths.workspace.homeDirectory, fakeStat({ type: 'directory', mode: 0o750 }));
  if (previousReleaseId) {
    const previousPath = path.posix.join(identity.paths.runtime.releasesDirectory, previousReleaseId);
    directories.set(identity.paths.runtime.applicationRoot, fakeStat({ type: 'directory', uid: 0, gid: 0, mode: 0o755 }));
    directories.set(identity.paths.runtime.releasesDirectory, fakeStat({ type: 'directory', uid: 0, gid: 0, mode: 0o755 }));
    directories.set(previousPath, fakeStat({ type: 'directory', mode: 0o750, mtimeMs: 5 }));
    symlinks.set(identity.paths.runtime.currentRelease, path.posix.join('releases', previousReleaseId));
  }

  function deleteTree(target) {
    files.delete(target);
    symlinks.delete(target);
    directories.delete(target);
    for (const key of [...files.keys()]) if (key.startsWith(`${target}/`)) files.delete(key);
    for (const key of [...symlinks.keys()]) if (key.startsWith(`${target}/`)) symlinks.delete(key);
    for (const key of [...directories.keys()]) if (key.startsWith(`${target}/`)) directories.delete(key);
  }

  async function lstatFn(target) {
    if (directories.has(target)) return directories.get(target);
    if (files.has(target)) return fakeStat({ type: 'file', mode: files.get(target).mode ?? 0o644 });
    if (symlinks.has(target)) return fakeStat({ type: 'symlink', mode: 0o777 });
    throw enoent();
  }

  async function realpathFn(target) {
    if (directories.has(target) || files.has(target)) return target;
    throw enoent();
  }

  async function readlinkFn(target) {
    if (!symlinks.has(target)) throw enoent();
    return symlinks.get(target);
  }

  async function mkdirFn(target, options = {}) {
    directories.set(target, fakeStat({
      type: 'directory',
      uid: 0,
      gid: 0,
      mode: options.mode ?? 0o755,
    }));
  }

  async function readFileFn(target) {
    if (!files.has(target)) throw enoent();
    return files.get(target).content;
  }

  async function writeFileFn(target, content, options = {}) {
    if (options.flag === 'wx' && files.has(target)) {
      const error = new Error('exists');
      error.code = 'EEXIST';
      throw error;
    }
    files.set(target, { content, mode: options.mode ?? 0o600 });
  }

  async function renameFn(from, to) {
    if (files.has(from)) {
      files.set(to, files.get(from));
      files.delete(from);
      return;
    }
    if (symlinks.has(from)) {
      symlinks.set(to, symlinks.get(from));
      symlinks.delete(from);
      return;
    }
    throw enoent();
  }

  async function rmFn(target, options = {}) {
    if (options.recursive) deleteTree(target);
    else {
      files.delete(target);
      symlinks.delete(target);
      directories.delete(target);
    }
  }

  async function symlinkFn(target, linkPath) {
    symlinks.set(linkPath, target);
  }

  async function readdirFn(target) {
    if (!directories.has(target)) throw enoent();
    const prefix = `${target}/`;
    const names = [...directories.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
      .map((candidate) => path.posix.basename(candidate));
    return names.map((name) => ({ name, isDirectory: () => true }));
  }

  async function run(file, args, options = {}) {
    calls.push({ file, args: [...args], cwd: options.cwd ?? null, env: options.env ?? null });
    if (file.endsWith('/node') && args[0] === '--version') return { stdout: 'v24.11.0\n', stderr: '' };
    if ((file.endsWith('/npm') || file.endsWith('/pnpm') || file.endsWith('/yarn')) && args[0] === '--version') {
      return { stdout: '10.9.0\n', stderr: '' };
    }
    if (file === websiteNodeReleaseInternals.paths.INSTALL_PATH) {
      const target = args.at(-1);
      const ownerIndex = args.indexOf('-o');
      const groupIndex = args.indexOf('-g');
      const modeIndex = args.indexOf('-m');
      const owner = ownerIndex >= 0 ? args[ownerIndex + 1] : 'root';
      const group = groupIndex >= 0 ? args[groupIndex + 1] : 'root';
      const mode = modeIndex >= 0 ? Number.parseInt(args[modeIndex + 1], 8) : 0o755;
      directories.set(target, fakeStat({
        type: 'directory',
        uid: owner === identity.unixUser ? USER_UID : 0,
        gid: group === identity.unixUser ? USER_GID : 0,
        mode,
        mtimeMs: target.endsWith(DEPLOYMENT_ID) ? 10 : 1,
      }));
      return { stdout: '', stderr: '' };
    }
    if (file === websiteNodeReleaseInternals.paths.CHOWN_PATH) return { stdout: '', stderr: '' };
    if (file === websiteNodeReleaseInternals.paths.RUNUSER_PATH) {
      assert.equal(args[0], '-u');
      assert.equal(args[1], identity.unixUser);
      assert.equal(args[2], '--');
      const executable = args[3];
      const command = args.slice(4);
      if (executable === websiteNodeReleaseInternals.paths.GIT_PATH) {
        if (command[0] === 'init') {
          directories.set(path.posix.join(options.cwd, '.git'), fakeStat({ type: 'directory', mode: 0o750 }));
          return { stdout: '', stderr: '' };
        }
        if (command[0] === 'rev-parse') return { stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (command[0] === 'checkout') {
          gitCheckoutCount += 1;
          files.set(path.posix.join(options.cwd, 'server.js'), { content: 'console.log("ok")\n', mode: 0o644 });
          files.set(path.posix.join(options.cwd, 'package.json'), { content: '{}\n', mode: 0o644 });
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
      if (executable.endsWith('/npm') || executable.endsWith('/pnpm') || executable.endsWith('/yarn')) {
        return { stdout: '', stderr: '' };
      }
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  }

  const manager = createWebsiteNodeReleaseManager({
    websiteIdentityManager: {
      inspect: async ({ user, homeDirectory }) => ({
        satisfied: true,
        user,
        uid: USER_UID,
        gid: USER_GID,
        homeDirectory,
        shell: '/usr/sbin/nologin',
        homeMode: 0o750,
      }),
    },
    run,
    lstatFn,
    mkdirFn,
    readFileFn,
    readlinkFn,
    realpathFn,
    readdirFn,
    renameFn,
    rmFn,
    symlinkFn,
    writeFileFn,
  });

  return {
    manager,
    identity,
    calls,
    directories,
    files,
    symlinks,
    gitCheckoutCount: () => gitCheckoutCount,
  };
}

function releaseSpec(deploymentId = DEPLOYMENT_ID) {
  return {
    applicationId: APPLICATION_ID,
    deploymentId,
    repositoryUrl: 'https://github.com/example/passenger-node',
    branch: 'main',
    runtime: {
      nodeMajor: 24,
      packageManager: 'npm',
      installMode: 'ci',
      buildScript: null,
      mode: 'production',
      documentRoot: '.',
      startMode: 'node',
      entryFile: 'server.js',
      healthPath: '/healthz',
    },
    retention: 5,
  };
}

test('prepares a Passenger Node release without creating a systemd service or localhost process', async () => {
  const harness = createHarness();
  const result = await harness.manager.prepare(releaseSpec());

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'passenger-release');
  assert.equal(result.releaseId, DEPLOYMENT_ID);
  assert.equal(result.previousReleaseId, null);
  assert.equal(result.commitSha, COMMIT_SHA);
  assert.equal(result.unixUser, harness.identity.unixUser);
  assert.equal(result.currentRelease, harness.identity.paths.runtime.currentRelease);
  assert.equal(
    harness.symlinks.get(harness.identity.paths.runtime.currentRelease),
    path.posix.join('releases', DEPLOYMENT_ID),
  );
  assert.equal(harness.gitCheckoutCount(), 1);
  assert.equal(harness.calls.some((call) => call.file.includes('systemctl')), false);
  assert.equal(harness.calls.some((call) => call.file.includes('useradd')), false);
  assert.equal(harness.calls.some((call) => call.file.includes('/etc/systemd')), false);
  assert.equal(harness.calls.some((call) => call.args.some((arg) => String(arg).includes('127.0.0.1:'))), false);

  const retried = await harness.manager.prepare(releaseSpec());
  assert.equal(retried.satisfied, true);
  assert.equal(retried.releaseId, DEPLOYMENT_ID);
  assert.equal(harness.gitCheckoutCount(), 1);

  const compensated = await harness.manager.compensate({
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    previousReleaseId: null,
  });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.restoredPrevious, false);
  assert.equal(harness.symlinks.has(harness.identity.paths.runtime.currentRelease), false);
  assert.equal(
    harness.directories.has(path.posix.join(harness.identity.paths.runtime.releasesDirectory, DEPLOYMENT_ID)),
    false,
  );
});

test('compensation restores the exact previous Passenger release', async () => {
  const harness = createHarness({ previousReleaseId: PREVIOUS_RELEASE_ID });
  const prepared = await harness.manager.prepare(releaseSpec());
  assert.equal(prepared.satisfied, true);
  assert.equal(prepared.previousReleaseId, PREVIOUS_RELEASE_ID);

  const compensated = await harness.manager.compensate({
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    previousReleaseId: PREVIOUS_RELEASE_ID,
  });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.restoredPrevious, true);
  assert.equal(compensated.currentReleaseId, PREVIOUS_RELEASE_ID);
  assert.equal(
    harness.symlinks.get(harness.identity.paths.runtime.currentRelease),
    path.posix.join('releases', PREVIOUS_RELEASE_ID),
  );
});

test('Passenger release specs reject ports and npm-script startup mode', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.manager.prepare({
      ...releaseSpec(),
      runtime: { ...releaseSpec().runtime, port: 3100 },
    }),
    (error) => error instanceof WebsiteNodeReleaseError && error.code === 'website_node_release_invalid',
  );
  await assert.rejects(
    harness.manager.prepare({
      ...releaseSpec(),
      runtime: {
        ...releaseSpec().runtime,
        startMode: 'npm',
        startScript: 'start',
        entryFile: undefined,
      },
    }),
    (error) => error instanceof WebsiteNodeReleaseError && error.code === 'website_node_release_start_mode_unsupported',
  );
});
