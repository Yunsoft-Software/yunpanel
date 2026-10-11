import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager, NginxManagerError } from '../src/nginx-manager.js';

const spec = Object.freeze({
  primaryDomain: 'example.com',
  aliases: ['www.example.com'],
  targetType: 'proxy',
  target: { upstreamHost: '127.0.0.1', upstreamPort: 3000, websocket: true },
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-nginx-compensation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, 'staging');
  const sitesDir = path.join(root, 'sites');
  await mkdir(sitesDir, { recursive: true });
  return { root, stagingDir, sitesDir };
}

function managerFor({ stagingDir, sitesDir, execFn = async () => '' }) {
  return createNginxManager({ stagingDir, sitesDir, execFn });
}

test('separate durable activation jobs can reapply an earlier checksum while retries retain their own rollback state',async t=>{
 const f=await fixture(t),activePath=path.join(f.sitesDir,'yunpanel-example.com.conf');
 const manager=managerFor(f),a=await manager.stageDomain(spec);
 await manager.activateDomain({primaryDomain:spec.primaryDomain,checksum:a.checksum});
 const aBytes=await readFile(activePath,'utf8');
 const b=await manager.stageDomain({...spec,nginxSettings:{clientMaxBodySizeMb:17}});
 await manager.activateDomain({primaryDomain:spec.primaryDomain,checksum:b.checksum,activationId:randomUUID()});
 const bBytes=await readFile(activePath,'utf8');assert.notEqual(aBytes,bBytes);
 await manager.stageDomain(spec);const activationId=randomUUID(),input={primaryDomain:spec.primaryDomain,checksum:a.checksum,activationId};
 await manager.activateDomain(input);await manager.activateDomain(input);assert.equal(await readFile(activePath,'utf8'),aBytes);
 const restarted=managerFor(f);assert.equal((await restarted.compensateDomain(input)).satisfied,true);
 assert.equal(await readFile(activePath,'utf8'),bBytes);
 await restarted.activateDomain(input);await writeFile(activePath,'foreign config drift');
 await assert.rejects(restarted.activateDomain(input),error=>error.code==='nginx_rollback_receipt_conflict');
 await assert.rejects(restarted.compensateDomain(input),error=>error.code==='nginx_compensation_drift');
 assert.equal(await readFile(activePath,'utf8'),'foreign config drift');
});

test('an invalid activation identity cannot write config or run host commands',async t=>{
 const f=await fixture(t),commands=[],manager=managerFor({...f,execFn:async(...args)=>commands.push(args)});
 const staged=await manager.stageDomain(spec);
 await assert.rejects(manager.activateDomain({primaryDomain:spec.primaryDomain,checksum:staged.checksum,activationId:'../../foreign'}),error=>error.code==='nginx_activation_identity_invalid');
 assert.deepEqual(commands,[]);await assert.rejects(readFile(path.join(f.sitesDir,'yunpanel-example.com.conf')),error=>error.code==='ENOENT');
});

test('Nginx activation survives manager restart and compensation restores the previous config', async (t) => {
  const { stagingDir, sitesDir } = await fixture(t);
  const activePath = path.join(sitesDir, 'yunpanel-example.com.conf');
  const previous = '# previous managed config\n';
  await writeFile(activePath, previous, 'utf8');

  const first = managerFor({ stagingDir, sitesDir });
  const staged = await first.stageDomain(spec);
  const activated = await first.activateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(activated.rollback.hadPreviousActive, true);
  assert.match(activated.rollback.previousChecksum, /^[a-f0-9]{64}$/);
  assert.notEqual(await readFile(activePath, 'utf8'), previous);
  assert.equal((await first.inspectDomainCompensation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  })).reason, 'nginx_compensation_pending');

  const restarted = managerFor({ stagingDir, sitesDir });
  const compensated = await restarted.compensateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.restoredPrevious, true);
  assert.equal(await readFile(activePath, 'utf8'), previous);
  assert.equal((await restarted.inspectDomainCompensation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  })).satisfied, true);
});

test('compensation removes a newly created vhost when no previous config existed', async (t) => {
  const { stagingDir, sitesDir } = await fixture(t);
  const activePath = path.join(sitesDir, 'yunpanel-example.com.conf');
  const manager = managerFor({ stagingDir, sitesDir });
  const staged = await manager.stageDomain(spec);
  const activated = await manager.activateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(activated.rollback.hadPreviousActive, false);
  assert.equal(typeof await readFile(activePath, 'utf8'), 'string');

  const compensated = await manager.compensateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.restoredPrevious, false);
  await assert.rejects(readFile(activePath, 'utf8'), (error) => error?.code === 'ENOENT');
});

test('re-applying the same candidate never overwrites the original rollback receipt', async (t) => {
  const { stagingDir, sitesDir } = await fixture(t);
  const activePath = path.join(sitesDir, 'yunpanel-example.com.conf');
  const previous = '# original config\n';
  await writeFile(activePath, previous, 'utf8');

  const first = managerFor({ stagingDir, sitesDir });
  const staged = await first.stageDomain(spec);
  await first.activateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum });

  const restarted = managerFor({ stagingDir, sitesDir });
  await restarted.activateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum });
  await restarted.compensateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum });
  assert.equal(await readFile(activePath, 'utf8'), previous);
});

test('compensation refuses to overwrite active config drift', async (t) => {
  const { stagingDir, sitesDir } = await fixture(t);
  const activePath = path.join(sitesDir, 'yunpanel-example.com.conf');
  const manager = managerFor({ stagingDir, sitesDir });
  const staged = await manager.stageDomain(spec);
  await manager.activateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum });
  await writeFile(activePath, '# operator changed config\n', 'utf8');

  await assert.rejects(
    manager.compensateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum }),
    (error) => error instanceof NginxManagerError && error.code === 'nginx_compensation_drift',
  );
  assert.equal(await readFile(activePath, 'utf8'), '# operator changed config\n');
});

test('failed compensation restores the candidate config instead of leaving a half-rollback', async (t) => {
  const { stagingDir, sitesDir } = await fixture(t);
  const activePath = path.join(sitesDir, 'yunpanel-example.com.conf');
  const previous = '# previous config\n';
  await writeFile(activePath, previous, 'utf8');
  let phase = 'activation';
  let compensationValidationAttempts = 0;
  const execFn = async (file, args) => {
    if (phase === 'compensation' && file.endsWith('/nginx') && args[0] === '-t') {
      compensationValidationAttempts += 1;
      if (compensationValidationAttempts === 1) throw new Error('synthetic configtest failure');
    }
    return '';
  };
  const manager = managerFor({ stagingDir, sitesDir, execFn });
  const staged = await manager.stageDomain(spec);
  await manager.activateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum });
  const candidate = await readFile(activePath, 'utf8');
  phase = 'compensation';

  await assert.rejects(
    manager.compensateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum }),
    (error) => error instanceof NginxManagerError && error.code === 'nginx_compensation_failed',
  );
  assert.equal(compensationValidationAttempts, 2);
  assert.equal(await readFile(activePath, 'utf8'), candidate);
  assert.equal((await manager.inspectDomainCompensation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  })).reason, 'nginx_compensation_pending');
});

test('exit-zero hostname conflicts preserve the previous route and never reload a shadowing Domain', async t=>{
 const f=await fixture(t),active=path.join(f.sitesDir,'yunpanel-example.com.conf'),previous='# known previous route\n';
 await writeFile(active,previous);const calls=[];
 const manager=managerFor({...f,execFn:async(file,args)=>{calls.push([file,args]);return {stdout:'',stderr:'nginx: [warn] conflicting server name "example.com" on 0.0.0.0:443, ignored'};}});
 const staged=await manager.stageDomain(spec);
 await assert.rejects(manager.activateDomain({primaryDomain:spec.primaryDomain,checksum:staged.checksum}),e=>e.code==='nginx_config_invalid');
 assert.equal(await readFile(active,'utf8'),previous);
 assert.equal(calls.some(([,args])=>args[0]==='reload'),false);
});
