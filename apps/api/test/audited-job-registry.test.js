import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditedJobRegistry } from '../src/audited-job-registry.js';
import { withAuditActor } from '../src/audit-request-context.js';

test('HTTP request jobs capture live session and resolved site scope while system jobs keep explicit authorization', async () => {
  const queued = [];
  const registry = createAuditedJobRegistry({
    registry: { enqueue: async (input) => { queued.push(input); return { id: 'job-test', operation: 'ssl.renew' }; }, complete: async () => {}, cancel: async () => {} },
    audit: { linkJob() {}, recordJobOutcome() {} }, resolveJobWebsite: async () => 'website-a',
  });
  const actor = { userId: 'user-a', sessionId: 'session-a', role: 'site_manager' };
  await withAuditActor('user-a', () => registry.enqueue({ serverId: 'server-a', resourceType: 'certificate', resourceId: 'cert-a', payload: {} }), { actor });
  assert.deepEqual(queued[0].authorization, { kind: 'panel', actorId: 'user-a', userId: 'user-a', sessionId: 'session-a',
    role: 'site_manager', serverId: 'server-a', scope: 'website', websiteId: 'website-a' });
  await registry.enqueue({ serverId: 'server-a', payload: {} });
  assert.equal(queued[1].authorization, undefined);
});

test('a tenant job with unresolved scope is denied before enqueue', async () => {
  let writes = 0;
  const registry = createAuditedJobRegistry({
    registry: { enqueue: async () => { writes++; }, complete: async () => {}, cancel: async () => {} },
    audit: { linkJob() {}, recordJobOutcome() {} }, resolveJobWebsite: async () => null,
  });
  await assert.rejects(withAuditActor('user-a', () => registry.enqueue({ serverId: 'server-a', payload: {} }),
    { actor: { userId: 'user-a', sessionId: 'session-a', role: 'site_manager' } }), { code: 'panel_job_scope_unavailable' });
  assert.equal(writes, 0);
});

function fixture({ actorId = 'owner-1', failLink = false, failOutcome = false } = {}) {
  const auditCalls = [];
  const auditErrors = [];
  let status = 'queued';
  const job = {
    id: 'job-1',
    operation: 'domain.stage',
    resourceType: 'domain',
    resourceId: 'domain-1',
    status,
    error: null,
  };
  const base = {
    async enqueue() { status = 'queued'; return { ...job, status }; },
    async complete(input) {
      status = input.status;
      return { ...job, status, error: input.status === 'failed' ? { code: input.error?.code ?? 'job_failed' } : null };
    },
    async cancel() { status = 'cancelled'; return { ...job, status }; },
    async listJobs() { return [{ ...job, status }]; },
    recovery() { return { jobs: [] }; },
  };
  const audit = {
    linkJob(input) {
      auditCalls.push(['link', input]);
      if (failLink) throw new Error('private audit path');
    },
    recordJobOutcome(input) {
      auditCalls.push(['outcome', input]);
      if (failOutcome) throw new Error('private audit path');
    },
  };
  const registry = createAuditedJobRegistry({
    registry: base,
    audit,
    actorProvider: () => actorId,
    onAuditError: (metadata) => auditErrors.push(metadata),
  });
  return { registry, auditCalls, auditErrors };
}

test('enqueue links async job to the current request actor without changing public job shape', async () => {
  const { registry, auditCalls } = fixture();
  const job = await registry.enqueue({ ignored: true });
  assert.equal(job.id, 'job-1');
  assert.equal('actorId' in job, false);
  assert.deepEqual(auditCalls, [[
    'link',
    { jobId: 'job-1', actorId: 'owner-1', action: 'job.domain.stage', resourceType: 'domain', resourceId: 'domain-1' },
  ]]);
});

test('system-created jobs use an explicit system actor when no request actor exists', async () => {
  const { registry, auditCalls } = fixture({ actorId: null });
  await registry.enqueue({});
  assert.equal(auditCalls[0][1].actorId, 'system');
});

test('succeeded failed and cancelled terminal states are forwarded without raw result metadata', async () => {
  const { registry, auditCalls } = fixture();
  await registry.enqueue({});
  await registry.complete({ status: 'succeeded' });
  assert.deepEqual(auditCalls[1], ['outcome', { jobId: 'job-1', outcome: 'succeeded', code: null }]);

  const failedFixture = fixture();
  await failedFixture.registry.enqueue({});
  await failedFixture.registry.complete({ status: 'failed', error: { code: 'safe_code', message: 'SECRET=/root/private' } });
  assert.deepEqual(failedFixture.auditCalls[1], ['outcome', { jobId: 'job-1', outcome: 'failed', code: 'safe_code' }]);
  assert.equal(JSON.stringify(failedFixture.auditCalls).includes('SECRET'), false);

  const cancelledFixture = fixture();
  await cancelledFixture.registry.enqueue({});
  await cancelledFixture.registry.cancel('job-1');
  assert.deepEqual(cancelledFixture.auditCalls[1], ['outcome', { jobId: 'job-1', outcome: 'cancelled' }]);
});

test('audit link or terminal write failure never rewrites a persisted job outcome', async () => {
  const linked = fixture({ failLink: true });
  const queued = await linked.registry.enqueue({});
  assert.equal(queued.status, 'queued');
  assert.deepEqual(linked.auditErrors, [{ phase: 'link', jobId: 'job-1' }]);

  const completed = fixture({ failOutcome: true });
  await completed.registry.enqueue({});
  const job = await completed.registry.complete({ status: 'succeeded' });
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(completed.auditErrors, [{ phase: 'complete', jobId: 'job-1' }]);
});

test('non-mutating registry methods pass through unchanged', async () => {
  const { registry } = fixture();
  assert.equal((await registry.listJobs()).length, 1);
  assert.deepEqual(registry.recovery(), { jobs: [] });
});
