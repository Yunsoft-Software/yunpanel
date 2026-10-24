import { websitePassengerEnvironmentInternals } from '@yunpanel/host-runtime/website-passenger-environment-manager';
import { domainNginxSettingsForTarget } from './domain-nginx-settings.js';
import { OPERATIONS } from '@yunpanel/protocol';
import { normalizePassengerNodeDeploySpec, normalizePassengerNodeRollbackSpec } from '@yunpanel/shared';
import { createWebsiteNodeReleaseManager } from '@yunpanel/host-runtime/website-node-release-manager';
import { createWebsitePassengerEnvironmentManager } from '@yunpanel/host-runtime/website-passenger-environment-manager';
import { createNginxManager, createApplicationEnvironmentBackupManager } from '@yunpanel/host-runtime';
import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';
import { createPassengerReleasePhaseStore, passengerReleasePhaseIdentity } from './passenger-release-phase-store.js';
import { normalizePassengerReleaseResult } from './passenger-release-job-result.js';
import { capturePassengerReleaseSnapshot, verifyPassengerReleaseBaselineTarget, passengerReleaseError as fail } from './passenger-release-snapshot.js';
import { materializeApplicationPassengerMigrationDomainEnvelope } from './application-passenger-migration-domain.js';

const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const releaseSpec = s => Object.fromEntries(['applicationId','deploymentId','repositoryUrl','branch','gitTarget','runtime','retention'].map(k=>[k,s[k]]));
const retainedSpec = a => ({applicationId:a.id,releaseId:a.currentReleaseId,commitSha:a.currentCommitSha,runtime:a.activeRuntime});
export function createLocalPassengerReleaseOperation({ applicationRegistry, websiteRegistry, domainRegistry, certificateRegistry,
  applicationEnvironmentRegistry, runtimeBindingRegistry, provisioningRegistry, siteMutationLock, localServerId,
  phaseStore=createPassengerReleasePhaseStore(), releaseManager=createWebsiteNodeReleaseManager(),
  environmentManager=createWebsitePassengerEnvironmentManager(), runtimeManager=createApplicationEnvironmentBackupManager(),
  nginxManager=createNginxManager(), healthInspector=createWebsiteHttpHealthInspector(), loadGitCredential=null, baselineTargetOptions={} }={}) {
  const dependencies={applicationRegistry,websiteRegistry,domainRegistry,runtimeBindingRegistry,applicationEnvironmentRegistry,localServerId};
  async function validateScope(spec,execution,{after=false,partialDomains=[]}={}) {
    const application=await applicationRegistry.getApplication(spec.applicationId);
    const websites=await websiteRegistry.listWebsites();const matching=websites.filter(w=>w.applicationId===spec.applicationId), website=matching[0];
    if(!application || application.serverId!==localServerId || execution.serverId!==localServerId || application.type!=='node'
      || application.runtimeAdapter!=='passenger' || matching.length!==1 || website.id!==spec.websiteId || website.revision!==spec.websiteRevision
      || website.serverId!==localServerId || website.runtimeType!=='node' || website.unixUser!==spec.unixUser
      || websites.some(w=>w.id!==website.id && w.unixUser===spec.unixUser) || application.desiredRevision!==spec.configurationRevision) throw fail('passenger_release_scope_drift');
    const domains=(await domainRegistry.listDomains()).filter(d=>d.websiteId===website.id).sort((a,b)=>a.id.localeCompare(b.id));
    if(!same(domains.map(d=>[d.id,d.desiredRevision]),spec.domains.map(d=>[d.domainId,d.desiredRevision]))
      || domains.some(d=>{const owned=after&&partialDomains.find(stage=>stage.domainId===d.id);
        const ownedStaged=owned && d.state==='staged' && d.stagedRevision===d.desiredRevision && d.stagedChecksum===owned.checksum && d.stagedConfigName===owned.configName;
        return d.serverId!==localServerId || (d.state!=='active'&&!ownedStaged) || d.lastError;})) throw fail('passenger_release_domain_drift');
    const environment=await applicationEnvironmentRegistry.environmentStatus(application.id);
    if(environment.savedRevision!==spec.environmentRevision) throw fail('passenger_release_environment_drift');
    if(!after) {
      const snapshot=await capturePassengerReleaseSnapshot({...dependencies,application});
      if(!same(snapshot.payload,{...snapshot.payload,...Object.fromEntries(Object.keys(snapshot.payload).map(k=>[k,spec[k]]))})
        || application.currentReleaseId!==(spec.previousReleaseId??spec.currentReleaseId)
        || application.activeDeploymentId!==execution.jobId) throw fail('passenger_release_snapshot_drift');
      if(spec.deploymentId && (!same(application.runtime,spec.runtime) || application.repositoryUrl!==spec.repositoryUrl || application.branch!==spec.branch
        || application.retention!==spec.retention)) throw fail('passenger_release_configuration_drift');
      if(!spec.deploymentId){const target=application.releases.find(r=>r.releaseId===spec.releaseId);
        if(!target || !same(target.runtime,spec.runtime)||target.commitSha!==spec.commitSha || target.configurationRevision!==spec.releaseConfigurationRevision
          || application.pendingRollbackReleaseId!==spec.releaseId) throw fail('passenger_release_retained_history_drift');}
      return snapshot;
    }
    return {application,website,domains,environment};
  }
  const health = (domain,runtime) => async () => (await healthInspector.inspect({primaryDomain:domain.primaryDomain,
    healthPath:runtime.healthPath,timeoutSeconds:runtime.healthTimeoutSeconds})).satisfied===true;
  async function verifyPhysical(spec,state,releaseId,values,revision,runtime,domains,absentKeys=[]) {
    const application={...state.application,currentReleaseId:releaseId,activeRuntime:runtime};
    for(const d of domains) {
      const actual=await nginxManager.inspectActiveDomain({primaryDomain:d.primaryDomain,checksum:d.nginxChecksum});
      if(actual.satisfied!==true || await health(d,runtime)()!==true) throw fail('passenger_release_traffic_unverified');
    }
    const actual=await runtimeManager.inspectAppliedPassengerEnvironment({application,unixUser:spec.unixUser,values,
      environmentRevision:revision,verifyHealth:health(domains[0],runtime),absentKeys});
    if(actual?.verified!==true || actual.releaseId!==releaseId || actual.environmentRevision!==revision) throw fail('passenger_release_process_unverified');
    return actual;
  }
  async function capture(spec,execution,snapshot) {
    const before=await runtimeManager.captureEnvironment({application:snapshot.application});
    const old=runtimeManager.capturedPassengerEnvironment({application:snapshot.application,savedRuntime:before});
    if(old.environmentRevision!==snapshot.environment.appliedRevision || snapshot.environment.appliedReleaseId!==snapshot.application.currentReleaseId) throw fail('passenger_release_baseline_environment_unverified');
    const previous=await releaseManager.inspectRetainedRelease(retainedSpec(snapshot.application));
    const expected=snapshot.binding.passengerTarget;
    await verifyPassengerReleaseBaselineTarget({application:snapshot.application,binding:snapshot.binding,release:previous},baselineTargetOptions);
    const domains=snapshot.domains.map(d=>({...d,nginxChecksum:d.stagedChecksum}));
    await verifyPhysical(spec,snapshot,snapshot.application.currentReleaseId,old.values,old.environmentRevision,snapshot.application.activeRuntime,domains);
    const values=await applicationEnvironmentRegistry.materialize(spec.applicationId,{expectedRevision:spec.environmentRevision});
    const operation=await provisioningRegistry.getLatestForWebsite(spec.websiteId);
    const original=operation?.websiteId===spec.websiteId?operation.steps?.find(step=>step.kind==='nginx')?.intent:null;
    const routing=[];
    for(const domain of domains) routing.push({domainId:domain.id,primaryDomain:domain.primaryDomain,
      envelope:{...await materializeApplicationPassengerMigrationDomainEnvelope(domain,certificateRegistry),
        nginxSettings:domainNginxSettingsForTarget(domain,'passenger'),
        ...(original?.mailDiscoverySocketPath?{mailDiscoverySocketPath:original.mailDiscoverySocketPath}:{}),
        ...(original?.acmeOnlyHostnames?.length?{acmeOnlyHostnames:original.acmeOnlyHostnames}:{}),}});
    for(const route of routing) {
      const expectedConfig=nginxManager.previewDomain({...route.envelope,targetType:'passenger',target:expected});
      if(expectedConfig.checksum!==domains.find(d=>d.id===route.domainId).stagedChecksum) throw fail('passenger_release_baseline_routing_unverified');
    }
    return {...snapshot,before,old,values,domains,routing,candidate:null,stages:[],attemptedDomains:[]};
  }
  function targetFor(spec,candidate){return {appRoot:candidate.appRoot,documentRoot:candidate.documentRoot,startupFile:candidate.startupFile,
    nodeBinary:candidate.nodeBinary,user:spec.unixUser,group:spec.unixUser,appEnv:spec.runtime.mode,
    environmentInclude:`/etc/yunpanel/passenger-env/${spec.applicationId}.conf`};}
  async function reconcile(spec,execution,state,result) {
    await validateScope(spec,execution,{after:true,partialDomains:state.stages});
    await verifyPhysical(spec,state,result.releaseId,state.values,spec.environmentRevision,spec.runtime,
      state.stages.map(d=>({...d,nginxChecksum:d.checksum})),Object.keys(state.old.values).filter(key=>!Object.hasOwn(state.values,key)));
    for(const stage of state.stages){await domainRegistry.markStaged(stage.domainId,{checksum:stage.checksum,configName:stage.configName,
      expectedRevision:spec.domains.find(d=>d.domainId===stage.domainId).desiredRevision});await domainRegistry.markApplied(stage.domainId,{checksum:stage.checksum});}
    await runtimeBindingRegistry.activate({applicationId:spec.applicationId,serverId:execution.serverId,adapter:'passenger',state:'active',
      sourceOperationId:execution.jobId,releaseId:result.releaseId,websiteId:spec.websiteId,websiteRevision:spec.websiteRevision,
      domains:result.domains,passengerTarget:targetFor(spec,state.candidate)},{expectedRevision:spec.bindingRevision});
    const current=await applicationRegistry.getApplication(spec.applicationId);
    if(current.currentReleaseId!==result.releaseId || current.activeDeploymentId!==null){
      if(spec.deploymentId) await applicationRegistry.markPassengerDeployed(spec.applicationId,{operationId:execution.jobId,releaseId:result.releaseId,
        previousReleaseId:result.previousReleaseId,commitSha:result.commitSha,gitTarget:result.gitTarget,runtime:spec.runtime});
      else await applicationRegistry.markPassengerRolledBack(spec.applicationId,{operationId:execution.jobId,releaseId:result.releaseId,
        previousReleaseId:result.previousReleaseId,port:null,serviceName:null,healthPath:result.healthPath,healthy:true});
    } else if(current.previousReleaseId!==result.previousReleaseId || current.currentCommitSha!==result.commitSha
      || !same(current.activeRuntime,spec.runtime) || current.appliedRevision!==result.configurationRevision) throw fail('passenger_release_metadata_drift');
    await applicationEnvironmentRegistry.markApplied({applicationId:spec.applicationId,revision:spec.environmentRevision,releaseId:result.releaseId});
  }
  async function compensate(spec,execution,state) {
    await validateScope(spec,execution,{after:true});
    const current=await applicationRegistry.getApplication(spec.applicationId);
    if(current.currentReleaseId!==state.application.currentReleaseId || current.activeDeploymentId!==execution.jobId) throw fail('passenger_release_compensation_metadata_drift');
    const previous=await releaseManager.inspectRetainedRelease(retainedSpec(state.application));
    const target=spec.deploymentId??spec.releaseId;
    const beforeEnvironment=await runtimeManager.captureEnvironment({application:{...state.application,currentReleaseId:previous.currentReleaseId,
      activeRuntime:previous.currentReleaseId===target?spec.runtime:state.application.activeRuntime}});
    const candidateContent=websitePassengerEnvironmentInternals.normalizeSpec({applicationId:spec.applicationId,values:state.values,environmentRevision:spec.environmentRevision}).content;
    if(beforeEnvironment.content!==state.before.content && beforeEnvironment.content!==candidateContent) throw fail('passenger_release_compensation_environment_drift');
    if(previous.currentReleaseId===target) await releaseManager.switchRetainedRelease({...retainedSpec(state.application),currentReleaseId:target,operationId:execution.jobId});
    else if(previous.currentReleaseId!==state.application.currentReleaseId) throw fail('passenger_release_compensation_pointer_drift');
    for(const id of [...state.attemptedDomains].reverse()) {
      const stage=state.stages.find(d=>d.domainId===id),old=state.domains.find(d=>d.id===id);
      if((await nginxManager.inspectActiveDomain({primaryDomain:old.primaryDomain,checksum:old.stagedChecksum})).satisfied!==true)
        await nginxManager.compensateDomain({primaryDomain:stage.primaryDomain,checksum:stage.checksum,activationId:execution.jobId});
    }
    await runtimeManager.restoreEnvironment({application:state.application,values:state.old.values,savedRuntime:state.before,
      environmentRevision:state.old.environmentRevision,verifyHealth:health(state.domains[0],state.application.activeRuntime),expectedCurrentContent:beforeEnvironment.content});
    await verifyPhysical(spec,state,state.application.currentReleaseId,state.old.values,state.old.environmentRevision,state.application.activeRuntime,state.domains,Object.keys(state.values).filter(key=>!Object.hasOwn(state.old.values,key)));
    if(spec.deploymentId) {
      const inspection=await releaseManager.inspectCompensation({applicationId:spec.applicationId,deploymentId:spec.deploymentId,previousReleaseId:spec.previousReleaseId});
      if(inspection.reason!=='website_node_release_compensation_receipt_missing') await releaseManager.discardOperationRelease({applicationId:spec.applicationId,deploymentId:spec.deploymentId,previousReleaseId:spec.previousReleaseId});
      else if((await releaseManager.inspectOperationReleaseAbsence({applicationId:spec.applicationId,deploymentId:spec.deploymentId,previousReleaseId:spec.previousReleaseId})).satisfied!==true) throw fail('passenger_release_candidate_inspection_required');
    }
  }
  async function execute(operation,payload,execution,{reauthorize,inspectionOnly=false,compensationOnly=false}={}) {
    const spec=operation===OPERATIONS.APP_NODE_PASSENGER_DEPLOY?normalizePassengerNodeDeploySpec(payload):normalizePassengerNodeRollbackSpec(payload);
    const identity=passengerReleasePhaseIdentity(operation,spec,execution);
    if(typeof siteMutationLock?.withSiteLock!=='function' || (!inspectionOnly&&!compensationOnly&&typeof reauthorize!=='function')) throw fail('passenger_release_lock_or_authority_unavailable');
    return siteMutationLock.withSiteLock({websiteId:spec.websiteId,applicationId:spec.applicationId,serverId:execution.serverId},async()=>{
      let record=await phaseStore.read(identity),state=record?.protectedState?phaseStore.unprotect(identity,record):null;
      const save=async(phase,extras={})=>{record=await phaseStore.save(identity,{phase,...extras,
        ...(state?{protectedState:phaseStore.protect(identity,state)}:{})},{expectedPhase:record?.phase??null});return record;};
      if(inspectionOnly){
        if(!record || !['published','reconciling','reconciled','blocked'].includes(record.phase)||!state||!record.result) throw fail('passenger_release_recovery_inspection_required');
        await reconcile(spec,execution,state,record.result);if(spec.deploymentId) await releaseManager.finalizeRetention(releaseSpec(spec));await save('reconciled');return record.result;
      }
      if(compensationOnly){
        if(record?.phase==='preflight' && !state){await validateScope(spec,execution);await save('rejected',{problemCode:'passenger_release_recovered_preflight'});return {compensated:true};}
        if(record?.phase==='rejected') {await validateScope(spec,execution);return {compensated:true};}
        if(!record||!state||record.result||['reconciling','reconciled'].includes(record.phase)) throw fail('passenger_release_recovery_inspection_required');
        if(record.phase!=='compensating') await save('compensating');await compensate(spec,execution,state);await save('compensated');return {compensated:true};}
      if(record) throw fail('passenger_release_resume_requires_stopped_consumer');
      await save('preflight');
      try {
        await reauthorize();const snapshot=await validateScope(spec,execution);state=await capture(spec,execution,snapshot);await save('captured');
      } catch(error){await save('rejected',{problemCode:typeof error?.code==='string'&&/^[a-z0-9_]{1,120}$/.test(error.code)?error.code:'passenger_release_preflight_failed'});throw error;}
      try {
        await save('preparing');
        if(spec.deploymentId) state.candidate=await releaseManager.prepare(releaseSpec(spec),{activate:false,
          environment:state.values,gitCredential:loadGitCredential?await loadGitCredential(spec.applicationId):null});
        else state.candidate=await releaseManager.inspectRetainedRelease({applicationId:spec.applicationId,releaseId:spec.releaseId,commitSha:spec.commitSha,runtime:spec.runtime});
        if(state.candidate.satisfied!==true || state.candidate.unixUser!==spec.unixUser) throw fail('passenger_release_candidate_unverified');
        for(const route of state.routing){const stage=await nginxManager.stageDomain({...route.envelope,targetType:'passenger',target:targetFor(spec,state.candidate)});
          state.stages.push({domainId:route.domainId,primaryDomain:route.primaryDomain,...stage});}
        await save('prepared');await reauthorize();await validateScope(spec,execution);
        await save('publishing');
        if(spec.deploymentId) await releaseManager.publishPrepared(releaseSpec(spec),{expectedPreviousReleaseId:spec.previousReleaseId});
        else await releaseManager.switchRetainedRelease({applicationId:spec.applicationId,releaseId:spec.releaseId,commitSha:spec.commitSha,
          runtime:spec.runtime,currentReleaseId:spec.currentReleaseId,operationId:execution.jobId});
        await environmentManager.apply({applicationId:spec.applicationId,values:state.values,environmentRevision:spec.environmentRevision},{operationId:execution.jobId});
        for(const stage of state.stages){state.attemptedDomains.push(stage.domainId);await save('publishing');await reauthorize();
          await nginxManager.activateDomain({primaryDomain:stage.primaryDomain,checksum:stage.checksum,activationId:execution.jobId});}
        await reauthorize();
        const next={...state.application,currentReleaseId:spec.deploymentId??spec.releaseId,activeRuntime:spec.runtime};
        await runtimeManager.applyEnvironment({application:next,values:state.values,environmentRevision:spec.environmentRevision,
          verifyHealth:health(state.stages[0],spec.runtime)});
        await verifyPhysical(spec,state,next.currentReleaseId,state.values,spec.environmentRevision,spec.runtime,state.stages.map(d=>({...d,nginxChecksum:d.checksum})),Object.keys(state.old.values).filter(key=>!Object.hasOwn(state.values,key)));
        await reauthorize();await validateScope(spec,execution,{after:true});
        const targetHistory=state.application.releases.find(r=>r.releaseId===spec.releaseId);
        const result=normalizePassengerReleaseResult({applicationId:spec.applicationId,websiteId:spec.websiteId,unixUser:spec.unixUser,
          operationId:execution.jobId,...(spec.deploymentId?{deploymentId:spec.deploymentId}:{}),releaseId:next.currentReleaseId,
          previousReleaseId:state.application.currentReleaseId,commitSha:state.candidate.commitSha,gitTarget:spec.gitTarget??targetHistory.gitTarget,
          environmentRevision:spec.environmentRevision,configurationRevision:spec.deploymentId?spec.configurationRevision:spec.releaseConfigurationRevision,
          bindingRevision:spec.bindingRevision+1,domains:state.stages.map(d=>({domainId:d.domainId,
            desiredRevision:spec.domains.find(e=>e.domainId===d.domainId).desiredRevision,nginxChecksum:d.checksum})),
          runtimeAdapter:'passenger',port:null,healthPath:spec.runtime.healthPath,healthy:true,active:true,published:true},{identity,payload:spec});
        await save('published',{result});await save('reconciling');await reconcile(spec,execution,state,result);await save('reconciled');
        if(spec.deploymentId) await releaseManager.finalizeRetention(releaseSpec(spec));
        return result;
      } catch(error){
        if(['published','reconciling','reconciled'].includes(record?.phase)) {await save('blocked',{problemCode:'passenger_release_reconciliation_required'});throw fail('passenger_release_reconciliation_required');}
        try {await save('compensating',{problemCode:typeof error?.code==='string'&&/^[a-z0-9_]{1,120}$/.test(error.code)?error.code:'passenger_release_failed'});
          await compensate(spec,execution,state);await save('compensated');}
        catch {await save('blocked',{problemCode:'passenger_release_compensation_required'});throw fail('passenger_release_compensation_required');}
        throw error;
      }
    });
  }
  return Object.freeze({execute,inspectRecovery:(operation,payload,execution)=>execute(operation,payload,execution,{inspectionOnly:true}),
    compensateRecovery:(operation,payload,execution)=>execute(operation,payload,execution,{compensationOnly:true}),phaseStore});
}
