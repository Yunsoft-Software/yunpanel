import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { apiContext, manifest, RUN_DIR, main, ready } from './runtime.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const source={kind:'new_node',repositoryUrl:'https://github.com/heroku/node-js-getting-started.git',branch:'main',retention:2,
  runtime:{nodeMajor:24,installMode:'ci',buildScript:null,startMode:'node',entryFile:'index.js',healthPath:'/',healthTimeoutSeconds:30,restartPolicy:'on-failure'}};
const sha=value=>createHash('sha256').update(value).digest('hex');
const accepted=(reply,status=200)=>{expect(reply.status).toBe(status);return reply.data;};
const KEY='T913_RETIREMENT_PROOF';

test.describe.serial('T913 normal Passenger environment retirement',()=>{
 let actor,project,active=false,cleanup=false,hold=false,finished=false,protectedPhp,phpProof,baseline,phase='work',cleanupKey=null;
 const fixtures=new Map(),started=new Set(),completed=new Set(),pending=new Set();
 const proof={version:1,cases:[],cleanup:[],unknownAcceptedMutation:false,cleanupFailures:[],nativeFaultChannels:'OPEN'};
 const file=()=>path.join(RUN_DIR,'t913-native-passenger-environment-retirement.json');
 const cleanupTitle='@mutation removes every exact Passenger fixture and verifies include absence before protected PHP last';
 const artifact=(id,suffix)=>path.join(RUN_DIR,'native29-dispatch-'+id+'-'+suffix+'.json');
 function durable(id,suffix,value){expect(fs.realpathSync(RUN_DIR)).toBe(RUN_DIR);const root=fs.lstatSync(RUN_DIR);expect(root.isDirectory()&&!root.isSymbolicLink()).toBe(true);expect(root.uid).toBe(process.getuid());expect(root.mode&0o777).toBe(0o700);
   const fd=fs.openSync(artifact(id,suffix),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   try{const meta=fs.fstatSync(fd);expect(meta.isFile()&&meta.uid===process.getuid()&&meta.nlink===1&&(meta.mode&0o777)===0o600).toBe(true);const bytes=Buffer.from(JSON.stringify(value));expect(bytes.length).toBeLessThan(4096);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);expect(fs.fstatSync(fd).size).toBe(bytes.length);}finally{fs.closeSync(fd);}
   const parent=fs.openSync(RUN_DIR,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
 function save(){const temporary=file()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(proof,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file());}
 function keep(reason){hold=true;active=false;cleanup=false;cleanupKey=null;phase='hold';proof.outcome='UNKNOWN_KEEP';proof.keepReason=reason;
   if(!fs.existsSync(artifact('suite','keep')))durable('suite','keep',{version:1,outcome:'UNKNOWN_KEEP',reason,at:new Date().toISOString(),automaticRetry:false});save();}
 function cleanupLedger(){expect([...fixtures.values()].some(f=>f.ledger.key===cleanupKey)).toBe(true);const p=path.join(RUN_DIR,'owned-fixtures',cleanupKey+'.json');expect(fs.realpathSync(p)).toBe(p);
   const identity=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs],before=fs.lstatSync(p),fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   try{const m=fs.fstatSync(fd);expect(m.isFile()&&m.uid===process.getuid()&&m.nlink===1&&(m.mode&0o777)===0o600&&m.size<4194304).toBe(true);expect(identity(before)).toEqual(identity(m));
     const chunks=[];let size=0;while(size<=4194304){const b=Buffer.alloc(Math.min(65536,4194305-size)),n=fs.readSync(fd,b,0,b.length,null);if(!n)break;size+=n;chunks.push(b.subarray(0,n));}expect(size).toBe(m.size);expect(identity(fs.fstatSync(fd))).toEqual(identity(m));expect(identity(fs.lstatSync(p))).toEqual(identity(m));
     const ledger=JSON.parse(Buffer.concat(chunks)),expected=[...fixtures.values()].find(f=>f.ledger.key===cleanupKey).ledger;for(const k of ['key','runId','serverId','websiteId','applicationId','domainId','unixUser','documentRoot','nonce','hostname','origin'])expect(ledger[k]).toBe(expected[k]);expect(ledger.target).toBe('157.180.11.28');expect(ledger.baselineSiteIds).not.toContain(ledger.websiteId);return ledger;
   }finally{fs.closeSync(fd);}}
 function dispatchGate(method,route,current){try{expect(hold,'UNKNOWN_KEEP forbids further mutations').toBe(false);expect(fs.existsSync(artifact('suite','keep'))).toBe(false);expect((proof.dispatch??[]).filter(r=>r!==current).every(r=>r.responseKnown)).toBe(true);
   if(phase==='work'){expect(active).toBe(true);expect(cleanup).toBe(false);}else{expect(phase).toBe('cleanup');expect(cleanup).toBe(true);expect(active).toBe(false);expect(completed.size).toBe(4);expect([...started].every(k=>completed.has(k))).toBe(true);const ledger=cleanupLedger();
     expect(method==='POST'&&route==='/api/panel/websites/'+ledger.websiteId+'/removal'||method==='POST'&&/^ws-rem-[a-f0-9-]{36}$/.test(ledger.removalId??'')&&route==='/api/panel/website-removal-operations/'+ledger.removalId+'/continue'||method==='DELETE'&&(ledger.backups??[]).some(r=>r.target==='/var/lib/yunpanel/backups/restic/repos/'+r.id&&route==='/api/panel/backups/repositories/'+r.id)).toBe(true);}
   }catch(error){keep('dispatch-gate');throw error;}}
 function guard(context){const actual=context.api;return{...context,api:new Proxy(actual,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
   if(!['fetch','post','put','patch','delete'].includes(key))return value.bind(target);
   return(...args)=>{const method=key==='fetch'?String(args[1]?.method??'GET').toUpperCase():String(key).toUpperCase();if(['GET','HEAD'].includes(method))return value.apply(target,args);
    const route=String(args[0]).split('?')[0];dispatchGate(method,route);
    const record={id:randomBytes(12).toString('hex'),method,route,issuedAt:new Date().toISOString(),responseKnown:false};proof.dispatch??=[];proof.dispatch.push(record);durable(record.id,'intent',{version:1,...record,phase});save();
    let request;
    try{dispatchGate(method,route,record);request=value.apply(target,args);}catch(error){proof.unknownAcceptedMutation=true;keep('mutation-dispatch-unknown');throw error;}
    const joined=Promise.resolve(request).then(async response=>{record.status=response.status();
      if([200,201,202].includes(record.status)){try{const body=await response.json();expect(body&&typeof body==='object').toBeTruthy();}catch{proof.unknownAcceptedMutation=true;keep('accepted-mutation-body-unknown');throw new Error('UNKNOWN_KEEP: accepted mutation identity was not readable');}}
      durable(record.id,'response',{version:1,id:record.id,status:record.status,at:new Date().toISOString()});record.responseKnown=true;
      save();return response;
    },error=>{proof.unknownAcceptedMutation=true;keep('mutation-transport-unknown');throw error;});
    pending.add(joined);joined.then(()=>pending.delete(joined),()=>pending.delete(joined));return joined;
   };
 }} )};}
 async function caseBody(name,action){expect(hold).toBe(false);expect(phase).toBe('work');expect(pending.size).toBe(0);started.add(name);active=true;
   try{await action();await Promise.allSettled([...pending]);expect(pending.size).toBe(0);expect(hold).toBe(false);completed.add(name);}
   catch(error){keep('case-did-not-complete');throw error;}finally{active=false;save();}}
 async function originals(){const rows=accepted(await actorCall('GET','/api/panel/websites'));return rows.filter(w=>manifest().baseline.websites.some(b=>b.id===w.id)).map(w=>({id:w.id,serverId:w.serverId,applicationId:w.applicationId,runtimeType:w.runtimeType,unixUser:w.unixUser,documentRoot:w.documentRoot,phpConfig:w.phpConfig??null})).sort((a,b)=>a.id.localeCompare(b.id));}
 async function actorCall(method,route,data){const response=await actor.api.fetch(route,{method,data,headers:{Origin:manifest().origin,'x-csrf-token':actor.csrf},maxRetries:0,maxRedirects:0,timeout:30000});const body=await response.json().catch(()=>null);return{status:response.status(),data:body?.data??body};}
 async function firstPhp(){const reply=await protectedPhp.http('/'+phpProof.name);expect(reply.status,'first protected dynamic reply must succeed').toBe(200);expect(reply.headers['cache-control']).toContain('no-store');expect(JSON.parse(reply.body)).toEqual({nonce:protectedPhp.ledger.nonce,version:phpProof.version,uid:phpProof.uid,sapi:'fpm-fcgi'});proof.protectedFirstResponses??=[];proof.protectedFirstResponses.push({at:new Date().toISOString(),status:reply.status,uid:phpProof.uid,version:phpProof.version,sapi:'fpm-fcgi',nonceMatched:true});save();}
 function include(f){const physical=readOnlyHostProbe(f,'lifecycle-absence'),meta=physical.passengerEnvironmentInclude;expect(meta?.path).toBe('/etc/yunpanel/passenger-env/'+f.ledger.applicationId+'.conf');expect(meta.parentTrustVerified).toBe(true);return{physical,meta};}
 async function environment(f){return accepted(await f.call('GET','/api/panel/applications/'+f.ledger.applicationId+'/environment/status'));}
 async function saveEnvironment(f){const before=await environment(f);accepted(await f.call('PUT','/api/panel/applications/'+f.ledger.applicationId+'/environment/'+KEY,{value:randomBytes(24).toString('hex'),secret:true}));const after=await environment(f);expect(after.savedRevision).toBe(before.savedRevision+1);return after;}
 async function applyEnvironment(f){const job=accepted(await f.call('POST',f.endpoint('/application/restart'),{}),202);expect(job.id).toMatch(/^[a-f0-9-]{36}$/);const terminal=await f.waitJob(job.id,180000);expect(terminal.status).toBe('succeeded');const status=await environment(f);expect(status.appliedRevision).toBe(status.savedRevision);return status;}
 async function nodeCase(kind,page){await firstPhp();const f=await createOwnedFixture(actor,{key:'t913-'+kind+'-'+project,runtime:'node',source});fixtures.set(kind,f);
   await ready(page,f.route('overview'));await expect(main(page)).toBeVisible();
   const initial=include(f);expect(initial.meta.exists).toBe(true);expect(initial.meta.regular).toBe(true);expect(initial.meta.symlink).toBe(false);expect(initial.meta.uid).toBe(0);expect(initial.meta.gid).toBe(0);expect(initial.meta.mode).toBe(0o600);expect(initial.meta.nlink).toBe(1);expect(initial.meta.stableRead).toBe(true);expect(initial.physical.environmentIncludeApplicationId).toBe(f.ledger.applicationId);expect(initial.physical.environmentIncludeRevision).toBe(0);
   let state=await environment(f);expect(state.savedRevision).toBe(0);expect(state.appliedRevision).toBe(0);
   if(kind!=='empty'){await saveEnvironment(f);state=await applyEnvironment(f);expect(state.appliedRevision).toBeGreaterThan(0);}
   if(kind==='saved'){const applied=state.appliedRevision;state=await saveEnvironment(f);expect(state.savedRevision).toBeGreaterThan(applied);expect(state.appliedRevision).toBe(applied);}
   const current=include(f);expect(current.meta.exists).toBe(true);expect(current.meta.stableRead).toBe(true);expect(current.physical.environmentIncludeRevision).toBe(state.appliedRevision);expect(current.meta.sha256).toMatch(/^[a-f0-9]{64}$/);
   if(kind!=='empty')expect(current.meta.sha256).not.toBe(initial.meta.sha256);
   const row={kind,key:f.ledger.key,websiteId:f.ledger.websiteId,applicationId:f.ledger.applicationId,domainId:f.ledger.domainId,provisioningId:f.ledger.provisioningId,initialIncludeSha256:initial.meta.sha256,appliedIncludeSha256:current.meta.sha256,savedRevision:state.savedRevision,appliedRevision:state.appliedRevision};proof.cases.push(row);f.record('passenger-retirement.ready',row);save();await firstPhp();expect(await originals()).toEqual(baseline);
 }
 test.beforeAll(async({},info)=>{expect(fs.existsSync(artifact('suite','started'))).toBe(false);expect(fs.existsSync(artifact('suite','keep'))).toBe(false);expect(fs.existsSync(file())).toBe(false);durable('suite','started',{version:1,project:info.project.name,workerIndex:info.workerIndex,at:new Date().toISOString(),automaticRetry:false});actor=guard(await apiContext());project=info.project.name.startsWith('firefox')?'ff-w0':'cr-w0';
   proof.startedAt=new Date().toISOString();const deployment=accepted(await actorCall('GET','/api/panel/system/diagnostics/version'));expect(deployment.sourceInfo.sourceMatchesDeployed).toBe(true);expect(deployment.buildVerified).toBe(true);expect(deployment.dirty).toBe(false);expect(deployment.commit).toBe(manifest().sourceCommit);proof.runtime={sourceCommit:deployment.commit,buildId:deployment.buildId,assetId:deployment.assetId};baseline=await originals();expect(baseline).toHaveLength(5);proof.originalWebsiteIds=baseline.map(w=>w.id);save();});
 test.afterEach(async({},info)=>{active=false;cleanup=false;cleanupKey=null;if(info.status!=='passed'||info.expectedStatus!=='passed'||hold||pending.size||(proof.dispatch??[]).some(r=>!r.responseKnown))keep('case-failed-timeout-or-unknown');});
 test.afterAll(async({},info)=>{const complete=finished&&!hold&&pending.size===0&&completed.size===4&&proof.cleanup.length===4&&(proof.dispatch??[]).every(r=>r.responseKnown)&&info.status==='passed';
   // Close synchronously before the first await; an old GET continuation cannot forward POST.
   phase='closed';active=false;cleanup=false;cleanupKey=null;if(!complete)keep('suite-closure-incomplete');
   try{await actor?.api.dispose();}catch(error){keep('context-close-failed');throw error;}await Promise.allSettled([...pending]);expect(complete,'UNKNOWN_KEEP: cleanup is an explicit bounded final test; afterAll performs no mutation').toBe(true);durable('suite','complete',{version:1,outcome:'COMPLETE',cases:completed.size,exactFixturesCleaned:proof.cleanup.length,at:new Date().toISOString()});});
 test('@mutation prepares a distinct protected PHP nonce control',async()=>{test.setTimeout(360000);await caseBody('protected',async()=>{
   protectedPhp=await createOwnedFixture(actor,{key:'t913-protect-'+project,runtime:'php'});fixtures.set('protected',protectedPhp);const config=accepted(await protectedPhp.call('GET',protectedPhp.endpoint('/php-tools/config'))),physical=readOnlyHostProbe(protectedPhp,'owned-site-files');expect(physical.uid).toBeGreaterThan(0);
   phpProof={name:'t913-protected-'+protectedPhp.ledger.nonce+'.php',version:config.phpVersion,uid:physical.uid};const body='<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(["nonce"=>'+JSON.stringify(protectedPhp.ledger.nonce)+',"version"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"sapi"=>PHP_SAPI]);';
   expect(accepted(await protectedPhp.call('GET',protectedPhp.endpoint('/files'))).entries.some(entry=>entry.name===phpProof.name)).toBe(false);await protectedPhp.upload(phpProof.name,body);expect((await protectedPhp.readText(phpProof.name)).sha256).toBe(sha(body));await firstPhp();
 });});
 for(const kind of ['empty','applied','saved'])test('@mutation records '+kind+' Passenger environment through normal API and real browser',async({page})=>{test.setTimeout(360000);await caseBody(kind,()=>nodeCase(kind,page));});
 test(cleanupTitle,async()=>{test.setTimeout(480000);expect(hold).toBe(false);expect(phase).toBe('work');expect([...started].sort()).toEqual(['applied','empty','protected','saved']);expect([...completed].sort()).toEqual(['applied','empty','protected','saved']);expect(pending.size).toBe(0);expect(fixtures.size).toBe(4);cleanup=true;phase='cleanup';
   try{for(const kind of ['empty','applied','saved','protected']){expect(hold).toBe(false);expect(phase).toBe('cleanup');expect(cleanup).toBe(true);if(kind!=='protected')await firstPhp();const f=fixtures.get(kind);cleanupKey=f.ledger.key;const ledger=await cleanupOwnedFixture(actor,{key:f.ledger.key});expect(ledger.removed).toBe(true);
     const current=include({ledger}),physical=current.physical;expect(current.meta.exists,'exact generated include must be physically absent after normal removal').toBe(false);expect(physical.unixUserExists).toBe(false);expect(physical.unixGroupExists).toBe(false);expect(physical.roots.every(r=>!r.exists)).toBe(true);expect(physical.nginxFiles.every(r=>!r.exists)).toBe(true);for(const field of ['fpmFiles','sockets','mounts'])expect(physical[field]).toEqual([]);
     let receipt=null;if(kind!=='protected'){const op=accepted(await actorCall('GET','/api/panel/website-removal-operations/'+ledger.removalId));expect(op.status).toBe('removed');const row=proof.cases.find(r=>r.kind===kind);for(const stepKind of ['file_cleanup','application_cleanup']){const step=op.steps.find(s=>s.kind===stepKind);expect(step.status).toBe('succeeded');const r=step.result.passengerEnvironmentRetirement;expect(r.removalId).toBe(op.id);expect(r.websiteId).toBe(ledger.websiteId);expect(r.applicationId).toBe(ledger.applicationId);expect(r.state).toBe('retired');expect(r.includeAbsent).toBe(true);expect(r.includeSha256).toBe(row.appliedIncludeSha256);expect(r.environmentRevision).toBe(row.appliedRevision);receipt=r;}await firstPhp();}
     proof.cleanup.push({kind,key:ledger.key,websiteId:ledger.websiteId,applicationId:ledger.applicationId,domainId:ledger.domainId,removalId:ledger.removalId,metadataAbsent:true,physicalAbsent:true,includeAbsent:true,retirement:receipt});save();expect(await originals()).toEqual(baseline);
   }expect(pending.size).toBe(0);expect(hold).toBe(false);expect(phase).toBe('cleanup');expect(cleanup).toBe(true);finished=true;proof.outcome='VERIFIED';proof.finishedAt=new Date().toISOString();save();}
   catch(error){keep('normal-cleanup-incomplete');throw error;}finally{cleanup=false;}
 });
});
