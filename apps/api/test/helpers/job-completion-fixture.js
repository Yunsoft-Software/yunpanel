import assert from 'node:assert/strict';
import { reconcileCompletedJob } from '../../src/job-reconciliation.js';

export async function completeNextJob(jobRegistry, {
  serverId,
  status = 'succeeded',
  result = null,
  error = null,
  domainRegistry = null,
  certificateRegistry = null,
  applicationRegistry = null,
  applicationEnvironmentRegistry = null,
  websiteRegistry = null,
  runtimeBindingRegistry = null,
  mailDomainRegistry = null,
} = {}) {
  const claim = await jobRegistry.claimNext(serverId);
  assert.ok(claim, `expected queued job for server ${serverId}`);
  const job = await jobRegistry.complete({
    serverId,
    jobId: claim.job.id,
    status,
    result,
    error,
  });
  await reconcileCompletedJob({
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    websiteRegistry,
    runtimeBindingRegistry,
    mailDomainRegistry,
    job,
  });
  return { claim, job };
}
