import {chmod,lstat,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createPowerDnsZoneManager,powerDnsZoneManagerInternals} from '@yunpanel/host-runtime/powerdns-zone-manager';
import {createWebsiteResourceBackupCodec} from './website-resource-backup-codec.js';

const fail=code=>Object.assign(new Error('Site DNS yedeği güvenli biçimde doğrulanamadı'),{code,status:409});
const within=(value,root)=>value===root||value.startsWith(root+'/');
export function createWebsiteDnsBackupAdapter({websiteRegistry,domainRegistry,powerDnsSecretRegistry,ownershipInspector,
 zoneManager=createPowerDnsZoneManager(),codec=createWebsiteResourceBackupCodec()}={}){
 async function scope(backupSet,entry){
  const website=await websiteRegistry.getWebsite(backupSet.website.id),domain=await domainRegistry.getDomain(entry.domainId);
  const target=path.posix.join(backupSet.stagedRoot,'dns',`${entry.primaryDomain}.zone.json`);
  if(!website||website.id!==backupSet.website.id||website.serverId!==backupSet.website.serverId
   ||!domain||domain.id!==entry.domainId||domain.websiteId!==website.id||domain.serverId!==website.serverId||domain.primaryDomain!==entry.primaryDomain
   ||target!==entry.stagedZonePath||!codec.configured)throw fail('website_dns_backup_scope_invalid');
  return{website,domain,target,identity:{websiteId:website.id,resourceId:domain.id,kind:'dns'}};
 }
 async function inspect(context){
  if(typeof ownershipInspector?.preview!=='function')throw fail('website_dns_backup_ownership_unavailable');
  const impact=await ownershipInspector.preview({domainId:context.domain.id});
  if(impact.domain?.id!==context.domain.id||impact.domain?.websiteId!==context.website.id||impact.domain?.serverId!==context.website.serverId){
   throw fail('website_dns_backup_scope_invalid');
  }
  return impact;
 }
 async function secret(context){
  const value=await powerDnsSecretRegistry.materializeForServer(context.website.serverId);
  if(typeof value?.apiKey!=='string'||!value.apiKey)throw fail('website_dns_backup_credentials_unavailable');
  return value.apiKey;
 }
 async function assertOwnedZoneScope(context){
  const domains=await domainRegistry.listDomains();
  if(!Array.isArray(domains))throw fail('website_dns_backup_domain_inventory_unavailable');
  const zone=context.domain.primaryDomain;
  if(domains.some(domain=>domain.websiteId!==context.website.id&&[domain.primaryDomain,...(domain.aliases??[])].some(
   hostname=>typeof hostname==='string'&&(hostname===zone||hostname.endsWith('.'+zone))))){
   throw fail('website_dns_backup_shared_zone_unavailable');
  }
 }
 async function capture(backupSet,entry){
  const context=await scope(backupSet,entry),impact=await inspect(context);
  let payload={version:1,serverId:context.website.serverId,domainId:context.domain.id,primaryDomain:context.domain.primaryDomain,
   kind:'external-reference',captured:false,reason:'authoritative_records_not_managed_here'};
  if(impact.zone?.ownershipOrigin?.status==='provisioning_created'){
   await assertOwnedZoneScope(context);
   if(impact.zone.exists!==true)throw fail('website_dns_backup_zone_missing');
   const current=await zoneManager.getZone(context.domain.primaryDomain,await secret(context));
   if(!current||powerDnsZoneManagerInternals.zoneSnapshotDigest(current)!==impact.zone.snapshotDigest)throw fail('website_dns_backup_zone_changed');
   const snapshot=powerDnsZoneManagerInternals.normalizeRollbackSnapshot(current,context.domain.primaryDomain);
   payload={...payload,kind:'authoritative-zone',captured:true,reason:null,snapshot,
    ownership:{operationId:impact.zone.ownershipOrigin.operationId,evidenceDigest:impact.zone.ownershipOrigin.evidenceDigest}};
  }
  await mkdir(path.dirname(context.target),{recursive:true,mode:0o700});
  const temporary=context.target+'.tmp';await writeFile(temporary,codec.encode(context.identity,payload),{mode:0o600});
  await chmod(temporary,0o600);await rename(temporary,context.target);
  return{domainId:context.domain.id,captured:payload.captured,rrsetCount:payload.snapshot?.rrsets.length??0};
 }
 function selected(backupSet,include){return(backupSet.dns??[]).filter(entry=>include.some(root=>within(entry.stagedZonePath,root)));}
 async function assertSupported(backupSet,include){
  for(const entry of selected(backupSet,include)){
   const context=await scope(backupSet,entry),impact=await inspect(context);
   await assertOwnedZoneScope(context);
   if(impact.zone?.exists!==true||impact.zone?.ownershipOrigin?.status!=='provisioning_created'){
    throw fail('website_dns_restore_scope_unavailable');
   }
   if(impact.zone.dnssec===true)throw fail('website_dns_restore_dnssec_unavailable');
  }
 }
 async function restore({backupSet,include}){
  await assertSupported(backupSet,include);const results=[];
  for(const entry of selected(backupSet,include)){
   const context=await scope(backupSet,entry),metadata=await lstat(context.target);
   if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==process.getuid()||(metadata.mode&0o077))throw fail('website_dns_backup_file_unsafe');
   const saved=codec.decode(context.identity,await readFile(context.target,'utf8'));
   if(saved.version!==1||saved.serverId!==context.website.serverId||saved.domainId!==context.domain.id
    ||saved.primaryDomain!==context.domain.primaryDomain||saved.kind!=='authoritative-zone'||saved.captured!==true)throw fail('website_dns_restore_snapshot_invalid');
   const impact=await inspect(context);
   if(saved.ownership?.operationId!==impact.zone.ownershipOrigin.operationId
    ||saved.ownership?.evidenceDigest!==impact.zone.ownershipOrigin.evidenceDigest)throw fail('website_dns_restore_ownership_changed');
   const apiKey=await secret(context),current=await zoneManager.getZone(context.domain.primaryDomain,apiKey);
   const before=powerDnsZoneManagerInternals.normalizeRollbackSnapshot(saved.snapshot,context.domain.primaryDomain);
   const after=powerDnsZoneManagerInternals.normalizeRollbackSnapshot(current,context.domain.primaryDomain);
   if(before.dnssec||after.dnssec)throw fail('website_dns_restore_dnssec_unavailable');
   const result=await zoneManager.restoreSnapshot({zoneName:context.domain.primaryDomain,apiKey,before,after});
   const actual=await zoneManager.getZone(context.domain.primaryDomain,apiKey);
   if(result?.satisfied!==true||result.zoneName!==context.domain.primaryDomain
    ||!powerDnsZoneManagerInternals.sameZoneState(actual,before))throw fail('website_dns_restore_unverified');
   results.push({domainId:context.domain.id,restored:true,rrsetCount:before.rrsets.length});
  }
  return results;
 }
 return Object.freeze({capture,assertSupported,restore});
}
