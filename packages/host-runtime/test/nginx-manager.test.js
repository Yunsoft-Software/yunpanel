import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager } from '../src/nginx-manager.js';

async function disk(t, { priorActive = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 't892-nginx-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sitesDir = path.join(root, 'sites');
  const stagingDir = path.join(root, 'staging');
  await mkdir(sitesDir);
  const manager = createNginxManager({ sitesDir, stagingDir,
    nginxPath: path.join(root, 'absent-nginx'), systemctlPath: path.join(root, 'absent-systemctl') });
  const primaryDomain = 'retired.example.test';
  const staged = await manager.stageDomain({ primaryDomain, targetType: 'proxy', target: { upstreamPort: 3010 }, httpsRedirect: false });
  const activePath = path.join(sitesDir, staged.configName);
  if (priorActive) await writeFile(activePath, '# preexisting isolated disk bytes\n');
  // This real execFile failure creates a genuine rollback receipt and restores
  // the invocation state. No successful Nginx configtest/reload is asserted.
  await assert.rejects(manager.activateDomain({ primaryDomain, checksum: staged.checksum }), error => error.code === 'nginx_config_invalid');
  return { manager, primaryDomain, staged, activePath, stagingDir };
}

test('actual failed activation exposes sanitized validated absent-before receipt evidence', async t => {
  const state = await disk(t);
  const result = await state.manager.inspectDomainCompensation({ primaryDomain: state.primaryDomain, checksum: state.staged.checksum });
  assert.equal(result.satisfied, true); assert.equal(result.receiptVersion, 1);
  assert.equal(result.hadPreviousActive, false); assert.equal(result.previousPrimaryDomain, null);
  assert.equal(Object.hasOwn(result, 'active'), false); assert.equal(Object.hasOwn(result, 'content'), false);
  await assert.rejects(readFile(state.activePath), error => error.code === 'ENOENT');
});

test('actual failed activation reports preexisting active bytes rather than claiming an absent-before receipt', async t => {
  const state = await disk(t, { priorActive: true });
  const result = await state.manager.inspectDomainCompensation({ primaryDomain: state.primaryDomain, checksum: state.staged.checksum });
  assert.equal(result.satisfied, true); assert.equal(result.hadPreviousActive, true);
  assert.equal(await readFile(state.activePath, 'utf8'), '# preexisting isolated disk bytes\n');
});

test('actual compensation receipt inspection rejects physical drift without changing foreign bytes', async t => {
  const state = await disk(t);
  await writeFile(state.activePath, '# foreign disk bytes\n');
  await assert.rejects(state.manager.inspectDomainCompensation({ primaryDomain: state.primaryDomain, checksum: state.staged.checksum }),
    error => error.code === 'nginx_compensation_drift');
  assert.equal(await readFile(state.activePath, 'utf8'), '# foreign disk bytes\n');
});

test('actual compensation command failure preserves the exact pending candidate and never returns success', async t => {
  const state = await disk(t);
  const candidate = await readFile(path.join(state.stagingDir, state.staged.configName), 'utf8');
  await writeFile(state.activePath, candidate);
  const pending = await state.manager.inspectDomainCompensation({ primaryDomain: state.primaryDomain, checksum: state.staged.checksum });
  assert.equal(pending.satisfied, false); assert.equal(pending.reason, 'nginx_compensation_pending');
  assert.equal(pending.receiptVersion, 1); assert.equal(pending.hadPreviousActive, false); assert.equal(pending.previousPrimaryDomain, null);
  await assert.rejects(state.manager.compensateDomain({ primaryDomain: state.primaryDomain, checksum: state.staged.checksum }),
    error => error.code === 'nginx_compensation_rollback_failed');
  assert.equal(await readFile(state.activePath, 'utf8'), candidate);
});

test('withStagingDir inherits authoritative traffic renderOptions, shares config lock and rejects unsafe paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nginx-mgr-scoped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sitesDir = path.join(root, 'sites');
  const baseStage = path.join(root, 'stage-a');
  const childStage = path.join(root, 'stage-b');
  await mkdir(sitesDir, { recursive: true });
  const manager = createNginxManager({
    stagingDir: baseStage,
    sitesDir,
    trafficLogPath: '/var/log/nginx/yunpanel-site-traffic.log',
    enableTrafficLimitGuard: true,
    execFn: async () => '',
  });
  assert.deepEqual(manager.renderOptions, {
    sitesDir,
    trafficLogPath: '/var/log/nginx/yunpanel-site-traffic.log',
    enableTrafficLimitGuard: true,
  });
  assert.throws(() => manager.withStagingDir('relative/path'), error => error.code === 'invalid_staging_dir');
  assert.throws(() => manager.withStagingDir('/tmp/../etc'), error => error.code === 'invalid_staging_dir');
  assert.throws(() => manager.withStagingDir('/'), error => error.code === 'invalid_staging_dir');
  assert.throws(() => manager.withStagingDir('///'), error => error.code === 'invalid_staging_dir');
  const child = manager.withStagingDir(childStage);
  assert.deepEqual(child.renderOptions, manager.renderOptions);
  const websiteId = '19f03f9f-13bb-5771-9d56-dd837211e2a8';
  const spec = {
    websiteId,
    primaryDomain: 'scoped.example.test',
    aliases: [],
    targetType: 'static',
    target: { root: '/var/www/scoped/current', spaFallback: true },
    tls: null,
    httpsRedirect: false,
    canonicalRedirect: false,
    nginxSettings: {},
  };
  assert.equal(child.previewDomain(spec).checksum, manager.previewDomain(spec).checksum);
  const events = [];
  let releaseLock;
  const gate = new Promise(resolve => { releaseLock = resolve; });
  const held = manager.withConfigLock(async () => {
    events.push('parent-start');
    await gate;
    events.push('parent-end');
  });
  const queued = child.withConfigLock(async () => { events.push('child-ran'); });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(events, ['parent-start']);
  releaseLock();
  await Promise.all([held, queued]);
  assert.deepEqual(events, ['parent-start', 'parent-end', 'child-ran']);
});
