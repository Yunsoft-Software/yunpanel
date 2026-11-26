import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createNginxManager,createPhpFpmSiteManager} from '@yunpanel/host-runtime';
import {createServiceUmaskManager} from '@yunpanel/host-runtime/service-umask-manager';
import {createWebsiteResourceBackupCodec} from './website-resource-backup-codec.js';
import {resolveWebsiteDomainTarget} from '../websites/website-domain-target.js';
import {domainStageTargetJobRegistryInternals} from '../domains/domain-stage-target-job-registry.js';
import {materializeApplicationPassengerMigrationDomainEnvelope} from '../applications/application-passenger-migration-domain.js';

const fail=code=>Object.assign(new Error('Site barındırma yedeği güvenli biçimde doğrulanamadı'),{code,status:409});
const digest=value=>createHash('sha256').update(value).digest('hex');
const within=(value,root)=>value===root||value.startsWith(root+'/');
export function createWebsiteHostingBackupAdapter({websiteRegistry,domainRegistry,applicationRegistry,certificateRegistry,
 runtimeBindingRegistry,dockerComposeProjectRegistry,provisioningRegistry=null,
 phpFpmSiteManager=createPhpFpmSiteManager(),serviceUmaskManager=createServiceUmaskManager(),
 nginxManager=null,nginxFactory=null,beforeDomainActivate=null,onDomainActivated=null,
 codec=createWebsiteResourceBackupCodec(),configRoot=null,stagingRoot='/var/lib/yunpanel/staging/website-hosting-restore'}={}){
 const resolvedConfigRoot=configRoot??nginxManager?.renderOptions?.sitesDir??'/etc/nginx/sites-enabled';
 const defaultPreviewManager=nginxManager??(nginxFactory?null:createNginxManager({sitesDir:resolvedConfigRoot}));
 const currentPreviewManager=()=>defaultPreviewManager??nginxFactory();
 const createRestoreManager=stagingDir=>{
  if(typeof nginxManager?.withStagingDir==='function')return nginxManager.withStagingDir(stagingDir);
  if(nginxFactory)return nginxFactory({stagingDir});
  return createNginxManager({
   sitesDir:resolvedConfigRoot,
   stagingDir,
   trafficLogPath:nginxManager?.renderOptions?.trafficLogPath??null,
   enableTrafficLimitGuard:nginxManager?.renderOptions?.enableTrafficLimitGuard===true,
  });
 };
 async function scope(backupSet,entry){
  const website=await websiteRegistry.getWebsite(backupSet.website.id),domain=await domainRegistry.getDomain(entry.domainId);
  const root=path.posix.join(backupSet.stagedRoot,'nginx'),config=path.posix.join(root,`${entry.domainId}.conf`),metadata=path.posix.join(root,`${entry.domainId}.json`);
  if(!website||website.id!==backupSet.website.id||website.serverId!==backupSet.website.serverId||website.applicationId!==backupSet.website.applicationId
   ||!domain||domain.id!==entry.domainId||domain.websiteId!==website.id||domain.serverId!==website.serverId||domain.primaryDomain!==entry.primaryDomain
   ||entry.stagedConfigPath!==config||entry.stagedMetadataPath!==metadata||!codec.configured)throw fail('website_hosting_backup_scope_invalid');
  return{website,domain,config,metadata,identity:{websiteId:website.id,resourceId:domain.id,kind:'hosting'}};
 }
 async function spec(context,domain=context.domain,previewManager=currentPreviewManager()){
  const target=await resolveWebsiteDomainTarget({domain,websiteRegistry,applicationRegistry,runtimeBindingRegistry,
   dockerComposeProjectRegistry,phpFpmSiteManager,serviceUmaskManager});
  const envelope=await materializeApplicationPassengerMigrationDomainEnvelope(domain,certificateRegistry);
  const operation=await provisioningRegistry?.getLatestForWebsite(context.website.id);
  const original=operation?.websiteId===context.website.id?operation.steps?.find(step=>step.kind==='nginx')?.intent:null;
  const renderOptions=previewManager?.renderOptions??null;
  const trafficLogPath=renderOptions?.trafficLogPath??null;
  const enableTrafficLimitGuard=renderOptions?.enableTrafficLimitGuard===true;
  return{...envelope,websiteId:context.website.id,targetType:target.targetType,target:target.target,
   nginxSettings:domainStageTargetJobRegistryInternals.resolvedNginxSettings(domain,target,domain.nginxSettings),
   ...(original?.mailDiscoverySocketPath?{mailDiscoverySocketPath:original.mailDiscoverySocketPath}:{}),
   ...(original?.acmeOnlyHostnames?.length?{acmeOnlyHostnames:original.acmeOnlyHostnames}:{}),
   ...(trafficLogPath!=null?{trafficLogPath}:{}),
   ...(enableTrafficLimitGuard?{enableTrafficLimitGuard:true}:{}),
  };
 }
 async function capture(backupSet,entry){
  const previewManager=currentPreviewManager();
  const context=await scope(backupSet,entry),value=await spec(context,context.domain,previewManager),rendered=previewManager.previewDomain(value);
  const expectedPath=path.posix.join(resolvedConfigRoot,rendered.configName);
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
    ||saved.domainId!==context.domain.id||saved.certificateId!==context.domain.certificateId
    ||!saved.spec||typeof saved.spec!=='object'||Array.isArray(saved.spec))throw fail('website_hosting_restore_snapshot_invalid');
   if((saved.spec.websiteId!==undefined&&saved.spec.websiteId!==context.website.id)
    ||(saved.spec.trafficWebsiteId!==undefined&&saved.spec.trafficWebsiteId!==context.website.id))throw fail('website_hosting_restore_snapshot_invalid');
   const current=await spec(context);
   if(JSON.stringify(saved.spec.target)!==JSON.stringify(current.target)||saved.spec.targetType!==current.targetType
    ||JSON.stringify(saved.spec.aliases)!==JSON.stringify(current.aliases)||saved.spec.primaryDomain!==current.primaryDomain
    ||JSON.stringify(saved.spec.tls)!==JSON.stringify(current.tls))throw fail('website_hosting_restore_runtime_changed');
   const hasSavedTrafficPolicy=Object.hasOwn(saved.spec,'trafficLogPath')||Object.hasOwn(saved.spec,'enableTrafficLimitGuard');
   if(hasSavedTrafficPolicy){
    if(saved.spec.trafficLogPath!==undefined&&saved.spec.trafficLogPath!==null&&typeof saved.spec.trafficLogPath!=='string')throw fail('website_hosting_restore_snapshot_invalid');
    if(saved.spec.enableTrafficLimitGuard!==undefined&&typeof saved.spec.enableTrafficLimitGuard!=='boolean')throw fail('website_hosting_restore_snapshot_invalid');
    if((saved.spec.trafficLogPath!=null||saved.spec.enableTrafficLimitGuard===true)&&saved.spec.websiteId!==context.website.id)throw fail('website_hosting_restore_snapshot_invalid');
    if((saved.spec.trafficLogPath??null)!==(current.trafficLogPath??null)
     ||(saved.spec.enableTrafficLimitGuard===true)!==(current.enableTrafficLimitGuard===true))throw fail('website_hosting_restore_runtime_changed');
   }
   const verifySpec={...saved.spec,
    trafficLogPath:saved.spec.trafficLogPath??null,
    enableTrafficLimitGuard:saved.spec.enableTrafficLimitGuard===true,
    ...(saved.spec.websiteId!==undefined?{websiteId:context.website.id}:{}),
   };
   const activateSpec={...saved.spec,
    websiteId:context.website.id,
    trafficLogPath:current.trafficLogPath??null,
    enableTrafficLimitGuard:current.enableTrafficLimitGuard===true,
   };
   const manager=createRestoreManager(path.posix.join(stagingRoot,operationId,rollback?'rollback':'apply',context.domain.id));
   const rendered=manager.previewDomain(verifySpec),raw=await protectedFile(context.config);
   if(rendered.checksum!==saved.checksum||digest(raw)!==saved.checksum||rendered.configName!==saved.configName
    ||entry.configPath!==path.posix.join(resolvedConfigRoot,rendered.configName))throw fail('website_hosting_restore_config_invalid');
   const expectedActive=manager.previewDomain(activateSpec);
   if(expectedActive.configName!==saved.configName
    ||entry.configPath!==path.posix.join(resolvedConfigRoot,expectedActive.configName))throw fail('website_hosting_restore_config_invalid');
   try{
    await domainRegistry.previewDomainUpdate({domainId:context.domain.id,changes:saved.catalog});
   }catch(error){if(error.code!=='domain_update_no_changes')throw error;}
   const staged=await manager.stageDomain(activateSpec);
   if(staged.checksum!==expectedActive.checksum||staged.configName!==expectedActive.configName)throw fail('website_hosting_restore_config_invalid');
   if(typeof beforeDomainActivate==='function')await beforeDomainActivate({primaryDomain:activateSpec.primaryDomain,websiteId:context.website.id});
   const activated=await manager.activateDomain({primaryDomain:activateSpec.primaryDomain,checksum:staged.checksum});
   const actual=await manager.inspectActiveDomain({primaryDomain:activateSpec.primaryDomain,checksum:staged.checksum});
   if(activated.active!==true||actual.satisfied!==true)throw fail('website_hosting_restore_unverified');
   try{
    const preview=await domainRegistry.previewDomainUpdate({domainId:context.domain.id,changes:saved.catalog});
    await domainRegistry.updateDomain({domainId:context.domain.id,changes:saved.catalog,previewDigest:preview.previewDigest,skipLock:true});
   }catch(error){if(error.code!=='domain_update_no_changes')throw error;}
   await domainRegistry.markStaged(context.domain.id,{checksum:staged.checksum,configName:staged.configName});
   await domainRegistry.markApplied(context.domain.id,{checksum:staged.checksum});
   if(typeof onDomainActivated==='function')await Promise.resolve(onDomainActivated({primaryDomain:activateSpec.primaryDomain,websiteId:context.website.id})).catch(()=>{});
   results.push({domainId:context.domain.id,restored:true,checksum:staged.checksum});
  }
  return results;
 }
 return Object.freeze({capture,assertSupported,restore,configured:codec.configured});
}
