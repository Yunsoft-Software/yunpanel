import { OPERATIONS } from '@yunpanel/protocol';
import { normalizePassengerNodeDeploySpec, normalizePassengerNodeRollbackSpec } from '@yunpanel/shared';
import { createPassengerReleasePhaseStore, passengerReleasePhaseIdentity } from './passenger-release-phase-store.js';
import { normalizePassengerReleaseResult } from './passenger-release-job-result.js';
import { passengerReleaseError as fail } from './passenger-release-snapshot.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const PASSENGER_RELEASE_OPERATIONS=new Set([OPERATIONS.APP_NODE_PASSENGER_DEPLOY,OPERATIONS.APP_NODE_PASSENGER_ROLLBACK]);
export function passengerPayload(job){
  const payload=Object.fromEntries(Object.entries(job.payload??{}).filter(([key])=>key!=='authorization'));
  return job.operation===OPERATIONS.APP_NODE_PASSENGER_DEPLOY?normalizePassengerNodeDeploySpec(payload):normalizePassengerNodeRollbackSpec(payload);
}
export async function reconcilePassengerReleaseJob({job,applicationRegistry,applicationEnvironmentRegistry,websiteRegistry,domainRegistry,runtimeBindingRegistry,
  passengerReleasePhaseStore=null}){
  const payload=passengerPayload(job),identity=passengerReleasePhaseIdentity(job.operation,payload,
    {jobId:job.id,serverId:job.serverId,resourceType:job.resourceType,resourceId:job.resourceId});
  const store=passengerReleasePhaseStore??createPassengerReleasePhaseStore(),record=await store.read(identity);
  const application=await applicationRegistry.getApplication(payload.applicationId);
  if(!application || application.serverId!==job.serverId || application.runtimeAdapter!=='passenger')throw fail('passenger_release_reconciliation_scope_invalid');
  if(job.status==='failed' && ((record && ['rejected','compensated'].includes(record.phase))
    || (!record && ['panel_job_actor_forbidden','job_tenant_reauthorization_failed'].includes(job.error?.code)))){
    const before=payload.previousReleaseId??payload.currentReleaseId;
    if(application.currentReleaseId!==before || (application.activeDeploymentId!==job.id && application.activeDeploymentId!==null))throw fail('passenger_release_reconciliation_state_drift');
    if(application.activeDeploymentId===job.id)await applicationRegistry.markFailed(application.id,job.id,job.error?.code??'passenger_release_failed');
    return {reconciled:true,outcome:'failed'};
  }
  if(!record || record.phase!=='reconciled' || !record.result)throw fail('passenger_release_reconciliation_required');
  const result=normalizePassengerReleaseResult(record.result,{identity,payload});
  if(job.status==='succeeded' && !same(result,job.result))throw fail('passenger_release_result_drift');
  const website=await websiteRegistry.getWebsite(payload.websiteId),binding=await runtimeBindingRegistry.getBinding(payload.applicationId),
    environment=await applicationEnvironmentRegistry.environmentStatus(payload.applicationId);
  if(!website || website.applicationId!==application.id || website.unixUser!==payload.unixUser || website.serverId!==job.serverId
    || website.revision!==payload.websiteRevision || application.activeDeploymentId!==null || application.currentReleaseId!==result.releaseId
    || application.previousReleaseId!==result.previousReleaseId || application.currentCommitSha!==result.commitSha
    || !same(application.activeRuntime,payload.runtime) || application.appliedRevision!==result.configurationRevision
    || !binding || binding.sourceOperationId!==job.id || binding.releaseId!==result.releaseId || binding.websiteId!==website.id
    || binding.serverId!==job.serverId || binding.adapter!=='passenger' || binding.state!=='active' || binding.revision!==result.bindingRevision
    || !same(binding.domains,result.domains) || environment.appliedRevision!==result.environmentRevision || environment.appliedReleaseId!==result.releaseId)throw fail('passenger_release_reconciliation_state_drift');
  for(const evidence of result.domains){const domain=await domainRegistry.getDomain(evidence.domainId);
    if(!domain || domain.websiteId!==website.id || domain.serverId!==job.serverId || domain.state!=='active'
      || domain.desiredRevision!==evidence.desiredRevision || domain.appliedRevision!==evidence.desiredRevision
      || domain.stagedChecksum!==evidence.nginxChecksum || domain.lastError)throw fail('passenger_release_reconciliation_domain_drift');}
  return {reconciled:true,outcome:job.status};
}
