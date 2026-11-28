import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,mkdir,access,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createNginxManager,createResticManager,createWebsiteRestoreReceiptStore,createWebsiteTrafficEnforcer} from '@yunpanel/host-runtime';
import {createApplicationEnvironmentRegistry} from '../src/applications/application-environment-registry.js';
import {createDomainRegistry} from '../src/domains/domain-registry.js';
import {createWebsiteBackupSetProvider} from '../src/backup/website-backup-set.js';
import {createWebsiteBackupService} from '../src/backup/website-backup-service.js';
import {createWebsiteEnvironmentBackupAdapter} from '../src/backup/website-environment-backup-adapter.js';
import {createWebsiteHostingBackupAdapter} from '../src/backup/website-hosting-backup-adapter.js';
import {createWebsiteResourceBackupCodec} from '../src/backup/website-resource-backup-codec.js';
import {createWebsiteRestoreService} from '../src/backup/website-restore-service.js';
import {createWebsiteTrafficCoordinator} from '../src/websites/website-traffic-coordinator.js';
import {safeLocalOperationError} from '../src/runtime/local-execution-error.js';

const sha256=value=>createHash('sha256').update(value).digest('hex');

// Real Domain registry, templates, atomic Nginx files and protected snapshots;
// nginx -t/systemctl are controlled host boundaries, not native acceptance.
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'yp-hosting-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const website={id:randomUUID(),serverId:randomUUID(),applicationId:randomUUID(),runtimeType:'static'};
 website.documentRoot='/var/www/yunpanel/apps/'+website.applicationId+'/current';
 const websiteRegistry={getWebsite:async id=>id===website.id?website:null};
 const domainRegistry=createDomainRegistry({filePath:path.join(root,'domains.json'),serverExists:async id=>id===website.serverId,
  websiteRegistry,getWebsite:websiteRegistry.getWebsite});
 await domainRegistry.init();const domain=await domainRegistry.createDomain({serverId:website.serverId,websiteId:website.id,
  primaryDomain:'owned.example.test',targetType:'static',target:{root:website.documentRoot},httpsMode:'off'});
 const configRoot=path.join(root,'active');await mkdir(configRoot);
 let rejectConfig=false;const commands=[];
 const factory=options=>createNginxManager({sitesDir:configRoot,stagingDir:path.join(root,'stage'),...options,
  execFn:async(file,args)=>{commands.push([file,args]);if(args[0]==='-t'&&rejectConfig)throw new Error('controlled rejected config');return'';}});
 const manager=factory(),spec={primaryDomain:domain.primaryDomain,aliases:[],targetType:'static',target:domain.target,
  nginxSettings:domain.nginxSettings,tls:null,httpsRedirect:false,canonicalRedirect:false};
 const staged=await manager.stageDomain(spec);await manager.activateDomain({primaryDomain:domain.primaryDomain,checksum:staged.checksum});
 await domainRegistry.markStaged(domain.id,staged);await domainRegistry.markApplied(domain.id,{checksum:staged.checksum});
 const stagedRoot=path.join(root,'resources');const entry={domainId:domain.id,primaryDomain:domain.primaryDomain,
  configPath:path.join(configRoot,staged.configName),stagedConfigPath:path.join(stagedRoot,'nginx',domain.id+'.conf'),stagedMetadataPath:path.join(stagedRoot,'nginx',domain.id+'.json')};
 const backupSet={website,stagedRoot,nginx:[entry]};
 const adapter=createWebsiteHostingBackupAdapter({websiteRegistry,domainRegistry,applicationRegistry:{getApplication:async()=>null},
  certificateRegistry:{getCertificate:async()=>null},runtimeBindingRegistry:{getBinding:async()=>null},dockerComposeProjectRegistry:{getProject:async()=>null},
  nginxFactory:factory,configRoot,stagingRoot:path.join(root,'transactions'),codec:createWebsiteResourceBackupCodec({masterKey:Buffer.alloc(32,39)})});
 return{root,website,domain,domainRegistry,entry,backupSet,adapter,commands,select:[entry.stagedConfigPath,entry.stagedMetadataPath],
  reject(value){rejectConfig=value;},async change(){const current=await domainRegistry.getDomain(domain.id);
   const changes={nginxSettings:{...current.nginxSettings,clientMaxBodySizeMb:17}};
   const preview=await domainRegistry.previewDomainUpdate({domainId:domain.id,changes});await domainRegistry.updateDomain({domainId:domain.id,changes,previewDigest:preview.previewDigest});
   const updated=await domainRegistry.getDomain(domain.id),stage=await manager.stageDomain({...spec,nginxSettings:updated.nginxSettings});
   await manager.activateDomain({primaryDomain:domain.primaryDomain,checksum:stage.checksum});await domainRegistry.markStaged(domain.id,stage);await domainRegistry.markApplied(domain.id,{checksum:stage.checksum});
  }};
}

async function phpTrafficFixture(t,{trafficLogPath='/var/log/nginx/yunpanel-site-traffic.log',enableTrafficLimitGuard=true}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'yp-hosting-traffic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const websiteId='19f03f9f-13bb-5771-9d56-dd837211e2a8';
 const applicationId='b2eb7787-4213-5b30-b774-4b1d8613941b';
 const serverId=randomUUID();
 const unixUser='yunapp-9ef2409e7686';
 const documentRoot=`/var/lib/yunpanel/apps/${applicationId}/current/public`;
 const socketPath=`/run/php/yunpanel-${unixUser}.sock`;
 const primaryDomain='ypaudit-traffic-proof.example.test';
 const website={id:websiteId,serverId,applicationId,name:primaryDomain,primaryDomain,runtimeType:'php',unixUser,documentRoot,revision:1};
 const application={id:applicationId,serverId,type:'php',webRoot:documentRoot};
 const websiteRegistry={getWebsite:async id=>id===websiteId?website:null};
 const applicationRegistry={getApplication:async id=>id===applicationId?application:null};
 const domainRegistry=createDomainRegistry({filePath:path.join(root,'domains.json'),serverExists:async id=>id===serverId,
  websiteRegistry,getWebsite:websiteRegistry.getWebsite});
 await domainRegistry.init();
 const domain=await domainRegistry.createDomain({serverId,websiteId,primaryDomain,targetType:'php',target:{applicationId},httpsMode:'off'});
 const configRoot=path.join(root,'sites-enabled');await mkdir(configRoot,{recursive:true});
 const trafficConfPath=path.join(root,'conf.d','yunpanel-traffic.conf');
 const commands=[];const lifecycleHooks=[];
 const liveNginxManager=createNginxManager({
  sitesDir:configRoot,
  stagingDir:path.join(root,'live-staging'),
  trafficLogPath,
  enableTrafficLimitGuard,
  execFn:async(file,args)=>{commands.push([file,args]);return'';},
 });
 const trafficEnforcer=createWebsiteTrafficEnforcer({
  configPath:trafficConfPath,
  trafficLogPath:trafficLogPath??'/var/log/nginx/yunpanel-site-traffic.log',
  sitesDir:configRoot,
  nginxManager:liveNginxManager,
  execFn:async(file,args)=>{commands.push([file,args]);return{stdout:'',stderr:''};},
 });
 const trafficCoordinator=createWebsiteTrafficCoordinator({
  domainRegistry,
  websiteRegistry,
  hostingAccounts:{listEnforcedTrafficCustomers:()=>[{maxTrafficMb:10,websiteIds:[websiteId]}]},
  websiteTrafficLedger:{getMonthlyTotalsForWebsites:async()=>({ok:true,bytes:15*1024*1024})},
  websiteTrafficEnforcer:trafficEnforcer,
  sitesDir:configRoot,
 });
 const phpFpmSiteManager={inspect:async()=>({satisfied:true,adapter:'php-fpm',websiteId,applicationId,unixUser,documentRoot,socketPath})};
 const serviceUmaskManager={inspect:async()=>({satisfied:true,umask:'0027'})};
 const liveSpec={
  websiteId,
  primaryDomain,
  aliases:[],
  targetType:'php',
  target:{root:documentRoot,socketPath},
  nginxSettings:{indexFiles:['index.php','index.html']},
  tls:null,
  httpsRedirect:false,
  canonicalRedirect:false,
 };
 const staged=await liveNginxManager.stageDomain(liveSpec);
 await liveNginxManager.activateDomain({primaryDomain,checksum:staged.checksum});
 await domainRegistry.markStaged(domain.id,staged);
 await domainRegistry.markApplied(domain.id,{checksum:staged.checksum});
 await trafficCoordinator.reconcileTrafficEnforcement({syncLedger:false});
 const codec=createWebsiteResourceBackupCodec({masterKey:Buffer.alloc(32,41)});
 const backupSetProvider=createWebsiteBackupSetProvider({
  websiteRegistry,
  domainRegistry,
  databaseBindingRegistry:{listBindings:async()=>[]},
  mailDomainRegistry:{listMailDomains:async()=>[]},
  applicationRegistry,
  localServerId:serverId,
  backupResourceRoot:path.join(root,'backup-resources'),
  nginxConfigRoot:configRoot,
 });
 const backupSet=await backupSetProvider.getWebsiteBackupSet({websiteId,serverId});
 const entry=backupSet.nginx[0];
 const recordTrafficHook=async(phase,info)=>{
  const currentDomain=await domainRegistry.getDomain(domain.id);
  const reconciled=await trafficCoordinator.reconcileTrafficEnforcement({syncLedger:false});
  const trafficConf=await readFile(trafficConfPath,'utf8');
  lifecycleHooks.push({
   phase,
   websiteId:info.websiteId,
   primaryDomain:info.primaryDomain,
   domainState:currentDomain.state,
   appliedChecksum:currentDomain.appliedChecksum,
   clientMaxBodySizeMb:currentDomain.nginxSettings.clientMaxBodySizeMb,
   trackedWebsiteIds:[...reconciled.reconcileResult.trackedWebsiteIds],
   blockedWebsiteIds:[...reconciled.blockedWebsiteIds],
   hasHostMap:trafficConf.includes(`"${primaryDomain}" "${websiteId}";`),
   hasQuotaBlock:trafficConf.includes(`"${websiteId}" 1;`),
  });
 };
 const adapter=createWebsiteHostingBackupAdapter({
  websiteRegistry,
  domainRegistry,
  applicationRegistry,
  certificateRegistry:{getCertificate:async()=>null},
  runtimeBindingRegistry:{getBinding:async()=>null},
  dockerComposeProjectRegistry:{getProject:async()=>null},
  phpFpmSiteManager,
  serviceUmaskManager,
  nginxManager:liveNginxManager,
  beforeDomainActivate:async info=>recordTrafficHook('before',info),
  onDomainActivated:async info=>recordTrafficHook('after',info),
  stagingRoot:path.join(root,'restore-staging'),
  codec,
 });
 return{root,website,domain,websiteRegistry,domainRegistry,applicationRegistry,liveNginxManager,trafficEnforcer,trafficCoordinator,trafficConfPath,phpFpmSiteManager,serviceUmaskManager,
  backupSetProvider,backupSet,entry,adapter,codec,configRoot,commands,lifecycleHooks,liveSpec,
  select:[entry.stagedConfigPath,entry.stagedMetadataPath],
  async updateMaxBody(mb){
   const current=await domainRegistry.getDomain(domain.id);
   const changes={nginxSettings:{...current.nginxSettings,clientMaxBodySizeMb:mb}};
   const preview=await domainRegistry.previewDomainUpdate({domainId:domain.id,changes});
   await domainRegistry.updateDomain({domainId:domain.id,changes,previewDigest:preview.previewDigest});
   const updated=await domainRegistry.getDomain(domain.id);
   const nextStage=await liveNginxManager.stageDomain({...liveSpec,nginxSettings:{indexFiles:['index.php','index.html'],...updated.nginxSettings}});
   await liveNginxManager.activateDomain({primaryDomain,checksum:nextStage.checksum});
   await domainRegistry.markStaged(domain.id,nextStage);
   await domainRegistry.markApplied(domain.id,{checksum:nextStage.checksum});
  }};
}

test('capture and two separate restores recover real Nginx bytes and Domain settings with fresh transaction receipts',async t=>{
 const f=await fixture(t),original=await readFile(f.entry.configPath,'utf8');await f.adapter.capture(f.backupSet,f.entry);
 assert.doesNotMatch(await readFile(f.entry.stagedMetadataPath,'utf8'),/owned.example.test|targetType/);
 await f.change();
 f.reject(true);
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()}));
 const afterReject=await f.domainRegistry.getDomain(f.domain.id);
 assert.equal(afterReject.state,'active');
 assert.equal(afterReject.nginxSettings.clientMaxBodySizeMb,17);
 f.reject(false);
 const firstRestore=await f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()});
 assert.equal(firstRestore[0].restored,true);assert.equal(await readFile(f.entry.configPath,'utf8'),original);
 assert.notEqual((await f.domainRegistry.getDomain(f.domain.id)).nginxSettings.clientMaxBodySizeMb,17);
 for(let i=0;i<2;i++){
  await f.change();assert.match(await readFile(f.entry.configPath,'utf8'),/client_max_body_size 17m/);
  const result=await f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()});
  assert.equal(result[0].restored,true);assert.equal(await readFile(f.entry.configPath,'utf8'),original);
  assert.notEqual((await f.domainRegistry.getDomain(f.domain.id)).nginxSettings.clientMaxBodySizeMb,17);
 }
});
test('unverified active config and an incomplete selection fail before configuration mutation',async t=>{
 const f=await fixture(t);await writeFile(f.entry.configPath,'foreign or changed config');
 await assert.rejects(f.adapter.capture(f.backupSet,f.entry),e=>e.code==='website_hosting_backup_active_config_changed');
 await assert.rejects(f.adapter.assertSupported(f.backupSet,[f.entry.stagedConfigPath]),e=>e.code==='website_hosting_restore_selection_incomplete');
});
test('a corrupt saved configuration cannot stage a new Nginx file',async t=>{
 const f=await fixture(t);await f.adapter.capture(f.backupSet,f.entry);await writeFile(f.entry.stagedConfigPath,'malformed snapshot');
 const count=f.commands.length;
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()}),e=>e.code==='website_hosting_restore_config_invalid');
 assert.equal(f.commands.length,count);
});

test('traffic-guarded PHP vhost captures and restores identically using the live authoritative nginxManager and verified websiteId',async t=>{
 const f=await phpTrafficFixture(t);
 const original=await readFile(f.entry.configPath,'utf8');
 assert.match(original,/yunpanel_site_traffic if=\$yunpanel_traffic_log_enabled;/);
 assert.match(original,new RegExp(`if \\(\\$yunpanel_traffic_site_id = "${f.website.id}"\\)`));

 const captured=await f.adapter.capture(f.backupSet,f.entry);
 assert.equal(captured.captured,true);
 assert.equal(captured.checksum,sha256(original));

 await f.updateMaxBody(23);
 const mutated=await readFile(f.entry.configPath,'utf8');
 assert.match(mutated,/client_max_body_size 23m/);
 assert.notEqual(mutated,original);

 const restored=await f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()});
 assert.equal(restored[0].restored,true);
 assert.equal(restored[0].checksum,sha256(original));
 assert.equal(await readFile(f.entry.configPath,'utf8'),original);
 assert.equal(f.lifecycleHooks.length,2);
 const[beforeHook,afterHook]=f.lifecycleHooks;
 assert.deepEqual(beforeHook,{
  phase:'before',
  websiteId:f.website.id,
  primaryDomain:f.domain.primaryDomain,
  domainState:'active',
  appliedChecksum:sha256(mutated),
  clientMaxBodySizeMb:23,
  trackedWebsiteIds:[f.website.id],
  blockedWebsiteIds:[f.website.id],
  hasHostMap:true,
  hasQuotaBlock:true,
 });
 assert.deepEqual(afterHook,{
  phase:'after',
  websiteId:f.website.id,
  primaryDomain:f.domain.primaryDomain,
  domainState:'active',
  appliedChecksum:sha256(original),
  clientMaxBodySizeMb:f.domain.nginxSettings.clientMaxBodySizeMb,
  trackedWebsiteIds:[f.website.id],
  blockedWebsiteIds:[f.website.id],
  hasHostMap:true,
  hasQuotaBlock:true,
 });
 assert.deepEqual(f.trafficCoordinator.getSiteTrafficMeta(f.website.id),{
  blocked:true,
  trafficGuardReady:true,
  accountingMode:'dedicated_traffic_log',
  includesStaticAssets:true,
 });
});

test('traffic-guarded capture strictly rejects stripped traffic directives, foreign websiteId and manual edits without checksum relaxation',async t=>{
 const f=await phpTrafficFixture(t);
 const original=await readFile(f.entry.configPath,'utf8');

 // 1. Stripping traffic directives to a pre-traffic config must fail strictly
 const nonTrafficManager=createNginxManager({sitesDir:f.configRoot,stagingDir:path.join(f.root,'plain-stage'),execFn:async()=>''});
 const plainConfig=nonTrafficManager.previewDomain(f.liveSpec).config;
 await writeFile(f.entry.configPath,plainConfig,{mode:0o644});
 await assert.rejects(f.adapter.capture(f.backupSet,f.entry),e=>{
  assert.equal(e.code,'website_hosting_backup_active_config_changed');
  assert.equal(safeLocalOperationError(e).code,'website_hosting_backup_active_config_changed');
  return true;
 });

 // 2. Foreign websiteId baked into $yunpanel_traffic_site_id must fail strictly
 const foreignId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 await writeFile(f.entry.configPath,original.replace(f.website.id,foreignId),{mode:0o644});
 await assert.rejects(f.adapter.capture(f.backupSet,f.entry),e=>e.code==='website_hosting_backup_active_config_changed');

 // 3. Arbitrary directive drift must fail strictly
 await writeFile(f.entry.configPath,original+'\n# unauthorized manual edit\n',{mode:0o644});
 await assert.rejects(f.adapter.capture(f.backupSet,f.entry),e=>e.code==='website_hosting_backup_active_config_changed');
});

test('legacy pre-traffic snapshot validates with legacy render and preserves live traffic guard/log on activation',async t=>{
 const f=await phpTrafficFixture(t);
 // Mutate current settings so restore visibly reverts domain Nginx settings while keeping live traffic enforcement
 await f.updateMaxBody(29);
 assert.match(await readFile(f.entry.configPath,'utf8'),/client_max_body_size 29m/);
 // Build an authentic legacy pre-traffic snapshot (no trafficLogPath/enableTrafficLimitGuard/websiteId in saved.spec)
 const legacyManager=createNginxManager({sitesDir:f.configRoot,stagingDir:path.join(f.root,'legacy-stage'),execFn:async()=>''});
 const legacySpec={
  primaryDomain:f.domain.primaryDomain,
  aliases:[],
  tls:null,
  canonicalRedirect:false,
  httpsRedirect:false,
  targetType:'php',
  target:{root:f.website.documentRoot,socketPath:`/run/php/yunpanel-${f.website.unixUser}.sock`},
  nginxSettings:{indexFiles:['index.php','index.html']},
 };
 const legacyRendered=legacyManager.previewDomain(legacySpec);
 await mkdir(path.dirname(f.entry.stagedMetadataPath),{recursive:true,mode:0o700});
 await writeFile(f.entry.stagedConfigPath,legacyRendered.config,{mode:0o600});
 const legacyPayload={
  version:1,
  serverId:f.website.serverId,
  applicationId:f.website.applicationId,
  domainId:f.domain.id,
  certificateId:null,
  configName:legacyRendered.configName,
  checksum:legacyRendered.checksum,
  spec:legacySpec,
  catalog:{httpsMode:'off',httpsRedirect:false,canonicalRedirect:false,nginxSettings:f.domain.nginxSettings},
 };
 await writeFile(f.entry.stagedMetadataPath,f.codec.encode({websiteId:f.website.id,resourceId:f.domain.id,kind:'hosting'},legacyPayload),{mode:0o600});

 const expectedTrafficRendered=f.liveNginxManager.previewDomain({...legacySpec,websiteId:f.website.id});
 const restored=await f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()});
 assert.equal(restored[0].restored,true);
 assert.equal(restored[0].checksum,expectedTrafficRendered.checksum);
 const activeAfterRestore=await readFile(f.entry.configPath,'utf8');
 assert.equal(activeAfterRestore,expectedTrafficRendered.config);
 assert.doesNotMatch(activeAfterRestore,/client_max_body_size 29m/);
 assert.match(activeAfterRestore,/access_log \/var\/log\/nginx\/yunpanel-site-traffic\.log yunpanel_site_traffic if=\$yunpanel_traffic_log_enabled;/);
 assert.match(activeAfterRestore,new RegExp(`if \\(\\$yunpanel_traffic_site_id = "${f.website.id}"\\)`));
 assert.match(activeAfterRestore,/return 429;/);
 assert.equal(f.lifecycleHooks.length,2);
 assert.equal(f.lifecycleHooks[0].phase,'before');
 assert.equal(f.lifecycleHooks[0].domainState,'active');
 assert.equal(f.lifecycleHooks[0].clientMaxBodySizeMb,29);
 assert.equal(f.lifecycleHooks[0].hasHostMap,true);
 assert.equal(f.lifecycleHooks[0].hasQuotaBlock,true);
 assert.equal(f.lifecycleHooks[1].phase,'after');
 assert.equal(f.lifecycleHooks[1].domainState,'active');
 assert.equal(f.lifecycleHooks[1].appliedChecksum,expectedTrafficRendered.checksum);
 assert.equal(f.lifecycleHooks[1].clientMaxBodySizeMb,f.domain.nginxSettings.clientMaxBodySizeMb);
 assert.equal(f.lifecycleHooks[1].hasHostMap,true);
 assert.equal(f.lifecycleHooks[1].hasQuotaBlock,true);
 assert.deepEqual(f.trafficCoordinator.getSiteTrafficMeta(f.website.id),{
  blocked:true,
  trafficGuardReady:true,
  accountingMode:'dedicated_traffic_log',
  includesStaticAssets:true,
 });
 // Subsequent backup capture on the restored site succeeds immediately without drift
 const recaptured=await f.adapter.capture(f.backupSet,f.entry);
 assert.equal(recaptured.captured,true);
 assert.equal(recaptured.checksum,expectedTrafficRendered.checksum);

 // Corrupting legacy snapshot bytes must still fail strictly before touching active config
 await writeFile(f.entry.stagedConfigPath,legacyRendered.config+'\n# tampered\n',{mode:0o600});
 await writeFile(f.entry.stagedMetadataPath,f.codec.encode({websiteId:f.website.id,resourceId:f.domain.id,kind:'hosting'},legacyPayload),{mode:0o600});
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()}),e=>e.code==='website_hosting_restore_config_invalid');
 assert.equal(await readFile(f.entry.configPath,'utf8'),activeAfterRestore);

 // Foreign websiteId and trafficWebsiteId in saved snapshot metadata must reject before touching files
 await writeFile(f.entry.stagedConfigPath,legacyRendered.config,{mode:0o600});
 const foreignMeta={...legacyPayload,spec:{...legacySpec,websiteId:randomUUID()}};
 await writeFile(f.entry.stagedMetadataPath,f.codec.encode({websiteId:f.website.id,resourceId:f.domain.id,kind:'hosting'},foreignMeta),{mode:0o600});
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()}),e=>e.code==='website_hosting_restore_snapshot_invalid');
 const foreignTrafficMeta={...legacyPayload,spec:{...legacySpec,trafficWebsiteId:randomUUID()}};
 await writeFile(f.entry.stagedMetadataPath,f.codec.encode({websiteId:f.website.id,resourceId:f.domain.id,kind:'hosting'},foreignTrafficMeta),{mode:0o600});
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()}),e=>e.code==='website_hosting_restore_snapshot_invalid');

 // Explicit trafficLogPath: null in saved snapshot spec (non-legacy) on a traffic-guarded host must reject with runtime changed
 const explicitNoTrafficMeta={...legacyPayload,spec:{...legacySpec,websiteId:f.website.id,trafficLogPath:null,enableTrafficLimitGuard:false}};
 await writeFile(f.entry.stagedMetadataPath,f.codec.encode({websiteId:f.website.id,resourceId:f.domain.id,kind:'hosting'},explicitNoTrafficMeta),{mode:0o600});
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()}),e=>e.code==='website_hosting_restore_runtime_changed');

 // Restoring a traffic-guarded snapshot onto a non-traffic host must reject with runtime changed
 const hostlessAdapter=createWebsiteHostingBackupAdapter({
  websiteRegistry:f.websiteRegistry,
  domainRegistry:f.domainRegistry,
  applicationRegistry:f.applicationRegistry,
  certificateRegistry:{getCertificate:async()=>null},
  runtimeBindingRegistry:{getBinding:async()=>null},
  dockerComposeProjectRegistry:{getProject:async()=>null},
  phpFpmSiteManager:f.phpFpmSiteManager,
  serviceUmaskManager:f.serviceUmaskManager,
  nginxManager:legacyManager,
  stagingRoot:path.join(f.root,'hostless-restore'),
  codec:f.codec,
 });
 const trafficRendered=f.liveNginxManager.previewDomain(f.liveSpec);
 await writeFile(f.entry.stagedConfigPath,trafficRendered.config,{mode:0o600});
 const trafficPayload={
  ...legacyPayload,
  checksum:trafficRendered.checksum,
  spec:{...f.liveSpec,trafficLogPath:'/var/log/nginx/yunpanel-site-traffic.log',enableTrafficLimitGuard:true},
 };
 await writeFile(f.entry.stagedMetadataPath,f.codec.encode({websiteId:f.website.id,resourceId:f.domain.id,kind:'hosting'},trafficPayload),{mode:0o600});
 await assert.rejects(hostlessAdapter.restore({backupSet:f.backupSet,include:f.select,operationId:randomUUID()}),e=>e.code==='website_hosting_restore_runtime_changed');
});

test('index.js and management-app.js wire the live nginxManager into hosting backup adapter and backup set provider',async()=>{
 const indexSource=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 const managementSource=await readFile(new URL('../src/http/management-app.js',import.meta.url),'utf8');
 assert.match(indexSource,/websiteProvisioningRuntime,\s*nginxManager,/);
 assert.match(indexSource,/beforeDomainActivate,\s*onDomainActivated/);
 assert.match(managementSource,/createWebsiteHostingBackupAdapter\(\{[\s\S]*?nginxManager:\s*options\.nginxManager\s*\?\?\s*null[\s\S]*?beforeDomainActivate:\s*options\.beforeDomainActivate\s*\?\?\s*null[\s\S]*?onDomainActivated/);
 assert.match(managementSource,/createWebsiteBackupSetProvider\(\{[\s\S]*?nginxConfigRoot:\s*options\.nginxManager\.renderOptions\.sitesDir/);
});

test('real Restic backup and restore round-trip preserves traffic-guarded Nginx vhost bytes when restic is installed',async t=>{
 let resticBinary=null;
 for(const candidate of['/usr/bin/restic','/usr/local/bin/restic','/opt/homebrew/bin/restic']){
  try{await access(candidate);resticBinary=candidate;break;}catch{/* continue */}
 }
 if(!resticBinary){t.skip('restic binary not installed on this host');return;}
 const f=await phpTrafficFixture(t);
 const original=await readFile(f.entry.configPath,'utf8');
 const appRoot=path.join(f.root,'app-files');await mkdir(appRoot,{recursive:true});
 await writeFile(path.join(appRoot,'index.php'),'<?php echo "ok";');
 const repoDir=path.join(f.root,'restic-repo');
 const repoId=randomUUID();
 const password='restic-test-password-0123456789';
 const resticManager=createResticManager({resticPath:resticBinary});
 await resticManager.init({repository:repoDir,password});
 const resticRepositoryRegistry={
  getRepository:async id=>id===repoId?{id:repoId,serverId:f.website.serverId,name:'website-'+f.website.id,backend:'local',target:repoDir,status:'ready'}:null,
  revealPassword:async id=>id===repoId?password:null,
 };
 const customBackupSetProvider={
  getWebsiteBackupSet:async args=>{
   const base=await f.backupSetProvider.getWebsiteBackupSet(args);
   const payload={...base,targetPaths:[appRoot,base.stagedRoot].sort()};
   delete payload.digest;
   return{...payload,digest:sha256(JSON.stringify(payload))};
  },
 };
 const envRegistry=createApplicationEnvironmentRegistry({
  filePath:path.join(f.root,'app-env.json'),
  masterKey:Buffer.alloc(32,41).toString('hex'),
  getApplication:f.applicationRegistry.getApplication,
 });
 await envRegistry.init();
 const environmentBackupAdapter=createWebsiteEnvironmentBackupAdapter({
  applicationRegistry:f.applicationRegistry,
  applicationEnvironmentRegistry:envRegistry,
  domainRegistry:f.domainRegistry,
  codec:f.codec,
 });
 const backupService=createWebsiteBackupService({
  websiteRegistry:f.websiteRegistry,
  resticRepositoryRegistry,
  resticManager,
  websiteBackupSetProvider:customBackupSetProvider,
  localServerId:f.website.serverId,
  environmentBackupAdapter,
  hostingBackupAdapter:f.adapter,
 });
 const preview=await backupService.previewBackup({websiteId:f.website.id,repositoryId:repoId});
 const snap=await backupService.executeBackup({websiteId:f.website.id,repositoryId:repoId,expectedPreviewDigest:preview.backupSetDigest,confirmation:preview.confirmation,tags:['traffic-regression']});
 assert.equal(snap.status,'succeeded');
 assert.ok(snap.snapshot.snapshotId);

 await f.updateMaxBody(31);
 assert.match(await readFile(f.entry.configPath,'utf8'),/client_max_body_size 31m/);

 const restoreService=createWebsiteRestoreService({
  websiteRegistry:f.websiteRegistry,
  resticRepositoryRegistry,
  resticManager,
  websiteBackupSetProvider:customBackupSetProvider,
  healthInspector:{inspect:async()=>({satisfied:true,statusCode:200})},
  localServerId:f.website.serverId,
  websiteBackupService:backupService,
  environmentBackupAdapter,
  hostingBackupAdapter:f.adapter,
  receiptStore:createWebsiteRestoreReceiptStore({root:path.join(f.root,'restore-receipts')}),
 });
 const restorePreview=await restoreService.previewRestore({websiteId:f.website.id,repositoryId:repoId,snapshotId:snap.snapshot.snapshotId,include:['hosting']});
 const restored=await restoreService.executeRestore({websiteId:f.website.id,repositoryId:repoId,snapshotId:snap.snapshot.snapshotId,
  expectedPreviewDigest:restorePreview.previewDigest,confirmation:restorePreview.confirmation,include:['hosting'],operationId:randomUUID()});
 assert.equal(restored.status,'succeeded');
 assert.equal(await readFile(f.entry.configPath,'utf8'),original);
});

// T970: a finished restore operation owns `<stagingRoot>/<operationId>` and
// must remove exactly that folder; other operations' folders stay.
test('T970: cleanupOperationStaging removes only the finished restore operation staging folder',async t=>{
 const f=await fixture(t);await f.adapter.capture(f.backupSet,f.entry);await f.change();
 const finished=randomUUID(),other=randomUUID(),stagingRoot=path.join(f.root,'transactions');
 await f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:finished});
 await f.change();await f.adapter.restore({backupSet:f.backupSet,include:f.select,operationId:other});
 const exists=async target=>access(target).then(()=>true,()=>false);
 assert.equal(await exists(path.join(stagingRoot,finished,'apply',f.domain.id)),true);
 const active=await readFile(f.entry.configPath,'utf8');

 assert.equal(await f.adapter.cleanupOperationStaging(finished),true);
 assert.equal(await exists(path.join(stagingRoot,finished)),false);
 assert.equal(await exists(path.join(stagingRoot,other,'apply',f.domain.id)),true);
 assert.equal(await readFile(f.entry.configPath,'utf8'),active);
 assert.equal(await f.adapter.cleanupOperationStaging(finished),false);
 await assert.rejects(f.adapter.cleanupOperationStaging('../active'),e=>e.code==='website_hosting_restore_operation_invalid');
});
test('T970: cleanupOperationStaging never follows a symlinked operation folder',async t=>{
 const f=await fixture(t),stagingRoot=path.join(f.root,'transactions'),outside=path.join(f.root,'outside'),operationId=randomUUID();
 await mkdir(outside);await writeFile(path.join(outside,'keep'),'keep');await mkdir(stagingRoot,{recursive:true});
 await symlink(outside,path.join(stagingRoot,operationId));
 await assert.rejects(f.adapter.cleanupOperationStaging(operationId),e=>e.code==='website_hosting_restore_staging_unsafe');
 assert.equal(await readFile(path.join(outside,'keep'),'utf8'),'keep');
});
