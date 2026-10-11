import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  const apps = path.join(root, 'apps'), env = path.join(root, 'env'), include = path.join(root, 'passenger'), registry = path.join(root, 'passenger-instances'), proc = path.join(root,'proc');
  const release = path.join(apps, application.id, 'releases', application.currentReleaseId);
  await mkdir(release, { recursive: true }); await mkdir(env, { mode: 0o700 }); await mkdir(include, { mode: 0o700 });
  await mkdir(registry, { mode: 0o700 });
  await mkdir(proc, { mode: 0o700 });
  await symlink(`releases/${application.currentReleaseId}`, path.join(apps, application.id, 'current'));
  const target = path.join(passenger ? include : env, application.id + (passenger ? '.conf' : '.env'));
  const render = values => passenger ? websitePassengerEnvironmentInternals.normalizeSpec({ applicationId: application.id, environmentRevision: 4, values }).content
    : (type === 'node' ? renderNodeEnvironmentFile : renderPythonEnvironmentFile)({ applicationId: application.id, runtime: application.runtime, environment: values });
  await writeFile(target, render({ SERVICE_SECRET: 'actually running saved value' }), { mode: 0o600 });
  const sibling = path.join(passenger ? include : env, randomUUID() + '.untouched');
  await writeFile(sibling, 'sibling private bytes', { mode: 0o600 });
  const calls = [];
  const manager = createApplicationEnvironmentBackupManager({ applicationRoot: apps, environmentRoot: env, passengerRoot: include, processRoot:proc,
    ownerUid: process.getuid(), ownerGid: process.getgid(), run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === '/usr/sbin/nginx' && args[0] === '-T') return { stdout: `passenger_instance_registry_dir ${registry};\n` };
      if (file === '/usr/bin/getent') return {stdout:`yunapp-123456abcdef:x:${process.getuid()||1001}:1001:Fixture:/owned/home:/bin/bash\n`};
      return { stdout: args[0] === 'show' ? 'LoadState=loaded\nActiveState=active\nMainPID=1234\n' : '' };
    } });
  return { application, manager, target, render, sibling, calls, registry, proc, release };
}

test('Passenger process inspection reads real private process files and rejects changed values or a foreign release before claiming applied',async t=>{
 const f=await fixture(t,'node',true),processDirectory=path.join(f.proc,'1234');
 await mkdir(processDirectory);
 if(process.getuid()===0)await chown(processDirectory,1001,1001);
 await symlink('/managed/runtime/bin/node',path.join(processDirectory,'exe'));
 await symlink(f.release,path.join(processDirectory,'cwd'));
 const environment=path.join(processDirectory,'environ');
 await writeFile(environment,'SERVICE_SECRET=actually running saved value\0UNRELATED=kept\0',{mode:0o600});
 const input={application:f.application,unixUser:'yunapp-123456abcdef',values:{SERVICE_SECRET:'actually running saved value'},environmentRevision:4,verifyHealth:async()=>true};
 const proof=await f.manager.inspectAppliedPassengerEnvironment(input);assert.equal(proof.verified,true);assert.equal(proof.processes,1);
 assert.doesNotMatch(JSON.stringify(proof),/saved value|UNRELATED/);
 await writeFile(environment,'SERVICE_SECRET=wrong running value\0');
 await assert.rejects(f.manager.inspectAppliedPassengerEnvironment(input),{code:'application_environment_process_unverified'});
 await writeFile(environment,'SERVICE_SECRET=actually running saved value\0');
 await rm(path.join(processDirectory,'cwd'));await symlink(path.dirname(f.release),path.join(processDirectory,'cwd'));
 await assert.rejects(f.manager.inspectAppliedPassengerEnvironment(input),{code:'application_environment_process_unverified'});
 await assert.rejects(f.manager.inspectAppliedPassengerEnvironment({...input,unixUser:'root'}),{code:'application_environment_process_scope_invalid'});
});

test('Passenger restart applies desired private values with the current revision instead of replaying the previous snapshot',async t=>{
 const f=await fixture(t,'node',true),before=await readFile(f.target,'utf8');
 const result=await f.manager.applyEnvironment({application:f.application,values:{SERVICE_SECRET:'new controlled private value'},environmentRevision:8,verifyHealth:async()=>true});
 const actual=await readFile(f.target,'utf8');assert.notEqual(actual,before);assert.match(actual,/revision 8\n/);assert.match(actual,/new controlled private value/);
 assert.equal(result.appliedMatchesSaved,true);assert.equal(result.verified,true);assert.equal(await readFile(f.sibling,'utf8'),'sibling private bytes');
 assert.doesNotMatch(JSON.stringify(f.calls),/private value/);
 const restart=f.calls.find(call=>call.args[0]==='restart-app');
 assert.equal(restart.options.env.PASSENGER_INSTANCE_REGISTRY_DIR,f.registry);
 assert.equal(restart.args.includes('--ignore-app-not-running'),false);
});
test('Passenger restore rebases applied metadata to the restored catalog and allows fresh pinned process inspection',async t=>{
 const f=await fixture(t,'node',true),snapshot=await f.manager.captureEnvironment({application:f.application});
 const revision=1791669300619,values={SERVICE_SECRET:'actually running saved value'},processDirectory=path.join(f.proc,'4321');
 await mkdir(processDirectory);if(process.getuid()===0)await chown(processDirectory,1001,1001);
 await symlink('/managed/runtime/bin/node',path.join(processDirectory,'exe'));await symlink(f.release,path.join(processDirectory,'cwd'));
 await writeFile(path.join(processDirectory,'environ'),'SERVICE_SECRET=actually running saved value\0');
 await writeFile(f.target,f.render({SERVICE_SECRET:'changed running value'}));
 const restored=await f.manager.restoreEnvironment({application:f.application,values,savedRuntime:snapshot,
  environmentRevision:revision,verifyHealth:async()=>true});
 assert.equal(restored.appliedMatchesSaved,true);
 assert.match(await readFile(f.target,'utf8'),new RegExp('revision '+revision+'\\n'));
 const proof=await f.manager.inspectAppliedPassengerEnvironment({application:f.application,unixUser:'yunapp-123456abcdef',
  values,environmentRevision:revision,verifyHealth:async()=>true});
 assert.equal(proof.verified,true);assert.equal(proof.environmentRevision,revision);assert.equal(proof.processes,1);
});
test('a failed Passenger environment apply restores the original private include and checks the restored runtime',async t=>{
 const f=await fixture(t,'node',true),before=await readFile(f.target,'utf8');let checks=0;
 await assert.rejects(f.manager.applyEnvironment({application:f.application,values:{SERVICE_SECRET:'changed'},environmentRevision:8,verifyHealth:async()=>++checks!==2}),{code:'application_environment_restore_unverified'});
 assert.equal(await readFile(f.target,'utf8'),before);assert.equal(checks,4);
});
test('a site-writable Passenger instance registry blocks restart and never sends its path to the privileged CLI',async t=>{
 const f=await fixture(t,'node',true),before=await readFile(f.target,'utf8');
 await chmod(f.registry,0o777);
 await assert.rejects(f.manager.applyEnvironment({application:f.application,values:{SERVICE_SECRET:'changed'},environmentRevision:8,verifyHealth:async()=>true}),{code:'application_environment_instance_registry_unavailable'});
 assert.equal(await readFile(f.target,'utf8'),before);
 assert.equal(f.calls.some(call=>call.args[0]==='restart-app'),false);
});
for (const [name, type, passenger] of [['systemd Node', 'node', false], ['Passenger Node', 'node', true], ['Python', 'python', false]]) {
  test(`${name} restores actual private file bytes, restarts only its runtime and leaves siblings unchanged`, async t => {
    const f = await fixture(t, type, passenger), snapshot = await f.manager.captureEnvironment({ application: f.application });
    await writeFile(f.target, f.render({ SERVICE_SECRET: 'new running value' }));
    const result = await f.manager.restoreEnvironment({ application: f.application, savedRuntime: snapshot,
      values: { SERVICE_SECRET: 'actually running saved value' }, environmentRevision: 9, verifyHealth: async () => true });
    const expected = passenger ? websitePassengerEnvironmentInternals.normalizeSpec({ applicationId: f.application.id,
      environmentRevision: 9, values: { SERVICE_SECRET: 'actually running saved value' } }).content : snapshot.content;
    assert.equal(await readFile(f.target, 'utf8'), expected);
    assert.equal(await readFile(f.sibling, 'utf8'), 'sibling private bytes');
    assert.equal(result.verified, true); assert.equal(result.appliedMatchesSaved, true);
    assert.doesNotMatch(JSON.stringify(f.calls), /saved value|new running value/);
    const restart = f.calls.find(call => call.args[0] === (passenger ? 'restart-app' : 'restart'));
    if (passenger) { assert.ok(restart.args[1].includes(f.application.id)); assert.ok(restart.args[1].endsWith('/')); }
    else assert.equal(restart.args[1], type === 'python' ? pythonServiceName(f.application.id) : nodeServiceName(f.application.id));
  });
}
test('restoring a saved but unapplied draft does not claim its values reached the process', async t => {
  for (const passenger of [false, true]) {
    const f = await fixture(t, 'node', passenger), snapshot = await f.manager.captureEnvironment({ application: f.application });
    const result = await f.manager.restoreEnvironment({ application: f.application, savedRuntime: snapshot,
      values: { SERVICE_SECRET: 'saved draft never applied' }, environmentRevision: 10, verifyHealth: async () => true });
    assert.equal(result.appliedMatchesSaved, false);
    assert.equal(await readFile(f.target, 'utf8'), snapshot.content);
  }
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

test('Captured Passenger baseline exposes private running revision independently of a newer saved draft and refuses a foreign release',async t=>{
 const f=await fixture(t,'node',true),snapshot=await f.manager.captureEnvironment({application:f.application});
 const baseline=f.manager.capturedPassengerEnvironment({application:f.application,savedRuntime:snapshot});
 assert.equal(baseline.environmentRevision,4);assert.equal(baseline.values.SERVICE_SECRET,'actually running saved value');
 assert.throws(()=>f.manager.capturedPassengerEnvironment({application:f.application,savedRuntime:{...snapshot,releaseId:randomUUID()}}),{code:'application_environment_runtime_drift'});
 assert.throws(()=>f.manager.capturedPassengerEnvironment({application:f.application,savedRuntime:{...snapshot,content:snapshot.content.replace('revision 4','revision invalid')}}),{code:'application_environment_snapshot_invalid'});
});

test('Passenger applied proof rejects a removed managed key in the real process environment while allowing unrelated process defaults',async t=>{
 const f=await fixture(t,'node',true),directory=path.join(f.proc,'1234');await mkdir(directory);
 if(process.getuid()===0)await chown(directory,1001,1001);
 await symlink('/managed/runtime/bin/node',path.join(directory,'exe'));await symlink(f.release,path.join(directory,'cwd'));
 await writeFile(f.target,websitePassengerEnvironmentInternals.normalizeSpec({applicationId:f.application.id,environmentRevision:4,values:{}}).content,{mode:0o600});
 const file=path.join(directory,'environ');await writeFile(file,'SERVICE_SECRET=obsolete private value\0PATH=/usr/bin\0',{mode:0o600});
 const input={application:f.application,unixUser:'yunapp-123456abcdef',values:{},environmentRevision:4,absentKeys:['SERVICE_SECRET'],verifyHealth:async()=>true};
 await assert.rejects(f.manager.inspectAppliedPassengerEnvironment(input),{code:'application_environment_process_unverified'});
 await writeFile(file,'PATH=/usr/bin\0',{mode:0o600});assert.equal((await f.manager.inspectAppliedPassengerEnvironment(input)).verified,true);
});
test('Expected-current environment CAS refuses a foreign private include before restore and preserves an existing temporary artifact',async t=>{
 const f=await fixture(t,'node',true),snapshot=await f.manager.captureEnvironment({application:f.application}),before=snapshot.content;
 const foreign=websitePassengerEnvironmentInternals.normalizeSpec({applicationId:f.application.id,environmentRevision:123,values:{FOREIGN_VALUE:'unrelated native change'}}).content;
 await writeFile(f.target,foreign,{mode:0o600});
 await assert.rejects(f.manager.restoreEnvironment({application:f.application,values:{SERVICE_SECRET:'actually running saved value'},savedRuntime:snapshot,
  environmentRevision:4,verifyHealth:async()=>true,expectedCurrentContent:before}),{code:'application_environment_restore_state_drift'});
 assert.equal(await readFile(f.target,'utf8'),foreign);assert.equal(f.calls.length,1);
 const temporary=f.target+`.${process.pid}.restore.tmp`;await writeFile(temporary,'requires inspection',{mode:0o600});
 await assert.rejects(f.manager.restoreEnvironment({application:f.application,values:{},savedRuntime:snapshot,environmentRevision:4,
  verifyHealth:async()=>true,expectedCurrentContent:foreign}));
 assert.equal(await readFile(temporary,'utf8'),'requires inspection');
});
