import {normalizeNodeRestartSpec} from '@yunpanel/shared';
import {createApplicationEnvironmentBackupManager} from '@yunpanel/host-runtime';
import {createWebsiteHttpHealthInspector} from '@yunpanel/host-runtime/website-http-health-inspector';

const fail=code=>Object.assign(new Error('Passenger uygulaması güvenli biçimde yeniden başlatılamadı'),{code,status:409});
export function createLocalPassengerRestartOperation({applicationRegistry,websiteRegistry,domainRegistry,applicationEnvironmentRegistry,
 siteMutationLock,runtimeManager=createApplicationEnvironmentBackupManager(),healthInspector=createWebsiteHttpHealthInspector()}={}){
 async function execute(payload,execution,{inspectionOnly=false}={}){
  const spec=normalizeNodeRestartSpec(payload);
  if(spec.runtimeAdapter!=='passenger'||execution?.resourceType!=='application'||execution.resourceId!==spec.applicationId
   ||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(execution?.jobId??''))throw fail('passenger_restart_scope_invalid');
  const application=await applicationRegistry.getApplication(spec.applicationId);
  const websites=await websiteRegistry.listWebsites();const matching=websites.filter(w=>w.applicationId===spec.applicationId);
  if(!application||application.type!=='node'||application.runtimeAdapter!=='passenger'||application.serverId!==execution.serverId
   ||application.currentReleaseId!==spec.releaseId||matching.length!==1||matching[0].serverId!==application.serverId
   ||matching[0].runtimeType!=='node'||!/^yunapp-[a-f0-9]{12}$/.test(matching[0].unixUser??'')
   ||websites.some(w=>w.id!==matching[0].id&&w.unixUser===matching[0].unixUser))throw fail('passenger_restart_scope_invalid');
  const website=matching[0];
  if(JSON.stringify(normalizeNodeRestartSpec({...payload,runtime:application.activeRuntime??application.runtime}).runtime)!==JSON.stringify(spec.runtime))throw fail('passenger_restart_runtime_changed');
  if(typeof siteMutationLock?.withSiteLock!=='function')throw fail('passenger_restart_lock_unavailable');
   if(typeof runtimeManager.inspectAppliedPassengerEnvironment!=='function')throw fail('passenger_restart_process_inspection_unavailable');
  return siteMutationLock.withSiteLock({websiteId:website.id,applicationId:application.id,serverId:application.serverId},async()=>{
   const current=await applicationRegistry.getApplication(application.id);
   if(current?.currentReleaseId!==application.currentReleaseId||current?.runtimeAdapter!=='passenger')throw fail('passenger_restart_runtime_changed');
   const status=await applicationEnvironmentRegistry.environmentStatus(application.id);
   if(status.savedRevision!==payload.environmentRevision)throw fail('passenger_restart_environment_changed');
   const values=await applicationEnvironmentRegistry.materialize(application.id,{expectedRevision:payload.environmentRevision});
   const domains=(await domainRegistry.listDomains()).filter(d=>d.websiteId===website.id&&d.serverId===website.serverId);
   const domain=domains.find(d=>d.primaryDomain===website.name)??(domains.length===1?domains[0]:null);
   if(!domain)throw fail('passenger_restart_domain_scope_invalid');
   const verifyHealth=async()=>(await healthInspector.inspect({primaryDomain:domain.primaryDomain,healthPath:spec.runtime.healthPath,timeoutSeconds:spec.runtime.healthTimeoutSeconds})).satisfied===true;
   if(inspectionOnly){
    if(status.appliedRevision!==status.savedRevision || status.appliedReleaseId!==application.currentReleaseId
     || !Number.isFinite(Date.parse(status.lastAppliedAt)))throw fail('passenger_restart_applied_state_unverified');
    const actual=await runtimeManager.inspectAppliedPassengerEnvironment({application,unixUser:website.unixUser,values,
     environmentRevision:status.savedRevision,verifyHealth});
    if(actual?.verified!==true || actual.applicationId!==application.id || actual.releaseId!==application.currentReleaseId
     || actual.environmentRevision!==status.savedRevision)throw fail('passenger_restart_process_unverified');
    return{...actual,runtimeAdapter:'passenger',port:null,healthPath:spec.runtime.healthPath,healthy:true,appliedAt:status.lastAppliedAt};
   }
   const before=await runtimeManager.captureEnvironment({application});
   const applied=await runtimeManager.applyEnvironment({application,values,environmentRevision:status.savedRevision,verifyHealth});
   if(applied?.verified!==true||applied.appliedMatchesSaved!==true||applied.applicationId!==application.id)throw fail('passenger_restart_unverified');
   try {
   const actual=await runtimeManager.inspectAppliedPassengerEnvironment({application,unixUser:website.unixUser,values,
    environmentRevision:status.savedRevision,verifyHealth});
   if(actual?.verified!==true || actual.applicationId!==application.id || actual.releaseId!==application.currentReleaseId
    || actual.environmentRevision!==status.savedRevision)throw fail('passenger_restart_process_unverified');
   await applicationEnvironmentRegistry.markApplied({applicationId:application.id,revision:status.savedRevision,releaseId:application.currentReleaseId});}
   catch(error){await runtimeManager.restoreEnvironment({application,values,environmentRevision:status.savedRevision,savedRuntime:before,verifyHealth});throw error;}
   return{applicationId:application.id,releaseId:application.currentReleaseId,environmentRevision:status.savedRevision,
    runtimeAdapter:'passenger',port:null,healthPath:spec.runtime.healthPath,restarted:true,healthy:true};
  });
 }
 return Object.freeze({execute,inspectRecovery:(payload,execution)=>execute(payload,execution,{inspectionOnly:true})});
}
