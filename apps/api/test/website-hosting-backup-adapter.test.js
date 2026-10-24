import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createNginxManager} from '@yunpanel/host-runtime';
import {createDomainRegistry} from '../src/domain-registry.js';
import {createWebsiteHostingBackupAdapter} from '../src/website-hosting-backup-adapter.js';
import {createWebsiteResourceBackupCodec} from '../src/website-resource-backup-codec.js';

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
test('capture and two separate restores recover real Nginx bytes and Domain settings with fresh transaction receipts',async t=>{
 const f=await fixture(t),original=await readFile(f.entry.configPath,'utf8');await f.adapter.capture(f.backupSet,f.entry);
 assert.doesNotMatch(await readFile(f.entry.stagedMetadataPath,'utf8'),/owned.example.test|targetType/);
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
