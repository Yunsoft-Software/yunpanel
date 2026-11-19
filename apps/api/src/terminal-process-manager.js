import { readFile, realpath, stat } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as nodePty from 'node-pty';
import {
  resolveTerminalTarget,
  terminalTargetInternals,
} from './terminal-target-resolver.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const MAX_INPUT_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRAIN_ERROR_BACKENDS = new Set(['node-pty', 'ttyd']);
export const TERMINAL_DRAIN_FAILURE_CODES = Object.freeze(new Set([
  'terminal_drain_unsupported',
  'terminal_drain_identity_invalid',
  'terminal_drain_identity_unavailable',
  'terminal_drain_evidence_unavailable',
  'terminal_drain_generation_unknown',
  'terminal_drain_ownership_unknown',
  'terminal_drain_pid_reused',
  'terminal_drain_socket_unavailable',
  'terminal_drain_socket_changed',
  'terminal_drain_timeout',
  'terminal_drain_limit',
  'terminal_drain_unverified',
  'terminal_website_removing',
  'terminal_website_fence_conflict',
]));

export function formatTerminalDrainFailureLine({ backend, websiteId = null, error = null } = {}) {
  const safeBackend = DRAIN_ERROR_BACKENDS.has(backend) ? backend : 'unknown';
  const safeWebsite = typeof websiteId === 'string' && UUID_PATTERN.test(websiteId) ? websiteId : 'none';
  let rawCode = null;
  try {
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : null;
    rawCode = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  } catch { rawCode = null; }
  const safeCode = typeof rawCode === 'string' && TERMINAL_DRAIN_FAILURE_CODES.has(rawCode)
    ? rawCode
    : 'terminal_drain_unverified';
  return `[yunpanel-api] terminal drain failed backend=${safeBackend} website=${safeWebsite} code=${safeCode}`;
}

// Only identities descended from this manager's actual child, and their proven
// sessions, enter this inventory. A UID, executable name or a numeric PGID is
// never sufficient authority to signal a process.
const OWNED_PROCESS_PYTHON = String.raw`
import base64,json,os,signal,stat,sys,time
def reject(code):
 print(json.dumps({'error':code}));sys.exit(2)
def proc(pid):
 try:
  text=open('/proc/'+str(pid)+'/stat').read(8193)
  if len(text)>8192:reject('terminal_drain_identity_invalid')
  end=text.rfind(')'); fields=text[end+2:].split()
  if end<0 or len(fields)<20:reject('terminal_drain_identity_invalid')
  return {'pid':int(text[:text.index(' ')]),'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':int(fields[3]),'starttime':fields[19],'state':fields[0]}
 except FileNotFoundError:return None
def same(a,b):return a is not None and b is not None and a['pid']==b['pid'] and a['starttime']==b['starttime']
def clean(p):return {k:p[k] for k in ('pid','ppid','pgid','sid','starttime')}
def inventory():
 names=[n for n in os.listdir('/proc') if n.isdecimal()]
 if len(names)>32768:reject('terminal_drain_limit')
 return {p['pid']:p for p in (proc(int(n)) for n in names) if p is not None}
def identity(p):
 if not isinstance(p,dict) or set(p)!=set(('pid','ppid','pgid','sid','starttime')):reject('terminal_drain_identity_invalid')
 if any(type(p[k]) is not int or p[k]<1 for k in ('pid','pgid','sid')) or type(p['ppid']) is not int or p['ppid']<0 or not isinstance(p['starttime'],str) or not p['starttime'].isdecimal():reject('terminal_drain_identity_invalid')
 return p
def socket_info(p):
 try:
  s=os.lstat(p)
  if not stat.S_ISSOCK(s.st_mode) or s.st_nlink!=1:reject('terminal_drain_socket_changed')
  return {'dev':str(s.st_dev),'ino':str(s.st_ino),'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}
 except FileNotFoundError:return None
def socket_kernel_rows(path):
 text=open('/proc/net/unix').read(2097153)
 if len(text)>2097152:reject('terminal_drain_limit')
 rows=[line.split() for line in text.splitlines() if line.split()[-1:]==[path]]
 for row in rows:
  if len(row)!=8 or not row[6].isdecimal() or len(row[6])>30:reject('terminal_drain_socket_changed')
  for index,size in ((3,8),(4,4),(5,2)):
   if len(row[index])!=size or any(c not in '0123456789abcdefABCDEF' for c in row[index]):reject('terminal_drain_socket_changed')
 return rows
def socket_listener_inode(path):
 rows=socket_kernel_rows(path)
 if any(row[3] not in ('00000000','00010000') or row[4]!='0001' or row[5] not in ('01','02','03','04') for row in rows):reject('terminal_drain_socket_changed')
 listeners=[row for row in rows if row[3]=='00010000' and row[5]=='01']
 if len(listeners)>1:reject('terminal_drain_socket_changed')
 return listeners[0][6] if listeners else None
try:
 x=json.loads(base64.b64decode(sys.argv[1],validate=True)); deadline=time.monotonic()+x['timeoutMs']/1000
 if sys.platform!='linux' or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):reject('terminal_drain_unsupported')
 if x['mode']=='support':
  fd=os.pidfd_open(os.getpid(),0)
  try:signal.pidfd_send_signal(fd,0,None,0)
  finally:os.close(fd)
  if proc(os.getpid()) is None:reject('terminal_drain_unsupported')
  print(json.dumps({'supported':True}));sys.exit(0)
 if x['mode']=='initial':
  while True:
   creator=proc(x['seed']['creator']['pid']); root=proc(x['seed']['root']['pid'])
   if creator is None or root is None or clean(creator)!=x['seed']['creator'] or not same(root,x['seed']['root']) or root['ppid']!=x['seed']['root']['ppid'] or root['ppid']!=creator['pid']:reject('terminal_drain_identity_unavailable')
   if root['sid']==root['pid'] and root['pgid']==root['pid']:break
   if time.monotonic()>=deadline:reject('terminal_drain_timeout')
   time.sleep(.005)
  evidence={'version':1,'started':True,'creator':clean(creator),'root':clean(root),'known':[clean(root)],'socket':{'path':x['socketPath'],'identity':None} if x.get('socketPath') is not None else None}
 else:evidence=x['evidence']
 if evidence.get('version')!=1 or evidence.get('started') is not True:reject('terminal_drain_identity_invalid')
 identity(evidence['root']);identity(evidence['creator'])
 known={p['pid']:identity(p) for p in evidence['known']}
 if not same(known.get(evidence['root']['pid']),evidence['root']) or len(known)>256:reject('terminal_drain_identity_invalid')
 sockets=evidence.get('socket')
 if sockets is not None:
  path=sockets['path']
  import re
  if not re.fullmatch(r'/run/yunpanel/ttyd/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sock',path):reject('terminal_drain_socket_changed')
 held={}; stopped=set(); previous=None
 try:
  while True:
   if time.monotonic()>=deadline:reject('terminal_drain_timeout')
   current=inventory(); live={pid:p for pid,p in current.items() if pid in known and same(p,known[pid])}
   for pid,p in current.items():
    if pid in known and not same(p,known[pid]):reject('terminal_drain_pid_reused')
   changed=True
   while changed:
    changed=False; anchored={p['sid'] for p in live.values()}
    for pid,p in current.items():
     if pid in live:continue
     parent=live.get(p['ppid'])
     if parent is not None or p['sid'] in anchored:
      if pid in known and not same(p,known[pid]):reject('terminal_drain_pid_reused')
      known[pid]=clean(p);live[pid]=p;changed=True
   if len(known)>256:reject('terminal_drain_limit')
   # A session with no surviving known anchor may have an unrelated reused ID.
   # Do not adopt or signal such processes merely because its number matches.
   sessions={p['sid'] for p in known.values()}
   if any(p['sid'] in sessions and pid not in live for pid,p in current.items()):reject('terminal_drain_ownership_unknown')
   if x['mode']!='drain':break
   for pid,p in live.items():
    if p['state']=='Z':continue
    if pid not in held:
     try:fd=os.pidfd_open(pid,0)
     except ProcessLookupError:continue
     if not same(proc(pid),known[pid]):os.close(fd);reject('terminal_drain_pid_reused')
     held[pid]=fd
    try:signal.pidfd_send_signal(held[pid],signal.SIGSTOP,None,0)
    except ProcessLookupError:continue
    stopped.add(pid)
   shape=tuple(sorted((pid,p['starttime']) for pid,p in live.items()))
   if shape==previous and all(p['state'] in ('T','t','Z') for p in live.values()):break
   previous=shape;time.sleep(.01)
  evidence['known']=[known[p] for p in sorted(known)]
  if x.get('socketPath') is not None:
   candidate={'path':x['socketPath'],'identity':socket_info(x['socketPath'])}
   if candidate['identity'] is None:reject('terminal_drain_socket_unavailable')
   inode=socket_listener_inode(candidate['path']); owner=False
   if inode is None:reject('terminal_drain_socket_unavailable')
   for pid,p in known.items():
    if not same(proc(pid),p):continue
    try:
     names=os.listdir('/proc/'+str(pid)+'/fd')
     if len(names)>4096:reject('terminal_drain_limit')
     for name in names:
      try:
       if os.readlink('/proc/'+str(pid)+'/fd/'+name)=='socket:['+inode+']':owner=True
      except FileNotFoundError:continue
    except FileNotFoundError:continue
    if not same(proc(pid),p):reject('terminal_drain_identity_unavailable')
   if not owner or socket_info(candidate['path'])!=candidate['identity'] or socket_listener_inode(candidate['path'])!=inode:reject('terminal_drain_socket_changed')
   candidate['identity']['kernelInode']=inode
   evidence['socket']=candidate;sockets=candidate
  if x['mode']!='drain':print(json.dumps(evidence));sys.exit(0)
  for pid,fd in held.items():
   if not same(proc(pid),known[pid]):
    if proc(pid) is None:continue
    reject('terminal_drain_pid_reused')
   for sig in (signal.SIGHUP,signal.SIGKILL):
    try:signal.pidfd_send_signal(fd,sig,None,0)
    except ProcessLookupError:pass
  while True:
   current=inventory()
   if any(pid in current and not same(current[pid],p) for pid,p in known.items()):reject('terminal_drain_pid_reused')
   remaining=[p for p in current.values() if p['pid'] in known or p['sid'] in {k['sid'] for k in known.values()}]
   if not remaining:break
   if time.monotonic()>=deadline:reject('terminal_drain_timeout')
   time.sleep(.02)
  if sockets is not None:
   now=socket_info(sockets['path'])
   if socket_kernel_rows(sockets['path']):reject('terminal_drain_socket_changed')
   if now is not None:
    if sockets['identity'] is None or now!={k:v for k,v in sockets['identity'].items() if k!='kernelInode'}:reject('terminal_drain_socket_changed')
    os.unlink(sockets['path'])
   if socket_info(sockets['path']) is not None:reject('terminal_drain_socket_changed')
  print(json.dumps({'verified':True,'childExited':True,'processesExited':True,'socketRemoved':True,'processCount':len(known),'processes':[known[p] for p in sorted(known)]}))
 finally:
  for pid,fd in held.items():
   if pid in stopped:
    try:signal.pidfd_send_signal(fd,signal.SIGCONT,None,0)
    except ProcessLookupError:pass
   os.close(fd)
except (PermissionError,OSError,ValueError,KeyError,TypeError):reject('terminal_drain_identity_unavailable')
`;

async function ownedProcessCommand(input, timeoutMs = 10_000) {
  if (process.platform !== 'linux') throw new TerminalProcessError('terminal_drain_unsupported', 'Terminal kapatılamadı', 503);
  const encoded = Buffer.from(JSON.stringify({ ...input, timeoutMs })).toString('base64');
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/python3', ['-c', OWNED_PROCESS_PYTHON, encoded], {
      timeout: timeoutMs + 1000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch {}
      if (error || !value || value.error) {
        reject(new TerminalProcessError(/^terminal_drain_[a-z_]+$/.test(value?.error ?? '')
          ? value.error : 'terminal_drain_unverified', 'Terminal kapatılamadı', 503));
      } else resolve(value);
    });
  });
}

// Capture immediately in the spawning stack. Deferring this first fingerprint to
// an async helper could adopt a reused PID belonging to a different API child.
function readProcessIdentitySync(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TerminalProcessError('terminal_drain_identity_unavailable', 'Terminal kapatılamadı', 503);
    let fd;
    try {
      fd = openSync('/proc/' + value + '/stat', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd), buffer = Buffer.alloc(8193);
      if (!before.isFile()) throw new Error('not regular');
      const bytes = readSync(fd, buffer, 0, buffer.length, null), after = fstatSync(fd);
      if (bytes >= buffer.length || before.ino !== after.ino || before.dev !== after.dev) throw new Error('identity drift');
      const text = buffer.subarray(0, bytes).toString('utf8'), end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
      if (end < 0 || fields.length < 20 || Number(text.slice(0, text.indexOf(' '))) !== value
        || !/^[0-9]+$/.test(fields[19])) throw new Error('invalid stat');
      const identity = { pid: value, ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), starttime: fields[19] };
      if (['ppid', 'pgid', 'sid'].some(key => !Number.isSafeInteger(identity[key]) || identity[key] < 1)) throw new Error('invalid identity');
      return Object.freeze(identity);
    } catch { throw new TerminalProcessError('terminal_drain_identity_unavailable', 'Terminal kapatılamadı', 503); }
    finally { if (fd !== undefined) closeSync(fd); }
}

export function captureOwnedTerminalIdentity(pid) {
  if (process.platform !== 'linux') throw new TerminalProcessError('terminal_drain_unsupported', 'Terminal kapatılamadı', 503);
  const root = readProcessIdentitySync(pid), creator = readProcessIdentitySync(process.pid);
  if (root.ppid !== creator.pid) throw new TerminalProcessError('terminal_drain_identity_unavailable', 'Terminal kapatılamadı', 503);
  return Object.freeze({ root, creator });
}

// Called once, before any API registry/runtime initialization or listener. This
// is an observation of the existing service boundary, never cgroup management.
export function captureTerminalGenerationBoundary() {
  const unknown = () => Object.freeze({ version: 1, verified: false, code: 'terminal_drain_generation_unknown' });
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return unknown();
  try {
    function trustedDirectory(directory) {
      if (realpathSync(directory) !== directory) throw new Error('noncanonical directory');
      const value = lstatSync(directory);
      if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== 0 || value.gid !== 0 || (value.mode & 0o022)) throw new Error('untrusted directory');
    }
    function boundedFile(file, limit, { rootOwned = false } = {}) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd), buffer = Buffer.alloc(limit + 1);
        if (!before.isFile() || rootOwned && (before.uid !== 0 || before.gid !== 0 || (before.mode & 0o022))) throw new Error('untrusted file');
        let size = 0;
        while (size <= limit) {
          const count = readSync(fd, buffer, size, buffer.length - size, null);
          if (count === 0) break;
          size += count;
        }
        const after = fstatSync(fd), current = lstatSync(file);
        if (size > limit || before.ino !== after.ino || before.dev !== after.dev || before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink()) throw new Error('file drift');
        return buffer.subarray(0, size);
      } finally { closeSync(fd); }
    }
    function emptySocketNamespace() {
      trustedDirectory('/etc'); trustedDirectory('/run');
      const groups = boundedFile('/etc/group', 1024 * 1024, { rootOwned: true }).toString('utf8').split('\n').filter(line => line.startsWith('yunpanel:'));
      if (groups.length !== 1 || !/^[0-9]+$/.test(groups[0].split(':')[2])) throw new Error('gateway group unknown');
      const gid = Number(groups[0].split(':')[2]);
      if (!Number.isSafeInteger(gid) || gid < 1) throw new Error('gateway group invalid');
      const parent = '/run/yunpanel', root = parent + '/ttyd';
      const absent = file => { try { lstatSync(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
      const same = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
      const managed = (file, modes) => {
        const value = lstatSync(file, { bigint: true });
        if (realpathSync(file) !== file || !value.isDirectory() || value.isSymbolicLink() || value.uid !== 0n
          || value.gid !== BigInt(gid) || !modes.includes(Number(value.mode & 0o7777n))) throw new Error('socket directory untrusted');
        return value;
      };
      const missing = () => ({ path: root, empty: true, exists: false, dev: null, ino: null, gid, mode: null });
      if (absent(parent)) { if (!absent(parent)) throw new Error('socket parent drift'); return missing(); }
      const parentBefore = managed(parent, [0o1777, 0o2770]);
      let fd;
      try {
        try { fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) {
          if (error.code !== 'ENOENT' || !same(parentBefore, managed(parent, [0o1777, 0o2770])) || !absent(root)) throw error;
          return missing();
        }
        const before = fstatSync(fd, { bigint: true }), pathBefore = managed(root, [0o2770]);
        if (!same(before, pathBefore)) throw new Error('socket directory drift');
        // Opening this own /proc FD link reads the already pinned directory;
        // no child entry is followed, inventoried recursively, or removed.
        const directory = opendirSync('/proc/' + process.pid + '/fd/' + fd, { bufferSize: 1 });
        try { if (directory.readSync() !== null) throw new Error('old socket namespace not empty'); }
        finally { directory.closeSync(); }
        if (!same(before, fstatSync(fd, { bigint: true })) || !same(before, managed(root, [0o2770]))
          || !same(parentBefore, managed(parent, [0o1777, 0o2770]))) throw new Error('socket namespace drift');
        return { path: root, empty: true, exists: true, dev: String(before.dev), ino: String(before.ino), gid, mode: 0o2770 };
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    for (const directory of ['/usr', '/usr/bin']) trustedDirectory(directory);
    const command = '/usr/bin/systemctl', commandInfo = lstatSync(command);
    if (realpathSync(command) !== command || !commandInfo.isFile() || commandInfo.uid !== 0 || commandInfo.gid !== 0 || (commandInfo.mode & 0o022)) throw new Error('untrusted systemctl');
    const api = readProcessIdentitySync(process.pid);
    const properties = ['MainPID', 'Id', 'ControlGroup', 'KillMode', 'SendSIGKILL', 'FragmentPath'];
    // execFileSync has reaped this one observer child before cgroup.procs is read.
    const raw = execFileSync(command, ['show', 'yunpanel-api.service', ...properties.map(key => '--property=' + key)],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = raw.trim().split('\n');
    if (lines.length !== properties.length) throw new Error('incomplete properties');
    const rows = lines.map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; });
    const effective = Object.fromEntries(rows);
    if (new Set(rows.map(row => row[0])).size !== properties.length || rows.some(row => !properties.includes(row[0]))
      || effective.Id !== 'yunpanel-api.service' || effective.MainPID !== String(process.pid)
      || effective.ControlGroup !== '/system.slice/yunpanel-api.service' || effective.KillMode !== 'control-group'
      || effective.SendSIGKILL !== 'yes') throw new Error('service boundary unknown');
    const fragment = realpathSync(effective.FragmentPath);
    if (!['/usr/lib/systemd/system/yunpanel-api.service', '/lib/systemd/system/yunpanel-api.service'].includes(fragment)) throw new Error('unit path unknown');
    let ancestor = fragment.slice(0, fragment.lastIndexOf('/'));
    while (ancestor !== '') { trustedDirectory(ancestor); ancestor = ancestor.slice(0, ancestor.lastIndexOf('/')); }
    const unitSha256 = createHash('sha256').update(boundedFile(fragment, 64 * 1024, { rootOwned: true })).digest('hex');
    for (const directory of ['/sys', '/sys/fs', '/sys/fs/cgroup', '/sys/fs/cgroup/system.slice', '/sys/fs/cgroup/system.slice/yunpanel-api.service']) trustedDirectory(directory);
    if (statfsSync('/sys/fs/cgroup').type !== 0x63677270) throw new Error('cgroup v2 required');
    const procGroup = boundedFile('/proc/' + process.pid + '/cgroup', 4096).toString('utf8');
    if (procGroup !== '0::/system.slice/yunpanel-api.service\n') throw new Error('unexpected API cgroup');
    const members = boundedFile('/sys/fs/cgroup/system.slice/yunpanel-api.service/cgroup.procs', 1024 * 1024, { rootOwned: true }).toString('utf8').trim().split('\n');
    if (members.length !== 1 || members[0] !== String(process.pid)
      || JSON.stringify(readProcessIdentitySync(process.pid)) !== JSON.stringify(api)) throw new Error('prior generation or process drift');
    const socketNamespace = emptySocketNamespace();
    return Object.freeze({ version: 1, verified: true, source: 'systemd_cgroup_v2', unit: effective.Id,
      cgroup: effective.ControlGroup, killMode: 'control-group', sendSigkill: true, onlyCurrentApiMember: true,
      api, socketNamespace: Object.freeze(socketNamespace), unitSha256, observedAt: new Date().toISOString() });
  } catch { return unknown(); }
}

export async function createOwnedTerminalLifecycle({ seed, childExit, socketPath = null } = {}) {
  if (!seed?.root || !seed.creator || !childExit || typeof childExit.then !== 'function') throw new TypeError('Terminal child identity is required');
  let evidence = await ownedProcessCommand({ mode: 'initial', seed, socketPath });
  let draining = null;
  return Object.freeze({
    async snapshot() {
      evidence = await ownedProcessCommand({ mode: 'capture', evidence, socketPath });
      return structuredClone(evidence);
    },
    drain({ timeoutMs = 30_000 } = {}) {
      if (draining) return draining;
      const deadline = performance.now() + timeoutMs;
      draining = (async () => {
        const result = await ownedProcessCommand({ mode: 'drain', evidence }, timeoutMs);
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new TerminalProcessError('terminal_drain_timeout', 'Terminal kapatılamadı', 503);
        let timer;
        try { await Promise.race([childExit, new Promise((_, reject) => { timer = setTimeout(() => reject(new TerminalProcessError('terminal_drain_timeout', 'Terminal kapatılamadı', 503)), remaining); })]); }
        finally { clearTimeout(timer); }
        return result;
      })();
      draining.catch(() => { draining = null; });
      return draining;
    },
  });
}

export function recoverOwnedTerminalLease(entry, { timeoutMs = 30_000 } = {}) {
  return ownedProcessCommand({ mode: 'drain', evidence: entry.evidence }, timeoutMs);
}

export function assertOwnedTerminalSupport() {
  return ownedProcessCommand({ mode: 'support' });
}

// Install before inspecting PID or awaiting setup. A real ChildProcess can emit
// asynchronous spawn failure with no PID and no subsequent exit event.
export function observeTerminalChild(child, { onExit = () => {}, onError = () => {} } = {}) {
  if (!child || typeof child.once !== 'function' || typeof child.on !== 'function' || typeof onExit !== 'function' || typeof onError !== 'function') throw new TypeError('Terminal child observers are required');
  let resolveExit, exited = false, spawnFailed = false;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  child.on('error', () => {
    spawnFailed = !Number.isSafeInteger(child.pid) || child.pid < 1;
    if (spawnFailed) { exited = true; resolveExit(); }
    try { onError({ spawnFailed }); } catch {}
  });
  child.once('exit', () => {
    exited = true; resolveExit();
    try { onExit(); } catch {}
  });
  return Object.freeze({ exit, hasExited: () => exited, failedToSpawn: () => spawnFailed });
}

export class TerminalProcessError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TerminalProcessError';
    this.code = code;
    this.status = status;
  }
}

function dimensions(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  if (!Number.isSafeInteger(cols) || cols < 20 || cols > 500
    || !Number.isSafeInteger(rows) || rows < 5 || rows > 200) {
    throw new TerminalProcessError('terminal_dimensions_invalid', 'Terminal dimensions are invalid');
  }
  return { cols, rows };
}

export function createTerminalProcessManager({
  liveSessions = null,
  spawnPty = nodePty.spawn ?? nodePty.default?.spawn,
  statFn = stat,
  realpathFn = realpath,
  readPasswd = () => readFile('/etc/passwd', 'utf8'),
  getuid = process.getuid?.bind(process) ?? (() => 1000),
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  killGraceMs = 2_000,
  onDrainError = null,
} = {}) {
  if (typeof spawnPty !== 'function' || typeof statFn !== 'function' || typeof realpathFn !== 'function'
    || typeof readPasswd !== 'function' || typeof getuid !== 'function' || typeof killProcessGroup !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
    || (onDrainError !== null && typeof onDrainError !== 'function')
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > 10_000) {
    throw new TypeError('Terminal process dependencies are invalid');
  }

  function reportDrainError(websiteId, error) {
    const line = formatTerminalDrainFailureLine({ backend: 'node-pty', websiteId, error });
    try {
      if (onDrainError) onDrainError({ backend: 'node-pty', websiteId, line });
      else console.error(line);
    } catch {}
  }

  async function open({ target, cols, rows, onData, onExit, signal: abortSignal = null } = {}) {
    if (typeof onData !== 'function' || typeof onExit !== 'function') {
      throw new TypeError('Terminal process callbacks are required');
    }
    if (abortSignal !== null && !(abortSignal instanceof AbortSignal)) throw new TypeError('Terminal abort signal is invalid');
    const isRoot = getuid() === 0;
    if (!isRoot && process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
      throw new TerminalProcessError('terminal_root_runtime_required', 'Terminal runtime requires the root panel service', 503);
    }
    const size = dimensions(cols, rows);
    const websiteId = target?.scope === 'site' ? target.websiteId : null;
    let child, seed, lifecycle, initialization, lease, cancelled = false, completeOpen, spawnAttempted = false;
    const opened = new Promise(resolve => { completeOpen = resolve; });
    const drain = async (options) => {
      cancelled = true;
      await lease.awaitRemovalDecision();
      await opened;
      if (!spawnAttempted) return lease.settleWithoutProcess();
      if (!lifecycle) throw new TerminalProcessError('terminal_drain_evidence_unavailable', 'Terminal kapatılamadı', 503);
      const result = await lifecycle.drain(options);
      return lease.finish(result);
    };
    if (websiteId !== null) {
      if (!liveSessions?.beginWebsiteOpen) throw new TerminalProcessError('terminal_drain_evidence_unavailable', 'Terminal kullanılamıyor', 503);
      lease = liveSessions.beginWebsiteOpen({ websiteId, backend: 'node-pty',
        snapshot: async () => {
          if (!spawnAttempted) return { version: 1, started: false };
          await initialization;
          if (!lifecycle) throw new TerminalProcessError('terminal_drain_evidence_unavailable', 'Terminal kapatılamadı', 503);
          return lifecycle.snapshot();
        }, stop: () => { void drain().catch((error) => reportDrainError(websiteId, error)); }, drain });
    }
    const abort = () => { cancelled = true; if (lease) void drain().catch((error) => reportDrainError(websiteId, error)); };
    if (abortSignal?.aborted) abort();
    else abortSignal?.addEventListener('abort', abort, { once: true });
    try {
    const resolved = await resolveTerminalTarget(target, {
      statFn,
      realpathFn,
      readPasswd,
      errorFactory: (code, message, status) => new TerminalProcessError(code, message, status),
    });

    const fileToSpawn = isRoot ? resolved.file : (resolved.directFile ?? resolved.file);
    const argsToSpawn = isRoot ? resolved.args : (resolved.directArgs ?? resolved.args);

    if (lease) await assertOwnedTerminalSupport();
    if (lease?.isFenced() || cancelled) throw new TerminalProcessError('terminal_website_removing', 'Site siliniyor', 409);
    try {
      spawnAttempted = true;
      child = spawnPty(fileToSpawn, argsToSpawn, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: resolved.cwd,
        env: resolved.env,
      });
      if (lease) seed = captureOwnedTerminalIdentity(child.pid);
    } catch {
      throw new TerminalProcessError('terminal_spawn_failed', 'Terminal process could not be started', 503);
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1
      || typeof child.onData !== 'function' || typeof child.onExit !== 'function'
      || typeof child.write !== 'function' || typeof child.resize !== 'function') {
      if (!lease) { try { child?.kill?.('SIGKILL'); } catch {} }
      throw new TerminalProcessError('terminal_spawn_failed', 'Terminal process could not be started', 503);
    }

    let closed = false;
    let exited = false;
    let forceTimer = null;
    let dataSubscription;
    let exitSubscription;
    let childExitResolve;
    const childExit = new Promise(resolve => { childExitResolve = resolve; });
    dataSubscription = child.onData((data) => {
      if (!closed && typeof data === 'string') onData(data);
    });
    exitSubscription = child.onExit((event) => {
      if (exited) return;
      exited = true;
      closed = true;
      if (forceTimer !== null) clearTimer(forceTimer);
      dataSubscription?.dispose?.();
      exitSubscription?.dispose?.();
      childExitResolve();
      if (lease) void drain().catch((error) => reportDrainError(websiteId, error));
      onExit({ exitCode: Number.isInteger(event?.exitCode) ? event.exitCode : null, signal: Number.isInteger(event?.signal) ? event.signal : null });
    });
    if (lease) {
      initialization = createOwnedTerminalLifecycle({ seed, childExit });
      lifecycle = await initialization;
      completeOpen();
      await lease.awaitRemovalDecision();
      if (lease.isFenced() || cancelled) {
        await drain();
        throw new TerminalProcessError('terminal_website_removing', 'Site siliniyor', 409);
      }
    }

    function signal(signalName) {
      try { killProcessGroup(child.pid, signalName); }
      catch {
        try { child.kill?.(signalName); } catch {}
      }
    }

    function close() {
      if (closed) return false;
      closed = true;
      if (lease) { void drain().catch((error) => reportDrainError(websiteId, error)); return true; }
      signal('SIGHUP');
      if (!exited) {
        forceTimer = setTimer(() => { if (!exited) signal('SIGKILL'); }, killGraceMs);
        forceTimer?.unref?.();
      }
      return true;
    }

    return Object.freeze({
      pid: child.pid,
      target,
      write(data) {
        if (closed) throw new TerminalProcessError('terminal_closed', 'Terminal process is closed', 409);
        if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
          throw new TerminalProcessError('terminal_input_invalid', 'Terminal input is invalid');
        }
        child.write(data);
      },
      resize(nextCols, nextRows) {
        if (closed) throw new TerminalProcessError('terminal_closed', 'Terminal process is closed', 409);
        const next = dimensions(nextCols, nextRows);
        child.resize(next.cols, next.rows);
      },
      close,
      ...(lease ? { drain } : {}),
    });
    } catch (error) {
      completeOpen();
      if (!spawnAttempted) lease?.settleWithoutProcess();
      throw error;
    } finally { completeOpen(); abortSignal?.removeEventListener('abort', abort); }
  }

  return Object.freeze({ open });
}

export const terminalProcessInternals = Object.freeze({
  ownedProcessPython: OWNED_PROCESS_PYTHON,
  shellPath: terminalTargetInternals.shellPath,
  runuserPath: terminalTargetInternals.runuserPath,
  maxInputBytes: MAX_INPUT_BYTES,
  dimensions,
  terminalEnvironment: terminalTargetInternals.terminalEnvironment,
  parseManagedAccount: (passwdText, user) => terminalTargetInternals.parseManagedAccount(
    passwdText,
    user,
    (code, message, status) => new TerminalProcessError(code, message, status),
  ),
  resolveTarget: (target, dependencies) => resolveTerminalTarget(target, {
    ...dependencies,
    errorFactory: (code, message, status) => new TerminalProcessError(code, message, status),
  }),
});
