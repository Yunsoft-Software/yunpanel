import assert from 'node:assert/strict';
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
