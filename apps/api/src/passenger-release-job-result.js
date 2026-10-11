import { assertUuid, normalizeGitDeploymentTarget } from '@yunpanel/shared';
import { OPERATIONS } from '@yunpanel/protocol';
const fields = new Set(['applicationId','websiteId','unixUser','operationId','deploymentId','releaseId','previousReleaseId','commitSha','gitTarget',
  'environmentRevision','configurationRevision','bindingRevision','domains','runtimeAdapter','port','healthPath','healthy','active','published']);
const fail = () => { throw Object.assign(new Error('Passenger release result does not match the queued site and revision'), { code:'invalid_job_result' }); };
export function normalizePassengerReleaseResult(result, { identity = null, payload = null, operation = identity?.operation } = {}) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(k=>!fields.has(k))
      || !/^yunapp-[a-f0-9]{12}$/.test(result.unixUser??'') || !/^[a-f0-9]{40}$/.test(result.commitSha??'')
      || result.runtimeAdapter!=='passenger' || result.port!==null || result.healthy!==true || result.active!==true || result.published!==true
      || typeof result.healthPath!=='string' || !result.healthPath.startsWith('/') || result.healthPath.length>300 || /[\r\n\0]/.test(result.healthPath)
      || !Number.isSafeInteger(result.environmentRevision) || result.environmentRevision<0
      || !Number.isSafeInteger(result.configurationRevision) || result.configurationRevision<1 || !Number.isSafeInteger(result.bindingRevision) || result.bindingRevision<2) fail();
    const normalized={...result};
    for(const k of ['applicationId','websiteId','operationId','releaseId','previousReleaseId']) normalized[k]=assertUuid(result[k],k);
    if(normalized.releaseId===normalized.previousReleaseId) fail();
    normalized.gitTarget=normalizeGitDeploymentTarget(result.gitTarget);
    if(normalized.gitTarget.kind==='commit' && normalized.gitTarget.value!==normalized.commitSha) fail();
    if(!Array.isArray(result.domains)||result.domains.length<1||result.domains.length>32) fail();
    const seen=new Set();
    normalized.domains=result.domains.map(d=>{
      if(!d||Object.keys(d).length!==3||Object.keys(d).some(k=>!['domainId','desiredRevision','nginxChecksum'].includes(k))
        || !Number.isSafeInteger(d.desiredRevision)||d.desiredRevision<1||!/^[a-f0-9]{64}$/.test(d.nginxChecksum??'')) fail();
      const id=assertUuid(d.domainId,'domainId');if(seen.has(id)) fail();seen.add(id);
      return {domainId:id,desiredRevision:d.desiredRevision,nginxChecksum:d.nginxChecksum};
    }).sort((a,b)=>a.domainId.localeCompare(b.domainId));
    if(operation===OPERATIONS.APP_NODE_PASSENGER_DEPLOY){
      normalized.deploymentId=assertUuid(result.deploymentId,'deploymentId');
      if(normalized.deploymentId!==normalized.operationId||normalized.releaseId!==normalized.operationId) fail();
    } else if(operation!==OPERATIONS.APP_NODE_PASSENGER_ROLLBACK || Object.hasOwn(result,'deploymentId')) fail();
    if(identity && (normalized.operationId!==identity.jobId || normalized.applicationId!==identity.applicationId || normalized.websiteId!==identity.websiteId)) fail();
    if(payload){
      if(['applicationId','websiteId','unixUser','environmentRevision'].some(k=>normalized[k]!==payload[k])
        || normalized.bindingRevision!==payload.bindingRevision+1 || normalized.healthPath!==payload.runtime.healthPath
        || normalized.configurationRevision!==(operation===OPERATIONS.APP_NODE_PASSENGER_DEPLOY?payload.configurationRevision:payload.releaseConfigurationRevision)
        || normalized.previousReleaseId!==(operation===OPERATIONS.APP_NODE_PASSENGER_DEPLOY?payload.previousReleaseId:payload.currentReleaseId)
        || normalized.releaseId!==(operation===OPERATIONS.APP_NODE_PASSENGER_DEPLOY?payload.deploymentId:payload.releaseId)
        || JSON.stringify(normalized.domains.map(d=>[d.domainId,d.desiredRevision]))!==JSON.stringify(payload.domains.map(d=>[d.domainId,d.desiredRevision]))) fail();
      if(operation===OPERATIONS.APP_NODE_PASSENGER_DEPLOY && JSON.stringify(normalized.gitTarget)!==JSON.stringify(payload.gitTarget)) fail();
      if(operation===OPERATIONS.APP_NODE_PASSENGER_ROLLBACK && normalized.commitSha!==payload.commitSha) fail();
    }
    return normalized;
  } catch { fail(); }
}
