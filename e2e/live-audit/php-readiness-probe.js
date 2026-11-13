import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { envFile, manifest, ORIGIN, RUN_DIR } from './runtime.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TARGET = '157.180.11.28';
const REASONS = new Set(['php_fpm_identity_unavailable', 'php_fpm_document_root_missing', 'php_fpm_package_missing',
  'php_fpm_pool_missing', 'php_fpm_config_invalid', 'php_fpm_service_inactive', 'php_fpm_socket_missing', 'php_fpm_socket_drift']);
const FIELDS = ['phase', 'attempts', 'elapsedMs', 'firstSatisfied', 'lastSatisfied', 'firstReason', 'lastReason',
  'firstListenerObserved', 'lastListenerObserved', 'listenerObserved'];
const PROJECTION_STAGES = new Set(['start', 'input-identity', 'target-address', 'api-process', 'store-location',
  'store-ancestors', 'store-file', 'store-format', 'operation-identity', 'runtime-evidence', 'readiness-shape', 'projection']);

function verifyObservation(value, phase) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...FIELDS].sort());
  assert.equal(value.phase, phase); assert.ok(Number.isInteger(value.attempts) && value.attempts >= 1 && value.attempts <= 40);
  assert.ok(Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0);
  for (const key of ['firstSatisfied', 'lastSatisfied', 'firstListenerObserved', 'lastListenerObserved', 'listenerObserved']) {
    assert.ok(value[key] === null || typeof value[key] === 'boolean');
  }
  for (const key of ['firstReason', 'lastReason']) assert.ok(value[key] === null || REASONS.has(value[key]));
  assert.equal(value.lastSatisfied, true); assert.equal(value.lastReason, null);
  assert.equal(value.listenerObserved, value.lastListenerObserved);
  if (phase === 'after_umask') for (const key of ['firstListenerObserved', 'lastListenerObserved', 'listenerObserved']) assert.equal(value[key], null);
  else assert.equal(value.lastListenerObserved, true);
}

// This reads only the exact normal API-owned php_runtime step. No registry mutation or host service control.
export function readOwnedPhpReadiness(fixture) {
  const ledger = fixture.ledger, run = manifest();
  assert.ok(process.env.YUNPANEL_AUDIT_RUN_DIR && path.basename(RUN_DIR) !== 'current');
  assert.match(ledger.key, /^t889-[a-z0-9-]{1,38}$/); assert.equal(ledger.runtime, 'php');
  for (const field of ['websiteId', 'applicationId', 'domainId', 'serverId', 'provisioningId']) assert.match(ledger[field], UUID);
  assert.equal(ledger.operationId, ledger.provisioningId); assert.equal(ledger.runId, run.runId);
  assert.equal(ledger.origin, ORIGIN); assert.equal(ledger.target, TARGET); assert.equal(run.target, TARGET); assert.equal(run.origin, ORIGIN);
  assert.equal(envFile('.local/test-server.env').YUNPANEL_TEST_SERVER_HOST, TARGET);
  assert.equal(ledger.hostname, `ypaudit-${ledger.key}-${ledger.nonce}.${TARGET}.sslip.io`);
  const file = path.join(RUN_DIR, 'owned-fixtures', ledger.key + '.json');
  assert.equal(fs.realpathSync(file), path.resolve(file)); assert.ok((fs.statSync(file).mode & 0o077) === 0);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const field of ['key', 'runId', 'websiteId', 'applicationId', 'domainId', 'serverId', 'provisioningId', 'hostname']) assert.equal(stored[field], ledger[field]);
  const helper = fs.realpathSync(path.resolve(process.env.YUNPANEL_AUDIT_HOST_HELPER ?? ''));
  assert.equal(helper, fs.realpathSync('.local/reinstall-20261011/host.py'), 'Only the actual pinned host helper is permitted');
  assert.equal(path.extname(helper), '.py'); assert.ok(fs.statSync(helper).isFile());
  const payload = Buffer.from(JSON.stringify(Object.fromEntries(['websiteId', 'applicationId', 'domainId', 'serverId', 'provisioningId', 'hostname'].map(k => [k, ledger[k]])))).toString('base64');
  const projection = String.raw`import os,sys,json,stat,subprocess,base64,re,pwd
stage='input-identity'
p=json.loads(base64.b64decode(sys.argv[1]))
for k in ['websiteId','applicationId','domainId','serverId','provisioningId']:assert re.fullmatch('[a-f0-9-]{36}',p[k])
assert re.fullmatch(r'ypaudit-t889-[a-z0-9.-]+\.157\.180\.11\.28\.sslip\.io',p['hostname'])
stage='target-address'
addresses=json.loads(subprocess.check_output(['ip','-j','-4','addr'],text=True))
assert any(a.get('local')=='157.180.11.28' for i in addresses for a in i.get('addr_info',[]))
stage='api-process'
pid=subprocess.check_output(['/usr/bin/systemctl','show','yunpanel-api','--property=MainPID','--value'],text=True).strip();assert re.fullmatch('[1-9][0-9]*',pid)
cwd=os.readlink('/proc/'+pid+'/cwd');assert os.path.isabs(cwd)
# Read only the two store-path fields; never project or print the full environment.
selected={}
for row in open('/proc/'+pid+'/environ','rb').read().split(b'\0'):
 key,sep,value=row.partition(b'=')
 if sep and key in [b'YUNPANEL_SERVER_STORE',b'YUNPANEL_WEBSITE_PROVISIONING_STORE']:selected[key.decode()]=value.decode()
server_store=selected.get('YUNPANEL_SERVER_STORE',os.path.join(cwd,'.data/server-registry.json'))
effective=selected.get('YUNPANEL_WEBSITE_PROVISIONING_STORE',os.path.join(os.path.dirname(server_store),'website-provisioning-registry.json'))
store=os.path.normpath(effective if os.path.isabs(effective) else os.path.join(cwd,effective))
stage='store-location'
assert store.startswith('/var/lib/yunpanel/') and os.path.realpath(store)==store
stage='store-ancestors'
ancestor=''
for component in os.path.dirname(store).split('/')[1:]:
 ancestor+='/'+component;m=os.lstat(ancestor)
 assert stat.S_ISDIR(m.st_mode) and not stat.S_ISLNK(m.st_mode) and not(m.st_mode&0o022)
 if ancestor=='/var/lib/yunpanel/control-plane' and m.st_uid!=0:
  service=pwd.getpwnam('yunpanel')
  assert service.pw_uid>0 and service.pw_gid>0 and m.st_uid==service.pw_uid and m.st_gid==service.pw_gid and stat.S_IMODE(m.st_mode)==0o700
 else:assert m.st_uid==0
stage='store-file'
m=os.lstat(store);assert stat.S_ISREG(m.st_mode) and not stat.S_ISLNK(m.st_mode) and m.st_uid==0 and stat.S_IMODE(m.st_mode)==0o600 and m.st_size<=67108864
stage='store-format'
d=json.load(open(store));assert d['version']==1 and isinstance(d['operations'],list)
stage='operation-identity'
owned=[o for o in d['operations'] if o.get('operationId')==p['provisioningId']];assert len(owned)==1
o=owned[0];assert o['websiteId']==p['websiteId']
r=o['resources'];assert r['website']['id']==p['websiteId'] and r['website']['applicationId']==p['applicationId'] and r['website']['serverId']==p['serverId'] and r['website']['name']==p['hostname']
assert r['primaryDomain']['id']==p['domainId'] and r['primaryDomain']['primaryDomain']==p['hostname']
stage='runtime-evidence'
steps=[s for s in o['steps'] if s['id']=='php_runtime'];assert len(steps)==1
s=steps[0];assert s['state']=='succeeded';e=s['evidence']
assert e['adapter']=='php-fpm' and e['satisfied']==True and e['applicationId']==p['applicationId'] and e['websiteId']==p['websiteId']
assert isinstance(e.get('readiness'),dict) and set(e['readiness'])=={'poolActivation','afterUmask'}
stage='readiness-shape'
fields={'phase','attempts','elapsedMs','firstSatisfied','lastSatisfied','firstReason','lastReason','firstListenerObserved','lastListenerObserved','listenerObserved'}
projected={}
for name in ['poolActivation','afterUmask']:
 v=e['readiness'][name];assert isinstance(v,dict) and set(v)==fields
 projected[name]={key:v[key] for key in sorted(fields)}
stage='projection'
print(json.dumps({'operationId':o['operationId'],'websiteId':o['websiteId'],'applicationId':p['applicationId'],'domainId':p['domainId'],'state':s['state'],'readiness':projected,'source':'exact-owned-durable-php-runtime-step','effectiveStore':store}))`;
  const code = "import sys,json\nstage='start'\ntry:\n"
    + projection.split('\n').map(line => ' ' + line).join('\n')
    + "\nexcept Exception as error:\n print(json.dumps({'readOnlyProjectionFailed':True,'stage':stage,'errorClass':type(error).__name__}))\n sys.exit(2)";
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  let result;
  try {
    result = JSON.parse(execFileSync('python3', [helper, 'python3 -c ' + quote(code) + ' ' + quote(payload)],
      {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']}));
  } catch (error) {
    let stage = 'transport', errorClass = 'UnconfirmedRead';
    try {
      const diagnostic = JSON.parse(String(error.stdout ?? ''));
      if (diagnostic.readOnlyProjectionFailed === true && PROJECTION_STAGES.has(diagnostic.stage)
        && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(diagnostic.errorClass ?? '')) {
        stage = diagnostic.stage; errorClass = diagnostic.errorClass;
      }
    } catch { /* Never expose SSH/Python stderr, environment or protected store bytes. */ }
    const failure = new Error('Exact owned PHP readiness read-only projection failed at ' + stage + ' (' + errorClass + '); protected diagnostics withheld');
    failure.code = 'php_readiness_projection_failed'; failure.stage = stage; failure.errorClass = errorClass;
    throw failure;
  }
  assert.equal(result.operationId, ledger.provisioningId); assert.equal(result.websiteId, ledger.websiteId);
  assert.equal(result.applicationId, ledger.applicationId); assert.equal(result.domainId, ledger.domainId);
  assert.equal(result.state, 'succeeded'); assert.equal(result.source, 'exact-owned-durable-php-runtime-step');
  verifyObservation(result.readiness.poolActivation, 'pool_activation'); verifyObservation(result.readiness.afterUmask, 'after_umask');
  return result;
}
