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

test('T898 actual Unix accepts retain one listener and accepted-only kernel rows never prove absence', () => {
  const python = String.raw`
import ast,json,os,socket,stat,sys,tempfile,time
source=ast.parse(sys.argv[1]);names={'reject','socket_kernel_rows','socket_listener_inode'}
definitions=[node for node in source.body if isinstance(node,ast.FunctionDef) and node.name in names]
assert {node.name for node in definitions}==names
namespace={'json':json,'sys':sys}
exec(compile(ast.Module(body=definitions,type_ignores=[]),'actual-runtime-functions','exec'),namespace)
rows=namespace['socket_kernel_rows'];select=namespace['socket_listener_inode']
directory=tempfile.mkdtemp(prefix='t898-unix-',dir='/tmp');path=directory+'/listener.sock'
listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);clients=[];accepted=[];original=None
result={'realConnections':0,'sourceReaderUsed':True,'linuxPositive':False}
try:
 listener.bind(path);listener.listen(2);original=os.lstat(path)
 for index in range(2):
  client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);clients.append(client);client.connect(path)
  connection,_=listener.accept();accepted.append(connection)
  payload=('own-'+str(index)).encode();client.sendall(payload);assert connection.recv(32)==payload
  assert connection.getsockname()==path;result['realConnections']+=1
 try:current=rows(path)
 except OSError as error:
  if sys.platform=='linux':raise
  result.update(unsupportedClass=type(error).__name__)
 else:
  assert sys.platform=='linux'
  inode=os.readlink('/proc/self/fd/'+str(listener.fileno()))
  assert inode.startswith('socket:[') and inode.endswith(']');inode=inode[8:-1]
  assert select(path)==inode and len(current)>=3
  assert len([row for row in current if row[3]=='00010000' and row[4]=='0001' and row[5]=='01'])==1
  listener.close();remaining=rows(path)
  assert len(remaining)>=2 and select(path) is None
  result.update(linuxPositive=True,namedRowsWithTwoAccepts=len(current),acceptedOnlyRows=len(remaining),acceptedOnlyIsNotAbsence=bool(remaining))
finally:
 for descriptor in accepted+clients:descriptor.close()
 listener.close()
 if original is not None:
  current=os.lstat(path);assert stat.S_ISSOCK(current.st_mode) and (current.st_dev,current.st_ino)==(original.st_dev,original.st_ino)
  if sys.platform=='linux':
   deadline=time.monotonic()+3
   while rows(path) and time.monotonic()<deadline:time.sleep(.01)
   assert rows(path)==[];result['finalNamedRows']=0
  os.unlink(path)
 os.rmdir(directory)
result.update(allOwnDescriptorsClosed=True,ownSocketAndDirectoryAbsent=not os.path.lexists(path) and not os.path.lexists(directory))
print(json.dumps(result))
`;
  const result = JSON.parse(execFileSync('/usr/bin/python3', ['-c', python, terminalProcessInternals.ownedProcessPython],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 }));
  assert.equal(result.realConnections, 2); assert.equal(result.sourceReaderUsed, true);
  assert.equal(result.allOwnDescriptorsClosed, true); assert.equal(result.ownSocketAndDirectoryAbsent, true);
  if (process.platform === 'linux') {
    assert.equal(result.linuxPositive, true); assert.ok(result.namedRowsWithTwoAccepts >= 3);
    assert.ok(result.acceptedOnlyRows >= 2); assert.equal(result.acceptedOnlyIsNotAbsence, true); assert.equal(result.finalNamedRows, 0);
  } else {
    assert.equal(result.linuxPositive, false); assert.equal(result.unsupportedClass, 'FileNotFoundError');
  }
});
