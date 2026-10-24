import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
const execute=promisify(execFile);
// Opt-in acceptance harness control only. No installed service or other host
// can be addressed, and the private SSH helper never prints access material.
export async function restartAcceptanceApi({operationId,websiteId}){
 const unit=process.env.YUNPANEL_AUDIT_ACCEPTANCE_UNIT,sha=process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA;
 const helper=path.resolve('.local/acceptance-candidate/host-control.py');
 if(!/^yunpanel-source-acceptance-20261010-v\d{1,3}$/.test(unit??'')||!/^[a-f0-9]{64}$/.test(sha??'')
  ||!/^ws-rem-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId??'')
  ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(websiteId??'')||!fs.existsSync(helper)){
  throw new Error('The private bounded native acceptance restart harness is required');
 }
 const script=`python3 - <<'PY'
from pathlib import Path
import json,subprocess,urllib.request,time
p=Path('/var/lib/yunpanel/acceptance-candidates/20261010-84576b66')
s=json.loads((p/'native-test-window.json').read_text())
assert s['target']=='157.180.11.28' and s['deployed'] is False and s['status']=='ready' and s['archiveSha256']=='${sha}'
assert subprocess.run(['systemctl','is-active','--quiet','${unit}']).returncode==0
env=json.loads((p/'runtime-env.json').read_text());stateRoot=Path(env['YUNPANEL_SERVER_STORE']).parent
store=Path(env.get('YUNPANEL_WEBSITE_REMOVAL_OPERATION_STORE',str(stateRoot/'website-removal-operations.json')))
assert store.is_relative_to(p/'state') and not store.is_symlink()
records=json.loads(store.read_text());op=next(record for record in records if record['id']=='${operationId}')
assert op['websiteId']=='${websiteId}' and op['execution']['mode']=='automatic' and op['actor']['role']=='owner'
assert op['status'] in ['pending','running']
r=subprocess.run(['systemctl','restart','${unit}'],capture_output=True,timeout=40);assert r.returncode==0
ready=False
for attempt in range(100):
 try:
  state=json.loads((p/'native-test-window.json').read_text())
  response=urllib.request.urlopen('http://127.0.0.1:3001/api/health',timeout=1)
  if state['status']=='ready' and response.headers.get('X-YunPanel-Acceptance-Source')=='${sha}':ready=True;break
 except Exception:pass
 time.sleep(.2)
assert ready
assert state['candidatePid']!=s['candidatePid'] and state['startedAt']>s['startedAt']
after=next(record for record in json.loads(store.read_text()) if record['id']=='${operationId}')
assert after['websiteId']==op['websiteId'] and after['actor']['userId']==op['actor']['userId'] and after['actor']['role']=='owner'
assert after['execution']['mode']=='automatic'
print(json.dumps({'restarted':True,'sourceReady':True,'sameJournal':True,'deployed':False}))
PY`;
 try{
  const result=await execute('python3',[helper,script],{timeout:60000,maxBuffer:8192});
  const line=result.stdout.split('\n').find(value=>value.startsWith('{'));
  const proof=JSON.parse(line??'null');
  if(proof?.restarted!==true||proof.sourceReady!==true||proof.sameJournal!==true||proof.deployed!==false)throw new Error('unverified');
  return proof;
 }catch{throw new Error('The bounded native API restart was not verified; private access material and command output were withheld');}
}
