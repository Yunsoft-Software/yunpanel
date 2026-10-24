import { assertUuid } from '@yunpanel/shared';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';
import { PASSENGER_RELEASE_OPERATIONS, passengerPayload } from './passenger-release-reconciliation.js';
import { passengerReleaseError as fail } from './passenger-release-snapshot.js';

export async function recoverPassengerRelease({serverId,jobId,jobRegistry,operation,dependencies,serviceStatus,loadJobContext,
  compensationOnly=false,inspect=inspectDurableJobRecovery,reconcile=reconcileCompletedJob}={}) {
  assertUuid(serverId,'serverId');assertUuid(jobId,'jobId');
  async function stopped(){const status=await serviceStatus();
    if(!status || typeof status.apiActive!=='boolean' || typeof status.agentActive!=='boolean' || status.apiActive || status.agentActive) throw fail('passenger_release_recovery_consumers_must_be_stopped');}
  await stopped();
  const inspection=await inspect({registry:jobRegistry});
  const candidate=inspection.jobs.find(j=>j.jobId===jobId&&j.serverId===serverId);
  const job=await jobRegistry.getJob(jobId),context=await loadJobContext(jobId);
  if(!candidate || !job || !context || context.id!==jobId || context.serverId!==serverId || context.status!==job.status
    || job.serverId!==serverId || !PASSENGER_RELEASE_OPERATIONS.has(job.operation) || context.operation!==job.operation
    || job.resourceType!=='application' || context.resourceType!==job.resourceType || context.resourceId!==job.resourceId
    || candidate.operation!==job.operation || candidate.resourceId!==job.resourceId || candidate.resourceType!=='application' || candidate.status!==job.status || !['running','succeeded','failed'].includes(job.status)) throw fail('passenger_release_recovery_context_invalid');
  const payload=passengerPayload(context),execution={jobId,serverId,resourceType:'application',resourceId:job.resourceId};
  await stopped();
  let result=null;
  if(compensationOnly){
    if(job.status==='succeeded') throw fail('passenger_release_recovery_completed_publication');
    const proof=await operation.compensateRecovery(job.operation,payload,execution);
    if(proof?.compensated!==true)throw fail('passenger_release_recovery_compensation_unverified');
  } else result=await operation.inspectRecovery(job.operation,payload,execution);
  await stopped();
  let terminal=job;
  if(job.status==='running'){
    const begun=await jobRegistry.beginReconciliation({serverId,jobId});
    if(!begun || begun.jobId!==jobId || begun.serverId!==serverId || begun.pending!==true)throw fail('passenger_release_recovery_journal_invalid');
    terminal=await jobRegistry.complete({serverId,jobId,status:compensationOnly?'failed':'succeeded',
      ...(compensationOnly?{error:{code:'passenger_release_recovered_compensation',message:'The unaccepted operation was physically compensated'}}:{result})});
  }
  // A previously failed historical job keeps its status even when its physically
  // accepted publication needs control-plane repair. It is never relabeled.
  const reconciled=await reconcile({...dependencies,job:terminal,passengerReleasePhaseStore:operation.phaseStore});
  if(reconciled?.reconciled!==true)throw fail('passenger_release_recovery_reconciliation_unverified');
  const ack=await jobRegistry.acknowledgeReconciliation({serverId,jobId});
  if(ack?.acknowledged!==true || ack.jobId!==jobId || ack.serverId!==serverId || ack.status!==terminal.status)throw fail('passenger_release_recovery_acknowledgement_invalid');
  return {serverId,jobId,operation:job.operation,status:terminal.status,applicationId:job.resourceId,reconciled:true,
    recoveryMethod:compensationOnly?'verified_passenger_compensation':'verified_passenger_release_and_process'};
}
