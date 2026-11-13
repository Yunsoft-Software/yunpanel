import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalWebSocketInternals } from '../src/terminal-websocket.js';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureOwnedTerminalIdentity, captureTerminalGenerationBoundary, createOwnedTerminalLifecycle, observeTerminalChild, terminalProcessInternals } from '../src/terminal-process-manager.js';

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WEBSITE_ID = '22222222-2222-4222-8222-222222222222';

function owner() {
  return {
    user: { id: 'owner', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
}

function siteActor(role = 'site_manager', websiteIds = [WEBSITE_ID], active = true) {
  return {
    user: { id: `${role}-user`, role, websiteIds, active },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
}

test('terminal WebSocket target policy keeps root Owner-only and site access bound to current grants', () => {
  const { requireTerminalTargetAccess } = terminalWebSocketInternals;
  assert.equal(
    requireTerminalTargetAccess(owner(), { scope: 'server', serverId: 'local-server' }).user.role,
    'owner',
  );
  assert.equal(
    requireTerminalTargetAccess(owner(), { scope: 'site', websiteId: WEBSITE_ID }).user.role,
    'owner',
  );
  assert.equal(
    requireTerminalTargetAccess(siteActor(), { scope: 'site', websiteId: WEBSITE_ID }).user.role,
    'site_manager',
  );
  for (const role of ['reseller', 'customer']) {
    assert.equal(
      requireTerminalTargetAccess(siteActor(role), { scope: 'site', websiteId: WEBSITE_ID }).user.role,
      role,
    );
    assert.throws(
      () => requireTerminalTargetAccess(siteActor(role), { scope: 'site', websiteId: OTHER_WEBSITE_ID }),
      { code: 'terminal_site_forbidden', status: 403 },
    );
  }

  assert.throws(
    () => requireTerminalTargetAccess(siteActor(), { scope: 'server', serverId: 'local-server' }),
    { code: 'terminal_server_forbidden', status: 403 },
  );
  assert.throws(
    () => requireTerminalTargetAccess(siteActor(), { scope: 'site', websiteId: OTHER_WEBSITE_ID }),
    { code: 'terminal_site_forbidden', status: 403 },
  );
  assert.throws(
    () => requireTerminalTargetAccess(siteActor('site_manager', []), { scope: 'site', websiteId: WEBSITE_ID }),
    { code: 'terminal_site_forbidden', status: 403 },
  );
  for (const role of ['site_manager', 'reseller', 'customer']) {
    assert.throws(
      () => requireTerminalTargetAccess(siteActor(role, [WEBSITE_ID], false), { scope: 'site', websiteId: WEBSITE_ID }),
      { code: 'terminal_site_forbidden', status: 403 },
    );
  }
});

test('T898 actual embedded Python parses and the current OS either drains its real detached child or rejects unsupported pidfd', async () => {
  // Compile the actual runtime value, not a separately extracted approximation.
  execFileSync('/usr/bin/python3', ['-c', 'import sys;compile(sys.argv[1],"terminal-owned-process","exec")', terminalProcessInternals.ownedProcessPython], { timeout: 5000 });
  const linux = process.platform === 'linux';
  const child = spawn(process.execPath, ['-e', linux ? 'setInterval(()=>{},1000)' : 'setTimeout(()=>{},100)'], { detached: true, stdio: 'ignore' });
  const exit = once(child, 'exit');
  try {
    const seed = linux ? captureOwnedTerminalIdentity(child.pid) : null;
    await once(child, 'spawn');
    if (!linux) {
      assert.throws(() => captureOwnedTerminalIdentity(child.pid), { code: 'terminal_drain_unsupported' });
      assert.deepEqual(await exit, [0, null]);
      return;
    }
    await assert.rejects(createOwnedTerminalLifecycle({ seed: { ...seed, root: { ...seed.root, starttime: String(BigInt(seed.root.starttime) + 1n) } }, childExit: exit }),
      { code: 'terminal_drain_identity_unavailable' });
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'Rejected seed must not signal the real child');
    const lifecycle = await createOwnedTerminalLifecycle({ seed, childExit: exit });
    const snapshot = await lifecycle.snapshot();
    assert.equal(snapshot.root.pid, child.pid);
    assert.equal(snapshot.root.ppid, process.pid);
    assert.equal(snapshot.root.sid, child.pid);
    assert.equal(snapshot.creator.pid, process.pid);
    assert.match(snapshot.root.starttime, /^[0-9]+$/);
    const result = await lifecycle.drain({ timeoutMs: 10000 });
    assert.equal(result.verified, true);
    assert.equal(result.childExited, true);
    assert.equal(result.processesExited, true);
    assert.ok(result.processes.some(value => value.pid === child.pid));
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally {
    // This test owns exactly this ChildProcess; never signal a UID or guessed group.
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  }
});

test('T898 actual non-service process never invents a verified production generation boundary', () => {
  // The local node:test process is not the MainPID of yunpanel-api.service.
  const result = captureTerminalGenerationBoundary();
  assert.deepEqual(result, { version: 1, verified: false, code: 'terminal_drain_generation_unknown' });
});

test('T898 real asynchronous missing-executable failure is observed before any PID inspection or await', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t898-child-'));
  try {
    const child = spawn(path.join(directory, 'does-not-exist'), [], { stdio: 'ignore', detached: true });
    const errors = [];
    const observation = observeTerminalChild(child, { onError: value => errors.push(value) });
    assert.equal(child.pid, undefined);
    await observation.exit;
    assert.deepEqual(errors, [{ spawnFailed: true }]);
    assert.equal(observation.hasExited(), true); assert.equal(observation.failedToSpawn(), true);
    assert.equal(child.pid, undefined, 'No guessed PID or signal is used for a failed spawn');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
