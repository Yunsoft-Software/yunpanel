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
  let failActiveReceiptWrites = 0;

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
    if (failActiveReceiptWrites && target.startsWith(websiteNodeReleaseInternals.paths.RECEIPT_ROOT)) {
      const receipt = JSON.parse(content);
      if (receipt.state === 'active') {
        failActiveReceiptWrites -= 1;
        throw Object.assign(new Error('receipt persistence failed'), { code: 'ENOSPC' });
      }
    }
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
    failNextActiveReceiptWrite: () => { failActiveReceiptWrites = 1; },
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

test('daily release preparation preserves the active pointer until explicit verified publication', async () => {
  const h = createHarness({ previousReleaseId: PREVIOUS_RELEASE_ID });
  const spec = releaseSpec();
  const prepared = await h.manager.prepare(spec, { activate: false });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.receiptState, 'prepared');
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${PREVIOUS_RELEASE_ID}`);
  assert.equal((await h.manager.inspectDeployment(spec)).satisfied, false);
  await h.manager.prepare(spec, { activate: false });
  assert.equal(h.gitCheckoutCount(), 1);
  await assert.rejects(h.manager.publishPrepared(spec, { expectedPreviousReleaseId: null }), error => error.code === 'website_node_release_receipt_conflict');
  const published = await h.manager.publishPrepared(spec, { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID });
  assert.equal(published.releaseId, DEPLOYMENT_ID);
  assert.equal(published.previousReleaseId, PREVIOUS_RELEASE_ID);
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${DEPLOYMENT_ID}`);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, PREVIOUS_RELEASE_ID)), true);
  assert.deepEqual(await h.manager.publishPrepared(spec, { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID }), published);
});

test('prepared release publication refuses a changed current pointer or startup file', async () => {
  const h = createHarness({ previousReleaseId: PREVIOUS_RELEASE_ID });
  const spec = releaseSpec(); await h.manager.prepare(spec, { activate: false });
  const other = '12345678-1234-4234-8234-123456789012';
  h.symlinks.set(h.identity.paths.runtime.currentRelease, `releases/${other}`);
  await assert.rejects(h.manager.publishPrepared(spec, { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID }), error => error.code === 'website_node_release_state_drift');
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${other}`);
  h.symlinks.set(h.identity.paths.runtime.currentRelease, `releases/${PREVIOUS_RELEASE_ID}`);
  h.files.delete(path.posix.join(h.identity.paths.runtime.releasesDirectory, DEPLOYMENT_ID, 'server.js'));
  await assert.rejects(h.manager.publishPrepared(spec, { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID }), error => error.code === 'website_node_release_not_prepared');
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${PREVIOUS_RELEASE_ID}`);
});

test('retention is deferred until explicit finalization and preserves an unowned UUID directory', async () => {
  const h = createHarness();
  const old = releaseSpec(PREVIOUS_RELEASE_ID); await h.manager.prepare(old);
  const middleId = '12345678-1234-4234-8234-123456789012';
  await h.manager.prepare(releaseSpec(middleId), { activate: false });
  await h.manager.publishPrepared(releaseSpec(middleId), { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID });
  const current = { ...releaseSpec(), retention: 2 };
  await h.manager.prepare(current, { activate: false });
  await assert.rejects(h.manager.finalizeRetention(current), error => error.code === 'website_node_release_retention_unverified');
  await h.manager.publishPrepared(current, { expectedPreviousReleaseId: middleId });
  const root = h.identity.paths.runtime.releasesDirectory;
  const unknown = path.posix.join(root, '22222222-2222-4222-8222-222222222222');
  h.directories.set(unknown, fakeStat({ type: 'directory', uid: 0, gid: 0 }));
  assert.equal(h.directories.has(path.posix.join(root, PREVIOUS_RELEASE_ID)), true);
  await h.manager.finalizeRetention(current);
  assert.equal(h.directories.has(path.posix.join(root, PREVIOUS_RELEASE_ID)), false);
  assert.equal(h.directories.has(path.posix.join(root, middleId)), true);
  assert.equal(h.directories.has(path.posix.join(root, DEPLOYMENT_ID)), true);
  assert.equal(h.directories.has(unknown), true);
});

test('ordinary retained rollback preserves both releases and their published receipts', async () => {
  const h = createHarness();
  await h.manager.prepare(releaseSpec(PREVIOUS_RELEASE_ID));
  await h.manager.prepare(releaseSpec(), { activate: false });
  await h.manager.publishPrepared(releaseSpec(), { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID });
  const target = { applicationId: APPLICATION_ID, releaseId: PREVIOUS_RELEASE_ID, commitSha: COMMIT_SHA, runtime: releaseSpec().runtime };
  const switched = await h.manager.switchRetainedRelease({ ...target, currentReleaseId: DEPLOYMENT_ID, operationId: '12345678-1234-4234-8234-123456789012' });
  assert.equal(switched.currentReleaseId, PREVIOUS_RELEASE_ID);
  assert.equal(switched.previousReleaseId, DEPLOYMENT_ID);
  assert.equal((await h.manager.inspectRetainedRelease({ ...target, releaseId: DEPLOYMENT_ID })).satisfied, true);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, DEPLOYMENT_ID)), true);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, PREVIOUS_RELEASE_ID)), true);
  assert.equal(h.gitCheckoutCount(), 2);
  await assert.rejects(h.manager.switchRetainedRelease({ ...target, currentReleaseId: DEPLOYMENT_ID, operationId: '12345678-1234-4234-8234-123456789012' }), error => error.code === 'website_node_release_state_drift');
});

test('retained inspection denies foreign application and commit drift before pointer mutation', async () => {
  const h = createHarness(); await h.manager.prepare(releaseSpec());
  const target = { applicationId: APPLICATION_ID, releaseId: DEPLOYMENT_ID, commitSha: COMMIT_SHA, runtime: releaseSpec().runtime };
  await assert.rejects(h.manager.inspectRetainedRelease({ ...target, applicationId: '12345678-1234-4234-8234-123456789012' }), error => error.code === 'website_node_retained_receipt_mismatch');
  await assert.rejects(h.manager.inspectRetainedRelease({ ...target, commitSha: 'b'.repeat(40) }), error => error.code === 'website_node_retained_receipt_mismatch');
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${DEPLOYMENT_ID}`);
});

test('discard removes only the operation candidate after the previous pointer is restored', async () => {
  const h = createHarness(); await h.manager.prepare(releaseSpec(PREVIOUS_RELEASE_ID));
  await h.manager.prepare(releaseSpec(), { activate: false });
  const target = { applicationId: APPLICATION_ID, deploymentId: DEPLOYMENT_ID, previousReleaseId: PREVIOUS_RELEASE_ID };
  assert.equal((await h.manager.discardOperationRelease(target)).discarded, true);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, PREVIOUS_RELEASE_ID)), true);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, DEPLOYMENT_ID)), false);
  assert.equal((await h.manager.discardOperationRelease(target)).satisfied, true);
  await assert.rejects(h.manager.prepare(releaseSpec(), { activate: false }), error => error.code === 'website_node_release_operation_compensated');
});

test('a lost publication receipt write retains inspectable files and repairs only that same publication', async () => {
  const h = createHarness();
  await h.manager.prepare(releaseSpec(PREVIOUS_RELEASE_ID));
  const spec = releaseSpec(); await h.manager.prepare(spec, { activate: false });
  h.failNextActiveReceiptWrite();
  await assert.rejects(h.manager.publishPrepared(spec, { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID }), error => error.code === 'ENOSPC');
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${DEPLOYMENT_ID}`);
  assert.equal((await h.manager.inspectDeployment(spec)).receiptState, 'prepared');
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, PREVIOUS_RELEASE_ID)), true);
  const repaired = await h.manager.publishPrepared(spec, { expectedPreviousReleaseId: PREVIOUS_RELEASE_ID });
  assert.equal(repaired.receiptState, 'active'); assert.equal(h.gitCheckoutCount(), 2);
});

test('an originally empty previous pointer remains immutable when another current release appears', async () => {
  const h = createHarness(); const spec = releaseSpec();
  await h.manager.prepare(spec, { activate: false });
  h.symlinks.set(h.identity.paths.runtime.currentRelease, `releases/${PREVIOUS_RELEASE_ID}`);
  await assert.rejects(h.manager.prepare(spec, { activate: false }), error => error.code === 'website_node_release_state_drift');
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${PREVIOUS_RELEASE_ID}`);
  assert.equal(h.gitCheckoutCount(), 1);
});

test('a receipt copied from another release cannot authorize retained publication or candidate removal', async () => {
  const h = createHarness(); await h.manager.prepare(releaseSpec(PREVIOUS_RELEASE_ID));
  await h.manager.prepare(releaseSpec(), { activate: false });
  const receiptPath = id => path.posix.join(websiteNodeReleaseInternals.paths.RECEIPT_ROOT, `${id}.json`);
  h.files.set(receiptPath(DEPLOYMENT_ID), { ...h.files.get(receiptPath(PREVIOUS_RELEASE_ID)) });
  const target = { applicationId: APPLICATION_ID, releaseId: DEPLOYMENT_ID, commitSha: COMMIT_SHA, runtime: releaseSpec().runtime };
  await assert.rejects(h.manager.inspectRetainedRelease(target), error => error.code === 'website_node_release_receipt_conflict');
  await assert.rejects(h.manager.switchRetainedRelease({ ...target, currentReleaseId: PREVIOUS_RELEASE_ID, operationId: '12345678-1234-4234-8234-123456789012' }), error => error.code === 'website_node_release_receipt_conflict');
  await assert.rejects(h.manager.discardOperationRelease({ applicationId: APPLICATION_ID, deploymentId: DEPLOYMENT_ID, previousReleaseId: PREVIOUS_RELEASE_ID }), error => error.code === 'website_node_release_receipt_conflict');
  assert.equal(h.symlinks.get(h.identity.paths.runtime.currentRelease), `releases/${PREVIOUS_RELEASE_ID}`);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, DEPLOYMENT_ID)), true);
});

test('retention leaves a wrongly filed published receipt directory untouched', async () => {
  const h = createHarness(); await h.manager.prepare(releaseSpec(PREVIOUS_RELEASE_ID));
  await h.manager.prepare(releaseSpec());
  const third = '12345678-1234-4234-8234-123456789012';
  await h.manager.prepare(releaseSpec(third));
  const fourth = { ...releaseSpec('33333333-3333-4333-8333-333333333333'), retention: 2 };
  await h.manager.prepare(fourth, { activate: false });
  await h.manager.publishPrepared(fourth, { expectedPreviousReleaseId: third });
  const receiptPath = id => path.posix.join(websiteNodeReleaseInternals.paths.RECEIPT_ROOT, `${id}.json`);
  h.files.set(receiptPath(DEPLOYMENT_ID), { ...h.files.get(receiptPath(PREVIOUS_RELEASE_ID)) });
  await h.manager.finalizeRetention(fourth);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, DEPLOYMENT_ID)), true);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, third)), true);
  assert.equal(h.directories.has(path.posix.join(h.identity.paths.runtime.releasesDirectory, fourth.deploymentId)), true);
});

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
