import { execFile } from 'node:child_process';
import http from 'node:http';

const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const EXEC_ID_PATTERN = /^[a-f0-9]{12,128}$/i;
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;
const EXEC_MARKER_PREFIX = 'yp-exec:';
const SAFE_REASONS = Object.freeze(new Set([
  'invalid_identity',
  'unsupported_platform',
  'docker_api_error',
  'docker_unavailable',
  'exec_not_found',
  'exec_pid_unavailable',
  'namespace_mismatch',
  'pidfd_unsupported',
  'pidfd_identity_mismatch',
  'pidfd_drain_failed',
  'pidfd_timeout',
  'cleanup_timeout',
  'container_absent',
  'container_not_running',
  'exec_already_exited',
  'terminated',
]));

// Linux pidfd-only container exec session reaper.
// Never sends a signal by plain numeric PID: opens pidfd_open(pid, 0),
// verifies /proc/<pid>/ns/pid matches the container's PID namespace and
// /proc/<pid>/stat starttime matches AFTER pidfd_open, excludes container
// PID 1 (containerInitPid), and signals exclusively via pidfd_send_signal.
const CONTAINER_PIDFD_CLEANUP_PYTHON = String.raw`
import base64,json,os,signal,sys,time
def fail(code):
 print(json.dumps({'ok':False,'reason':code}));sys.exit(2)
def read_proc(pid):
 try:
  text=open('/proc/'+str(pid)+'/stat').read(8193)
  if len(text)>8192:return None
  end=text.rfind(')');fields=text[end+2:].split()
  if end<0 or len(fields)<20:return None
  ns=os.readlink('/proc/'+str(pid)+'/ns/pid')
  return {'pid':int(text[:text.index(' ')]),'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':int(fields[3]),'state':fields[0],'starttime':fields[19],'ns':ns}
 except (FileNotFoundError,ProcessLookupError,PermissionError,OSError,ValueError):
  return None
def same(a,b):
 return a is not None and b is not None and a['pid']==b['pid'] and a['starttime']==b['starttime'] and a['ns']==b['ns']
def scan_ns(target_ns,init_pid):
 out={}
 try:names=os.listdir('/proc')
 except OSError:fail('pidfd_drain_failed')
 if len(names)>32768:fail('pidfd_drain_failed')
 for n in names:
  if not n.isdecimal():continue
  pid=int(n)
  if pid==init_pid or pid<=1:continue
  try:
   if os.readlink('/proc/'+n+'/ns/pid')!=target_ns:continue
  except OSError:continue
  p=read_proc(pid)
  if p is not None and p['ns']==target_ns:out[pid]=p
 return out
def select_owned(procs,leader_pid,leader_sid,known):
 owned={}
 for pid,p in procs.items():
  if pid==leader_pid:owned[pid]=p
  elif pid in known and same(p,known[pid]):owned[pid]=p
 changed=True
 while changed:
  changed=False
  sids={p['sid'] for p in owned.values()}
  for pid,p in procs.items():
   if pid in owned:continue
   if p['ppid'] in owned or (leader_sid==leader_pid and p['sid'] in sids):
    owned[pid]=p;changed=True
 return owned
try:
 cfg=json.loads(base64.b64decode(sys.argv[1],validate=True))
 if sys.platform!='linux' or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):fail('pidfd_unsupported')
 init_pid=int(cfg['containerInitPid']);leader_pid=int(cfg['leaderPid']);timeout_ms=int(cfg['timeoutMs'])
 if init_pid<=1 or leader_pid<=1 or leader_pid==init_pid:fail('pidfd_identity_mismatch')
 deadline=time.monotonic()+max(timeout_ms,200)/1000.0
 init_proc=read_proc(init_pid)
 if init_proc is None:fail('namespace_mismatch')
 target_ns=init_proc['ns']
 leader=read_proc(leader_pid)
 if leader is None:
  print(json.dumps({'ok':True,'reason':'exec_already_exited','signaledPids':[]}));sys.exit(0)
 if leader['ns']!=target_ns:fail('namespace_mismatch')
 leader_sid=leader['sid']
 known={leader_pid:leader};held={};stopped=set();signaled=set();prev_shape=None
 try:
  while True:
   if time.monotonic()>=deadline:fail('pidfd_timeout')
   procs=scan_ns(target_ns,init_pid)
   owned=select_owned(procs,leader_pid,leader_sid,known)
   for pid,p in owned.items():
    if pid in known and not same(p,known[pid]):fail('pidfd_identity_mismatch')
    known[pid]=p
   for pid,p in owned.items():
    if p['state']=='Z' or pid==init_pid:continue
    if pid not in held:
     try:fd=os.pidfd_open(pid,0)
     except ProcessLookupError:continue
     post=read_proc(pid)
     if not same(post,known[pid]) or post['ns']!=target_ns:
      os.close(fd);fail('pidfd_identity_mismatch')
     held[pid]=fd
    try:signal.pidfd_send_signal(held[pid],signal.SIGSTOP,None,0)
    except ProcessLookupError:continue
    stopped.add(pid)
   shape=tuple(sorted((pid,p['starttime']) for pid,p in owned.items()))
   if not owned or (shape==prev_shape and all(p['state'] in ('T','t','Z') for p in owned.values())):break
   prev_shape=shape;time.sleep(0.015)
  for pid,fd in list(held.items()):
   post=read_proc(pid)
   if post is not None and (not same(post,known[pid]) or post['ns']!=target_ns):fail('pidfd_identity_mismatch')
   for sig in (signal.SIGHUP,signal.SIGKILL):
    try:
     signal.pidfd_send_signal(fd,sig,None,0);signaled.add(pid)
    except ProcessLookupError:pass
  while True:
   procs=scan_ns(target_ns,init_pid)
   alive=[p for pid,p in procs.items() if pid in known and same(p,known[pid]) and p['state']!='Z']
   if not alive:break
   if time.monotonic()>=deadline:fail('pidfd_timeout')
   time.sleep(0.02)
  print(json.dumps({'ok':True,'reason':'terminated','signaledPids':sorted(signaled)}));sys.exit(0)
 finally:
  for pid,fd in held.items():
   if pid in stopped:
    try:signal.pidfd_send_signal(fd,signal.SIGCONT,None,0)
    except ProcessLookupError:pass
   try:os.close(fd)
   except OSError:pass
except (OSError,ValueError,KeyError,TypeError):
 fail('pidfd_drain_failed')
`;

export function buildContainerConsoleExecArgs({
  containerId,
  uid,
  gid,
  cwd,
  shell,
  consoleSessionId,
}) {
  if (!CONTAINER_ID_PATTERN.test(containerId ?? '')) {
    throw new TypeError('containerId must be a 64-character hex string');
  }
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new TypeError('uid and gid must be positive non-root integers');
  }
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new TypeError('cwd must be an absolute path');
  }
  if (!['/bin/bash', '/bin/sh'].includes(shell)) {
    throw new TypeError('shell must be an allowlisted POSIX shell');
  }
  if (typeof consoleSessionId !== 'string' || !SESSION_ID_PATTERN.test(consoleSessionId)) {
    throw new TypeError('consoleSessionId must be a 32-character hex token');
  }
  return Object.freeze([
    '--host', `unix://${DOCKER_SOCKET_PATH}`,
    'exec', '-i', '-t',
    '--user', `${uid}:${gid}`,
    '--workdir', cwd,
    containerId,
    shell,
    '-c',
    'exec "$1" -i',
    `${EXEC_MARKER_PREFIX}${consoleSessionId}`,
    shell,
  ]);
}

function dockerUnixGetJson(socketPath, requestPath, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: requestPath,
      method: 'GET',
      headers: { host: 'localhost', accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) {
          req.destroy(new Error('docker_api_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode ?? 0, data: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker_api_timeout')));
    req.on('error', reject);
    req.end();
  });
}

function runPidfdContainerDrain({ containerInitPid, leaderPid, timeoutMs }) {
  const encoded = Buffer.from(JSON.stringify({ containerInitPid, leaderPid, timeoutMs })).toString('base64');
  return new Promise((resolve) => {
    execFile('/usr/bin/python3', ['-c', CONTAINER_PIDFD_CLEANUP_PYTHON, encoded], {
      encoding: 'utf8',
      timeout: timeoutMs + 1_000,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      let parsed = null;
      try { parsed = stdout ? JSON.parse(stdout) : null; } catch { parsed = null; }
      if (!error && parsed?.ok === true) {
        resolve(Object.freeze({
          ok: true,
          reason: SAFE_REASONS.has(parsed.reason) ? parsed.reason : 'terminated',
          signaledPids: Object.freeze(Array.isArray(parsed.signaledPids) ? parsed.signaledPids.filter((p) => Number.isSafeInteger(p) && p > 1) : []),
        }));
        return;
      }
      resolve(Object.freeze({
        ok: false,
        reason: SAFE_REASONS.has(parsed?.reason) ? parsed.reason : 'pidfd_drain_failed',
        signaledPids: Object.freeze([]),
      }));
    });
  });
}

export function formatContainerCleanupFailureLine({ containerId = null, consoleSessionId = null, reason = 'cleanup_timeout' } = {}) {
  const safeContainer = typeof containerId === 'string' && CONTAINER_ID_PATTERN.test(containerId)
    ? containerId.slice(0, 12)
    : 'invalid';
  const safeSession = typeof consoleSessionId === 'string' && SESSION_ID_PATTERN.test(consoleSessionId)
    ? consoleSessionId.slice(0, 8)
    : 'invalid';
  const safeReason = SAFE_REASONS.has(reason) ? reason : 'cleanup_timeout';
  return `[yunpanel-api] docker container console cleanup unverified container=${safeContainer} session=${safeSession} reason=${safeReason}`;
}

export function parseProcStat(text) {
  if (typeof text !== 'string' || text.length > 8192) return null;
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const pidText = text.slice(0, text.indexOf(' '));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (fields.length < 20 || !/^[1-9][0-9]*$/.test(pidText) || !/^[0-9]+$/.test(fields[19])) {
    return null;
  }
  const pid = Number.parseInt(pidText, 10);
  const ppid = Number.parseInt(fields[1], 10);
  const pgid = Number.parseInt(fields[2], 10);
  const sid = Number.parseInt(fields[3], 10);
  if (!Number.isSafeInteger(pid) || pid < 1
    || !Number.isSafeInteger(ppid) || ppid < 0
    || !Number.isSafeInteger(pgid) || pgid < 1
    || !Number.isSafeInteger(sid) || sid < 1) {
    return null;
  }
  return Object.freeze({
    pid,
    ppid,
    pgid,
    sid,
    state: fields[0],
    starttime: fields[19],
  });
}

export function matchExecInspectForSession(execInspect, { containerId, consoleSessionId }) {
  if (!execInspect || typeof execInspect !== 'object' || Array.isArray(execInspect)) return false;
  const targetId = typeof containerId === 'string' ? containerId.toLowerCase() : '';
  const actualId = typeof execInspect.ContainerID === 'string' ? execInspect.ContainerID.toLowerCase() : '';
  if (!CONTAINER_ID_PATTERN.test(targetId) || actualId !== targetId) return false;
  const args = execInspect.ProcessConfig?.arguments;
  if (!Array.isArray(args) || args.length < 4) return false;
  return args[0] === '-c'
    && args[1] === 'exec "$1" -i'
    && args[2] === `${EXEC_MARKER_PREFIX}${consoleSessionId}`
    && ['/bin/bash', '/bin/sh'].includes(args[3]);
}

export function selectContainerSessionPids(processes, { leaderPid, containerInitPid }) {
  if (!Array.isArray(processes) || !Number.isSafeInteger(leaderPid) || leaderPid <= 1) {
    return Object.freeze([]);
  }
  const byPid = new Map();
  for (const item of processes) {
    if (!item || item.pid === containerInitPid) continue;
    byPid.set(item.pid, item);
  }
  const leader = byPid.get(leaderPid);
  if (!leader) return Object.freeze([]);
  const owned = new Map([[leader.pid, leader]]);
  let changed = true;
  while (changed) {
    changed = false;
    const ownedSids = new Set([...owned.values()].map((item) => item.sid));
    for (const [pid, item] of byPid) {
      if (owned.has(pid)) continue;
      if (owned.has(item.ppid) || (leader.sid === leader.pid && ownedSids.has(item.sid))) {
        owned.set(pid, item);
        changed = true;
      }
    }
  }
  return Object.freeze([...owned.values()].sort((left, right) => left.pid - right.pid));
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function cleanupDockerContainerExec({
  containerId,
  consoleSessionId,
  dockerSocketPath = DOCKER_SOCKET_PATH,
  timeoutMs = 3_500,
  discoveryTimeoutMs = 800,
  dockerGetJson = dockerUnixGetJson,
  pidfdDrain = runPidfdContainerDrain,
  platform = process.platform,
  sleepFn = delay,
  onCleanupError = null,
} = {}) {
  function unverified(reason, extra = {}) {
    const safeReason = SAFE_REASONS.has(reason) ? reason : 'cleanup_timeout';
    const record = Object.freeze({
      verified: false,
      reason: safeReason,
      containerId: typeof containerId === 'string' ? containerId : null,
      consoleSessionId: typeof consoleSessionId === 'string' ? consoleSessionId : null,
      ...extra,
      signaledPids: Object.freeze(Array.isArray(extra.signaledPids) ? extra.signaledPids : []),
    });
    const line = formatContainerCleanupFailureLine({
      containerId,
      consoleSessionId,
      reason: safeReason,
    });
    try {
      if (typeof onCleanupError === 'function') onCleanupError({ ...record, line });
      else console.error(line);
    } catch {}
    return record;
  }

  if (!CONTAINER_ID_PATTERN.test(containerId ?? '') || !SESSION_ID_PATTERN.test(consoleSessionId ?? '')) {
    return unverified('invalid_identity');
  }
  if (platform !== 'linux') {
    return unverified('unsupported_platform');
  }

  const deadline = Date.now() + timeoutMs;
  const discoveryDeadline = Math.min(deadline, Date.now() + Math.max(0, discoveryTimeoutMs));

  async function scanContainerExec() {
    const containerRes = await dockerGetJson(dockerSocketPath, `/containers/${containerId}/json`, 2_000);
    if (containerRes.status === 404) {
      return { status: 'container_absent', containerInitPid: null, execId: null, exec: null };
    }
    if (containerRes.status !== 200 || !containerRes.data) {
      return { status: 'docker_unavailable', containerInitPid: null, execId: null, exec: null };
    }
    const state = containerRes.data.State ?? {};
    const containerInitPid = Number.isSafeInteger(state.Pid) && state.Pid > 1 ? state.Pid : null;
    if (state.Running !== true || !containerInitPid) {
      return { status: 'container_not_running', containerInitPid: null, execId: null, exec: null };
    }
    const execIds = Array.isArray(containerRes.data.ExecIDs) ? containerRes.data.ExecIDs : [];
    let execInspectError = false;
    for (const execId of execIds) {
      if (typeof execId !== 'string' || !EXEC_ID_PATTERN.test(execId)) continue;
      let execRes;
      try {
        execRes = await dockerGetJson(dockerSocketPath, `/exec/${execId}/json`, 2_000);
      } catch {
        execInspectError = true;
        continue;
      }
      if (execRes.status === 404) continue;
      if (execRes.status !== 200 || !execRes.data) {
        execInspectError = true;
        continue;
      }
      if (matchExecInspectForSession(execRes.data, { containerId, consoleSessionId })) {
        return { status: 'found', containerInitPid, execId, exec: execRes.data };
      }
    }
    return {
      status: execInspectError ? 'docker_unavailable' : 'exec_not_found',
      containerInitPid,
      execId: null,
      exec: null,
    };
  }

  // Retry discovery briefly to handle immediate close right after connect before
  // Docker Engine finishes attaching ExecIDs; NEVER classify discovery errors or
  // missing exec identity as verified success.
  let match = { status: 'docker_api_error', containerInitPid: null, execId: null, exec: null };
  while (true) {
    try {
      match = await scanContainerExec();
    } catch {
      match = { status: 'docker_api_error', containerInitPid: null, execId: null, exec: null };
    }
    if (match.status === 'found' || match.status === 'container_absent' || match.status === 'container_not_running') {
      break;
    }
    if (Date.now() >= discoveryDeadline) break;
    await sleepFn(60);
  }

  if (match.status === 'container_absent' || match.status === 'container_not_running') {
    return Object.freeze({ verified: true, reason: match.status, signaledPids: Object.freeze([]) });
  }
  if (match.status !== 'found') {
    return unverified(match.status);
  }
  if (match.exec.Running !== true) {
    return Object.freeze({
      verified: true,
      reason: 'exec_already_exited',
      execId: match.execId,
      signaledPids: Object.freeze([]),
    });
  }

  // Wait briefly if Docker created the exec object but hasn't assigned host Pid yet.
  let execPid = Number.isSafeInteger(match.exec.Pid) ? match.exec.Pid : 0;
  while (execPid <= 1 && Date.now() < deadline) {
    await sleepFn(40);
    try {
      const refreshed = await dockerGetJson(dockerSocketPath, `/exec/${match.execId}/json`, 1_500);
      if (refreshed.status === 404 || (refreshed.status === 200 && refreshed.data?.Running === false)) {
        return Object.freeze({
          verified: true,
          reason: 'exec_already_exited',
          execId: match.execId,
          signaledPids: Object.freeze([]),
        });
      }
      if (refreshed.status !== 200 || !refreshed.data) {
        return unverified('docker_unavailable', { execId: match.execId });
      }
      execPid = Number.isSafeInteger(refreshed.data.Pid) ? refreshed.data.Pid : 0;
    } catch {
      return unverified('docker_api_error', { execId: match.execId });
    }
  }
  if (execPid <= 1 || execPid === match.containerInitPid) {
    return unverified('exec_pid_unavailable', { execId: match.execId });
  }

  const remainingMs = Math.max(200, deadline - Date.now());
  const drainOutcome = await pidfdDrain({
    containerInitPid: match.containerInitPid,
    leaderPid: execPid,
    timeoutMs: remainingMs,
  });
  if (!drainOutcome || drainOutcome.ok !== true) {
    return unverified(drainOutcome?.reason ?? 'pidfd_drain_failed', {
      execId: match.execId,
      leaderPid: execPid,
    });
  }

  // Confirm exec is no longer running in Docker Engine.
  let verified = false;
  while (Date.now() < deadline) {
    try {
      const check = await dockerGetJson(dockerSocketPath, `/exec/${match.execId}/json`, 1_500);
      if (check.status === 404 || (check.status === 200 && check.data?.Running === false)) {
        verified = true;
        break;
      }
    } catch {
      return unverified('docker_api_error', {
        execId: match.execId,
        leaderPid: execPid,
        signaledPids: drainOutcome.signaledPids,
      });
    }
    await sleepFn(60);
  }

  if (!verified) {
    return unverified('cleanup_timeout', {
      execId: match.execId,
      leaderPid: execPid,
      signaledPids: drainOutcome.signaledPids,
    });
  }

  return Object.freeze({
    verified: true,
    reason: 'terminated',
    execId: match.execId,
    leaderPid: execPid,
    signaledPids: drainOutcome.signaledPids,
  });
}

export const dockerContainerConsoleCleanupInternals = Object.freeze({
  dockerSocketPath: DOCKER_SOCKET_PATH,
  execMarkerPrefix: EXEC_MARKER_PREFIX,
  containerPidfdCleanupPython: CONTAINER_PIDFD_CLEANUP_PYTHON,
  safeReasons: SAFE_REASONS,
  buildContainerConsoleExecArgs,
  formatContainerCleanupFailureLine,
  parseProcStat,
  matchExecInspectForSession,
  selectContainerSessionPids,
});
