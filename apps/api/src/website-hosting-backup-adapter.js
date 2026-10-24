import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createNginxManager,createPhpFpmSiteManager} from '@yunpanel/host-runtime';
import {createServiceUmaskManager} from '@yunpanel/host-runtime/service-umask-manager';
import {createWebsiteResourceBackupCodec} from './website-resource-backup-codec.js';
import {resolveWebsiteDomainTarget} from './website-domain-target.js';
import {domainStageTargetJobRegistryInternals} from './domain-stage-target-job-registry.js';
import {materializeApplicationPassengerMigrationDomainEnvelope} from './application-passenger-migration-domain.js';

const fail=code=>Object.assign(new Error('Site barındırma yedeği güvenli biçimde doğrulanamadı'),{code,status:409});
const digest=value=>createHash('sha256').update(value).digest('hex');
const within=(value,root)=>value===root||value.startsWith(root+'/');
export function createWebsiteHostingBackupAdapter({websiteRegistry,domainRegistry,applicationRegistry,certificateRegistry,
 runtimeBindingRegistry,dockerComposeProjectRegistry,provisioningRegistry=null,
 phpFpmSiteManager=createPhpFpmSiteManager(),serviceUmaskManager=createServiceUmaskManager(),
 nginxFactory=createNginxManager,codec=createWebsiteResourceBackupCodec(),configRoot='/etc/nginx/sites-enabled',stagingRoot='/var/lib/yunpanel/staging/website-hosting-restore'}={}){
 async function scope(backupSet,entry){
  const website=await websiteRegistry.getWebsite(backupSet.website.id),domain=await domainRegistry.getDomain(entry.domainId);
  const root=path.posix.join(backupSet.stagedRoot,'nginx'),config=path.posix.join(root,`${entry.domainId}.conf`),metadata=path.posix.join(root,`${entry.domainId}.json`);
  if(!website||website.id!==backupSet.website.id||website.serverId!==backupSet.website.serverId||website.applicationId!==backupSet.website.applicationId
   ||!domain||domain.id!==entry.domainId||domain.websiteId!==website.id||domain.serverId!==website.serverId||domain.primaryDomain!==entry.primaryDomain
   ||entry.stagedConfigPath!==config||entry.stagedMetadataPath!==metadata||!codec.configured)throw fail('website_hosting_backup_scope_invalid');
  return{website,domain,config,metadata,identity:{websiteId:website.id,resourceId:domain.id,kind:'hosting'}};
 }
 async function spec(context,domain=context.domain){
  const target=await resolveWebsiteDomainTarget({domain,websiteRegistry,applicationRegistry,runtimeBindingRegistry,
   dockerComposeProjectRegistry,phpFpmSiteManager,serviceUmaskManager});
  const envelope=await materializeApplicationPassengerMigrationDomainEnvelope(domain,certificateRegistry);
  const operation=await provisioningRegistry?.getLatestForWebsite(context.website.id);
  const original=operation?.websiteId===context.website.id?operation.steps?.find(step=>step.kind==='nginx')?.intent:null;
  return{...envelope,targetType:target.targetType,target:target.target,
   nginxSettings:domainStageTargetJobRegistryInternals.resolvedNginxSettings(domain,target,domain.nginxSettings),
   ...(original?.mailDiscoverySocketPath?{mailDiscoverySocketPath:original.mailDiscoverySocketPath}:{}),
   ...(original?.acmeOnlyHostnames?.length?{acmeOnlyHostnames:original.acmeOnlyHostnames}:{}),
  };
 }
 async function capture(backupSet,entry){
  const context=await scope(backupSet,entry),value=await spec(context),rendered=nginxFactory().previewDomain(value);
  const expectedPath=path.posix.join(configRoot,rendered.configName);
  if(entry.configPath!==expectedPath)throw fail('website_hosting_backup_config_scope_invalid');
  const metadata=await lstat(entry.configPath);
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==process.getuid()||(metadata.mode&0o022))throw fail('website_hosting_backup_config_unsafe');
  const actual=await readFile(entry.configPath,'utf8');
  if(digest(actual)!==rendered.checksum)throw fail('website_hosting_backup_active_config_changed');
  const payload={version:1,serverId:context.website.serverId,applicationId:context.website.applicationId,domainId:context.domain.id,
   certificateId:context.domain.certificateId,configName:rendered.configName,checksum:rendered.checksum,spec:value,
   catalog:{httpsMode:context.domain.httpsMode,httpsRedirect:context.domain.httpsRedirect,canonicalRedirect:context.domain.canonicalRedirect,nginxSettings:context.domain.nginxSettings}};
  await mkdir(path.dirname(context.metadata),{recursive:true,mode:0o700});
  await writeFile(context.config,actual,{mode:0o600});await chmod(context.config,0o600);
  const temporary=context.metadata+'.tmp';await writeFile(temporary,codec.encode(context.identity,payload),{mode:0o600});
  await chmod(temporary,0o600);await rename(temporary,context.metadata);
  return{domainId:context.domain.id,captured:true,checksum:rendered.checksum};
 }
 function selected(backupSet,include){return(backupSet.nginx??[]).filter(entry=>[entry.stagedConfigPath,entry.stagedMetadataPath]
  .some(target=>target&&include.some(root=>within(target,root))));}
 async function assertSupported(backupSet,include){
  for(const entry of selected(backupSet,include)){
   if(![entry.stagedConfigPath,entry.stagedMetadataPath].every(target=>include.some(root=>within(target,root))))throw fail('website_hosting_restore_selection_incomplete');
   await spec(await scope(backupSet,entry));
  }
 }
 async function protectedFile(file){
  const metadata=await lstat(file);
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==process.getuid()||(metadata.mode&0o077))throw fail('website_hosting_backup_file_unsafe');
  return readFile(file,'utf8');
 }
 async function restore({backupSet,include,operationId,rollback=false}){
  const entries=selected(backupSet,include);if(!entries.length)return[];
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId??''))throw fail('website_hosting_restore_operation_invalid');
  await assertSupported(backupSet,include);const results=[];
  for(const entry of entries){
   let context=await scope(backupSet,entry);const saved=codec.decode(context.identity,await protectedFile(context.metadata));
   if(saved.version!==1||saved.serverId!==context.website.serverId||saved.applicationId!==context.website.applicationId
    ||saved.domainId!==context.domain.id||saved.certificateId!==context.domain.certificateId)throw fail('website_hosting_restore_snapshot_invalid');
   const current=await spec(context);
   if(JSON.stringify(saved.spec.target)!==JSON.stringify(current.target)||saved.spec.targetType!==current.targetType
    ||JSON.stringify(saved.spec.aliases)!==JSON.stringify(current.aliases)||saved.spec.primaryDomain!==current.primaryDomain
    ||JSON.stringify(saved.spec.tls)!==JSON.stringify(current.tls))throw fail('website_hosting_restore_runtime_changed');
   const manager=nginxFactory({stagingDir:path.posix.join(stagingRoot,operationId,rollback?'rollback':'apply',context.domain.id)});
   const rendered=manager.previewDomain(saved.spec),raw=await protectedFile(context.config);
   if(rendered.checksum!==saved.checksum||digest(raw)!==saved.checksum||rendered.configName!==saved.configName
    ||entry.configPath!==path.posix.join(configRoot,rendered.configName))throw fail('website_hosting_restore_config_invalid');
   try{
    const preview=await domainRegistry.previewDomainUpdate({domainId:context.domain.id,changes:saved.catalog});
    await domainRegistry.updateDomain({domainId:context.domain.id,changes:saved.catalog,previewDigest:preview.previewDigest,skipLock:true});
   }catch(error){if(error.code!=='domain_update_no_changes')throw error;}
   const staged=await manager.stageDomain(saved.spec);
   if(staged.checksum!==saved.checksum||staged.configName!==saved.configName)throw fail('website_hosting_restore_config_invalid');
   const activated=await manager.activateDomain({primaryDomain:saved.spec.primaryDomain,checksum:staged.checksum});
   const actual=await manager.inspectActiveDomain({primaryDomain:saved.spec.primaryDomain,checksum:staged.checksum});
   if(activated.active!==true||actual.satisfied!==true)throw fail('website_hosting_restore_unverified');
   await domainRegistry.markStaged(context.domain.id,{checksum:staged.checksum,configName:staged.configName});
   await domainRegistry.markApplied(context.domain.id,{checksum:staged.checksum});
   results.push({domainId:context.domain.id,restored:true,checksum:staged.checksum});
  }
  return results;
 }
 return Object.freeze({capture,assertSupported,restore,configured:codec.configured});
}
