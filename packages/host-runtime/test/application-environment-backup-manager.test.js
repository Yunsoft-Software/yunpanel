import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplicationEnvironmentBackupManager } from '../src/application-environment-backup-manager.js';
import { websitePassengerEnvironmentInternals } from '../src/website-passenger-environment-manager.js';
import { nodeServiceName, pythonServiceName, renderNodeEnvironmentFile, renderPythonEnvironmentFile } from '@yunpanel/config-templates';

async function fixture(t, type = 'node', passenger = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yp-running-env-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const application = { id: randomUUID(), currentReleaseId: randomUUID(), type, runtimeAdapter: type === 'node' ? passenger ? 'passenger' : 'direct-systemd' : null,
    runtime: type === 'node' ? { nodeMajor: 24, installMode: 'ci', startMode: 'node', entryFile: 'server.js', port: 3100, healthPath: '/health', healthTimeoutSeconds: 10, restartPolicy: 'on-failure' }
      : { pythonVersion: '3.12', appServer: 'gunicorn', entryPoint: 'app:app', workers: 2, requirementsFile: 'requirements.txt', documentRoot: '.', healthPath: '/health', healthTimeoutSeconds: 10, restartPolicy: 'always', mode: 'production' } };
  const apps = path.join(root, 'apps'), env = path.join(root, 'env'), include = path.join(root, 'passenger');
  const release = path.join(apps, application.id, 'releases', application.currentReleaseId);
  await mkdir(release, { recursive: true }); await mkdir(env, { mode: 0o700 }); await mkdir(include, { mode: 0o700 });
  await symlink(`releases/${application.currentReleaseId}`, path.join(apps, application.id, 'current'));
  const target = path.join(passenger ? include : env, application.id + (passenger ? '.conf' : '.env'));
  const render = values => passenger ? websitePassengerEnvironmentInternals.normalizeSpec({ applicationId: application.id, environmentRevision: 4, values }).content
    : (type === 'node' ? renderNodeEnvironmentFile : renderPythonEnvironmentFile)({ applicationId: application.id, runtime: application.runtime, environment: values });
  await writeFile(target, render({ SERVICE_SECRET: 'actually running saved value' }), { mode: 0o600 });
  const sibling = path.join(passenger ? include : env, randomUUID() + '.untouched');
  await writeFile(sibling, 'sibling private bytes', { mode: 0o600 });
  const calls = [];
  const manager = createApplicationEnvironmentBackupManager({ applicationRoot: apps, environmentRoot: env, passengerRoot: include,
    ownerUid: process.getuid(), ownerGid: process.getgid(), run: async (file, args) => {
      calls.push({ file, args });
      return { stdout: args[0] === 'show' ? 'LoadState=loaded\nActiveState=active\nMainPID=1234\n' : '' };
    } });
  return { application, manager, target, render, sibling, calls };
}
for (const [name, type, passenger] of [['systemd Node', 'node', false], ['Passenger Node', 'node', true], ['Python', 'python', false]]) {
  test(`${name} restores actual private file bytes, restarts only its runtime and leaves siblings unchanged`, async t => {
    const f = await fixture(t, type, passenger), snapshot = await f.manager.captureEnvironment({ application: f.application });
    await writeFile(f.target, f.render({ SERVICE_SECRET: 'new running value' }));
    const result = await f.manager.restoreEnvironment({ application: f.application, savedRuntime: snapshot,
      values: { SERVICE_SECRET: 'actually running saved value' }, environmentRevision: 9, verifyHealth: async () => true });
    assert.equal(await readFile(f.target, 'utf8'), snapshot.content);
    assert.equal(await readFile(f.sibling, 'utf8'), 'sibling private bytes');
    assert.equal(result.verified, true); assert.equal(result.appliedMatchesSaved, true);
    assert.doesNotMatch(JSON.stringify(f.calls), /saved value|new running value/);
    const restart = f.calls.find(call => call.args[0] === (passenger ? 'restart-app' : 'restart'));
    if (passenger) { assert.ok(restart.args[1].includes(f.application.id)); assert.ok(restart.args[1].endsWith('/')); }
    else assert.equal(restart.args[1], type === 'python' ? pythonServiceName(f.application.id) : nodeServiceName(f.application.id));
  });
}
test('restoring a saved but unapplied draft does not claim its values reached the process', async t => {
  const f = await fixture(t), snapshot = await f.manager.captureEnvironment({ application: f.application });
  const result = await f.manager.restoreEnvironment({ application: f.application, savedRuntime: snapshot,
    values: { SERVICE_SECRET: 'saved draft never applied' }, environmentRevision: 10, verifyHealth: async () => true });
  assert.equal(result.appliedMatchesSaved, false);
  assert.match(await readFile(f.target, 'utf8'), /actually running saved value/);
});
test('an unhealthy restore puts back the previous private file and rechecks the previous process', async t => {
  const f = await fixture(t), snapshot = await f.manager.captureEnvironment({ application: f.application });
  const prior = f.render({ SERVICE_SECRET: 'before failed restore' }); await writeFile(f.target, prior);
  let healthCalls = 0;
  await assert.rejects(f.manager.restoreEnvironment({ application: f.application, savedRuntime: snapshot,
    values: {}, environmentRevision: 10, verifyHealth: async () => ++healthCalls === 2 }), { code: 'application_environment_restore_unverified' });
  assert.equal(healthCalls, 2); assert.equal(await readFile(f.target, 'utf8'), prior);
});
test('foreign identities, file symlinks, permissive modes and current-release drift are rejected before runtime commands', async t => {
  const f = await fixture(t), snapshot = await f.manager.captureEnvironment({ application: f.application });
  await assert.rejects(f.manager.assertRestoreSupported({ application: f.application, savedRuntime: { ...snapshot, applicationId: randomUUID() } }), { code: 'application_environment_runtime_drift' });
  await chmod(f.target, 0o644);
  await assert.rejects(f.manager.captureEnvironment({ application: f.application }), { code: 'application_environment_file_unsafe' });
  await rm(f.target); await symlink(f.sibling, f.target);
  await assert.rejects(f.manager.captureEnvironment({ application: f.application }), { code: 'application_environment_file_unavailable' });
  await rm(f.target); await writeFile(f.target, snapshot.content, { mode: 0o600 });
  await assert.rejects(f.manager.captureEnvironment({ application: { ...f.application, currentReleaseId: randomUUID() } }), { code: 'application_environment_release_drift' });
  assert.equal(f.calls.length, 0);
});
