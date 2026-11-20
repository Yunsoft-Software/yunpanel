import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { localMigrationBackupInternals } from '../src/local-migration-backup.js';
import { preflightLocalRecoveryBackup } from '../src/local-recovery-preflight.js';

const execFileAsync = promisify(execFile);
const sourceServerId = '4f286f93-c2bc-43b6-9e4c-850ed95fbe4a';
const otherServerId = '04b0148c-e05f-4c60-a916-320f0f0ef054';
const privateMarker = 'local-test-private-config-marker';
const cliPath = fileURLToPath(new URL('../../../scripts/local-migration-backup.mjs', import.meta.url));

async function createFixture(t, serverBinding = `YUNPANEL_LOCAL_SERVER_ID="${sourceServerId}"`) {
  const root = await mkdtemp(path.join(tmpdir(), 'yunpanel-recovery-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = path.join(root, 'tree');
  const backupDirectory = path.join(root, 'backup');
  const siblingDirectory = path.join(root, 'untouched');
  await mkdir(path.join(tree, 'etc/yunpanel/control-plane'), { recursive: true });
  await mkdir(path.join(tree, 'var/lib/yunpanel'), { recursive: true });
  await mkdir(backupDirectory, { mode: 0o700 });
  await mkdir(siblingDirectory);
  const siblingFile = path.join(siblingDirectory, 'marker');
  await writeFile(siblingFile, 'unchanged');
  await writeFile(path.join(tree, 'etc/yunpanel/control-plane/api.env'), `${serverBinding}\nPRIVATE_CONFIG=${privateMarker}\n`);
  await writeFile(path.join(tree, 'etc/passwd'), 'yunapp-example:x:1001:1001::/nonexistent:/usr/sbin/nologin\n');
  await writeFile(path.join(tree, 'etc/group'), 'yunapp-example:x:1001:\n');
  await writeFile(path.join(tree, 'var/lib/yunpanel/state.json'), '{"stored":true}\n');

  const archivePath = path.join(backupDirectory, 'state.tar');
  const manifestPath = path.join(backupDirectory, 'manifest.json');
  const required = localMigrationBackupInternals.requiredEntries;
  const members = required.filter((entry) => entry.required).map((entry) => entry.path.slice(1));
  await execFileAsync('/usr/bin/tar', ['--create', '--file', archivePath, '-C', tree, ...members]);
  await chmod(archivePath, 0o600);
  const expectedSha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  const manifest = {
    version: 1,
    createdAt: '2026-11-20T00:00:00.000Z',
    archive: 'state.tar',
    sha256: expectedSha256,
    entries: required.map(({ path: entryPath, type, required: present }) => ({ path: entryPath, type, present })),
  };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return {
    root, archivePath, manifestPath, manifest, siblingFile,
    options: { backupDirectory, expectedSha256, expectedServerId: sourceServerId },
  };
}

function cliArguments({ backupDirectory, expectedSha256, expectedServerId }) {
  return [cliPath, 'preflight', backupDirectory, '--expected-sha256', expectedSha256, '--expected-server-id', expectedServerId];
}

test('a real snapshot preflight succeeds without staging or logging config values', async (t) => {
  const fixture = await createFixture(t);
  const archiveBefore = await readFile(fixture.archivePath);
  const manifestBefore = await readFile(fixture.manifestPath);
  const directoryBefore = await readdir(fixture.root);
  const { stdout, stderr } = await execFileAsync(process.execPath, cliArguments(fixture.options));
  assert.deepEqual(JSON.parse(stdout), {
    action: 'preflight',
    verified: true,
    manifestVersion: 1,
    serverBindingMatches: true,
    presentSources: 4,
    liveMutation: false,
  });
  assert.equal(stderr, '');
  assert.equal(stdout.includes(sourceServerId), false);
  assert.equal(stdout.includes(privateMarker), false);
  assert.equal(stdout.includes(fixture.root), false);
  assert.deepEqual(await readFile(fixture.archivePath), archiveBefore);
  assert.deepEqual(await readFile(fixture.manifestPath), manifestBefore);
  assert.deepEqual(await readdir(fixture.root), directoryBefore);
  assert.equal(await readFile(fixture.siblingFile, 'utf8'), 'unchanged');
});

test('preflight rejects even a valid archive and manifest when the recorded digest or source differs', async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(preflightLocalRecoveryBackup({ ...fixture.options, expectedSha256: '0'.repeat(64) }), {
    code: 'recovery_snapshot_hash_mismatch',
  });
  await assert.rejects(preflightLocalRecoveryBackup({ ...fixture.options, expectedServerId: otherServerId }), {
    code: 'recovery_snapshot_binding_mismatch',
  });
});

test('preflight rejects malformed or ambiguous archived server bindings', async (t) => {
  const fixture = await createFixture(t, `YUNPANEL_LOCAL_SERVER_ID=${sourceServerId}\nYUNPANEL_LOCAL_SERVER_ID=${otherServerId}`);
  await assert.rejects(execFileAsync(process.execPath, cliArguments(fixture.options)), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /recovery_snapshot_binding_invalid/);
    assert.equal(error.stderr.includes(sourceServerId), false);
    assert.equal(error.stderr.includes(privateMarker), false);
    assert.equal(error.stderr.includes(fixture.root), false);
    return true;
  });
});

test('preflight takes the binding from an environment assignment rather than a multiline value', async (t) => {
  const fixture = await createFixture(t, `MULTILINE="first\nYUNPANEL_LOCAL_SERVER_ID=${sourceServerId}\nlast"`);
  await assert.rejects(preflightLocalRecoveryBackup(fixture.options), { code: 'recovery_snapshot_binding_invalid' });
});

test('preflight rejects unsupported manifest revision and on-disk corruption', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.manifestPath, JSON.stringify({ ...fixture.manifest, version: 2 }));
  await assert.rejects(preflightLocalRecoveryBackup(fixture.options), { code: 'migration_backup_manifest_invalid' });
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
  await appendFile(fixture.archivePath, 'changed');
  await assert.rejects(preflightLocalRecoveryBackup(fixture.options), { code: 'migration_backup_checksum_mismatch' });
});

test('preflight requires complete private snapshot files before invoking tar', async (t) => {
  const fixture = await createFixture(t);
  await chmod(fixture.manifestPath, 0o644);
  await assert.rejects(preflightLocalRecoveryBackup(fixture.options), { code: 'recovery_snapshot_not_private' });
  await rm(fixture.manifestPath);
  await assert.rejects(preflightLocalRecoveryBackup(fixture.options), { code: 'recovery_snapshot_missing' });
});

test('preflight rejects a linked archive even when its destination has the expected content', async (t) => {
  const fixture = await createFixture(t);
  const displacedArchive = path.join(fixture.root, 'displaced-state.tar');
  await rename(fixture.archivePath, displacedArchive);
  await symlink(displacedArchive, fixture.archivePath);
  await assert.rejects(preflightLocalRecoveryBackup(fixture.options), { code: 'recovery_snapshot_not_private' });
  assert.equal(createHash('sha256').update(await readFile(displacedArchive)).digest('hex'), fixture.options.expectedSha256);
});
