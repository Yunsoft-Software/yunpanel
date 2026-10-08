import assert from 'node:assert/strict';
import test from 'node:test';
import { MANAGED_SERVICE_CONTROL_IDS, OPERATIONS } from '@yunpanel/protocol';
import { DEFAULT_AI_TOOL_DEFINITIONS, AI_TOOL_RISKS, AI_TOOL_CONFIRMATION } from '../src/ai-tool-catalog.js';
import { createAiToolRegistry, AiToolRegistryError } from '../src/ai-tool-registry.js';
import { createAiToolRuntime, AiToolRuntimeError } from '../src/ai-tool-runtime.js';
import { createAiActionPlan, verifyAiActionExecution, AiActionPlanError } from '../src/ai-action-plan.js';
import { evaluateAiToolPolicy } from '../src/ai-policy.js';
import { createAiMcpAdapter, MCP_ERROR_CODES } from '../src/ai-mcp-adapter.js';

const ownerAuth = Object.freeze({
  user: Object.freeze({ id: 'owner-user-1', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const readOnlyAuth = Object.freeze({
  user: Object.freeze({ id: 'reader-1', role: 'read_only' }),
  access: Object.freeze({ mode: 'read_only', permissions: Object.freeze(['audit.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

const customerTenantAuth = Object.freeze({
  user: Object.freeze({ id: 'cust-1', role: 'customer', tenantId: 'cust-tenant-1' }),
  access: Object.freeze({ mode: 'customer', permissions: Object.freeze(['website.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

function createMockAudit() {
  const events = [];
  return {
    events,
    record(event) {
      events.push(event);
      return event;
    },
  };
}

function createFullToolFixture({ activeJob = null } = {}) {
  const localServerId = 'server-local-1';
  const server = { id: localServerId, serverId: localServerId, hostname: 'staging.yunpanel', executionMode: 'local', status: 'online' };
  const website = { id: 'web-1', serverId: localServerId, name: 'MainSite', applicationId: 'app-node-1' };
  const application = {
    id: 'app-node-1',
    serverId: localServerId,
    type: 'node',
    currentReleaseId: 'rel-2',
    previousReleaseId: 'rel-1',
    releases: [{ releaseId: 'rel-1', runtime: { nodeMajor: 24 } }, { releaseId: 'rel-2', runtime: { nodeMajor: 24 } }],
    activeDeploymentId: null,
    runtime: { nodeMajor: 24 },
    activeRuntime: { nodeMajor: 24 },
  };
  const domain = { id: 'dom-1', serverId: localServerId, websiteId: 'web-1', domainName: 'example.com', primaryDomain: 'example.com' };
  const dnsZone = { id: 'zone-1', webDomainId: 'dom-1', zoneName: 'example.com', serverId: localServerId, status: 'ready' };
  const certificate = { id: 'cert-1', domainId: 'dom-1', certName: 'example.com', state: 'active', serverId: localServerId, validTo: '2027-01-01' };
  const mailDomain = { id: 'mail-1', webDomainId: 'dom-1', domainName: 'example.com', status: 'ready' };
  const dbBinding = { id: 'bind-1', serverId: localServerId, websiteId: 'web-1', databaseName: 'app_db' };

  const enqueuedJobs = [];
  if (activeJob) enqueuedJobs.push(activeJob);

  const jobRegistry = {
    async getJob(id) {
      return enqueuedJobs.find((j) => j.id === id) ?? null;
    },
    async listJobs(filter = {}) {
      return enqueuedJobs.filter((j) => {
        if (filter.serverId && j.serverId !== filter.serverId) return false;
        if (filter.resourceType && j.resourceType !== filter.resourceType) return false;
        if (filter.resourceId && j.resourceId !== filter.resourceId) return false;
        return true;
      });
    },
    async enqueue(spec) {
      const job = {
        id: `job-${enqueuedJobs.length + 1}`,
        serverId: spec.serverId,
        type: spec.type,
        operation: spec.operation,
        resourceType: spec.resourceType,
        resourceId: spec.resourceId,
        status: 'queued',
        createdAt: new Date().toISOString(),
        payload: spec.payload,
        result: null,
        error: null,
      };
      enqueuedJobs.push(job);
      return job;
    },
  };

  const serverRegistry = {
    async listServers() { return [server]; },
    async getServer(id) { return id === localServerId ? server : null; },
  };

  const websiteRegistry = {
    async listWebsites() { return [website]; },
    async getWebsite(id) { return id === website.id ? website : null; },
  };

  const domainRegistry = {
    async listDomains() { return [domain]; },
    async getDomain(id) { return id === domain.id ? domain : null; },
  };

  const applicationRegistry = {
    async getApplication(id) { return id === application.id ? application : null; },
    async markRollingBack(id, jobId, releaseId) {
      return { ...application, activeDeploymentId: jobId, currentReleaseId: releaseId };
    },
  };

  const applicationEnvironmentRegistry = {
    async environmentStatus(id) {
      assert.equal(id, application.id);
      return { savedRevision: 5 };
    },
  };

  const dnsHostingRegistry = {
    async listZones() { return [dnsZone]; },
    async getZone(id) { return id === dnsZone.id ? dnsZone : null; },
  };

  const certificateRegistry = {
    async getCertificate(id) { return id === certificate.id ? certificate : null; },
    async getForDomain(id) { return id === domain.id ? certificate : null; },
  };

  const mailDomainRegistry = {
    async listMailDomains() { return [mailDomain]; },
    async getMailDomain(id) { return id === mailDomain.id ? mailDomain : null; },
  };

  const databaseBindingRegistry = {
    async listBindings({ serverId, websiteId }) {
      return (serverId === localServerId && websiteId === website.id) ? [dbBinding] : [];
    },
    async getByDatabase({ serverId, databaseName }) {
      return (serverId === localServerId && databaseName === dbBinding.databaseName) ? dbBinding : null;
    },
  };

  const backupOperations = [];
  const websiteBackupSetProvider = {
    async getWebsiteBackupSet({ websiteId, serverId }) {
      return { websiteId, serverId, repositories: [{ id: 'repo-1' }], snapshots: [{ id: 'snap-1' }] };
    },
  };
  const websiteBackupService = {
    async executeBackup(opts) {
      backupOperations.push({ type: 'create', ...opts });
      return { backupId: 'bk-new-1', websiteId: opts.websiteId, status: 'succeeded' };
    },
  };
  const websiteRestoreService = {
    async executeRestore(opts) {
      backupOperations.push({ type: 'restore', ...opts });
      return { restoreId: 'rst-new-1', websiteId: opts.websiteId, snapshotId: opts.snapshotId, status: 'succeeded' };
    },
  };

  const journalLogReader = {
    async query({ unit, limit, search }) {
      return {
        entries: [
          { timestamp: '2026-10-07T00:00:00Z', unit, message: 'service active', search },
        ],
      };
    },
  };

  const deployQueue = async ({ applicationId, gitTarget }) => {
    const job = await jobRegistry.enqueue({
      serverId: localServerId,
      type: 'app.node.deploy',
      operation: OPERATIONS.APP_NODE_DEPLOY,
      resourceType: 'application',
      resourceId: applicationId,
      payload: { applicationId, gitTarget },
    });
    return { application, job, replayed: false };
  };

  const runtime = createAiToolRuntime({
    localServerId,
    serverRegistry,
    websiteRegistry,
    domainRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    jobRegistry,
    dnsHostingRegistry,
    certificateRegistry,
    mailDomainRegistry,
    databaseBindingRegistry,
    websiteBackupSetProvider,
    websiteBackupService,
    websiteRestoreService,
    journalLogReader,
    applicationDeployQueue: deployQueue,
  });

  return {
    runtime,
    enqueuedJobs,
    backupOperations,
    jobRegistry,
    localServerId,
    website,
    application,
    domain,
    dnsZone,
    certificate,
  };
}

// =========================================================================
// Section 1: Catalog Definition & Safe Tool Contracts
// =========================================================================

test('Catalog Contract: all 20 AI tools have strict schemas, bounded risks and defined confirmations', () => {
  assert.equal(DEFAULT_AI_TOOL_DEFINITIONS.length, 20);

  const risks = new Set(Object.values(AI_TOOL_RISKS));
  const confirmations = new Set(Object.values(AI_TOOL_CONFIRMATION));

  for (const tool of DEFAULT_AI_TOOL_DEFINITIONS) {
    assert.ok(typeof tool.name === 'string');
    assert.ok(risks.has(tool.risk));
    assert.ok(confirmations.has(tool.confirmation));
    assert.ok(['allow', 'confirm', 'deny'].includes(tool.defaultPolicy));
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  // Destructive tool must ALWAYS require confirmation and default to confirm
  const restoreTool = DEFAULT_AI_TOOL_DEFINITIONS.find((t) => t.name === 'backup.restore');
  assert.equal(restoreTool.risk, AI_TOOL_RISKS.DESTRUCTIVE);
  assert.equal(restoreTool.confirmation, AI_TOOL_CONFIRMATION.ALWAYS);
  assert.equal(restoreTool.defaultPolicy, 'confirm');

  // Reversible write tools have configurable confirmation
  const writeTools = DEFAULT_AI_TOOL_DEFINITIONS.filter((t) => t.risk === AI_TOOL_RISKS.REVERSIBLE_WRITE);
  assert.ok(writeTools.length >= 7);
  for (const tool of writeTools) {
    assert.equal(tool.confirmation, AI_TOOL_CONFIRMATION.CONFIGURABLE);
  }
});

// =========================================================================
// Section 2: Owner Session Read Diagnostics & Host Inspection
// =========================================================================

test('Read Diagnostics: Owner can execute server.health, website.list and website.inspect', async () => {
  const { runtime } = createFullToolFixture();

  const health = await runtime.execute({ name: 'server.health' });
  assert.equal(health.server.id, 'server-local-1');
  assert.deepEqual(health.jobs, { queued: 0, running: 0, failed: 0 });

  const websites = await runtime.execute({ name: 'website.list' });
  assert.equal(websites.length, 1);
  assert.equal(websites[0].id, 'web-1');

  const inspected = await runtime.execute({ name: 'website.inspect', input: { websiteId: 'web-1' } });
  assert.equal(inspected.website.id, 'web-1');
  assert.equal(inspected.domains[0].domainName, 'example.com');
  assert.equal(inspected.application.id, 'app-node-1');
});

test('Read Diagnostics: Owner can inspect DNS, certificate, mail, database, backups, and query logs', async () => {
  const { runtime } = createFullToolFixture();

  const dns = await runtime.execute({ name: 'dns.inspect', input: { websiteId: 'web-1' } });
  assert.equal(dns.zones[0].zoneName, 'example.com');

  const cert = await runtime.execute({ name: 'certificate.inspect', input: { domainId: 'dom-1' } });
  assert.equal(cert.certificate.certName, 'example.com');
  assert.equal(Object.hasOwn(cert.certificate, 'privateKey'), false);

  const mail = await runtime.execute({ name: 'mail.inspect', input: { mailDomainId: 'mail-1' } });
  assert.equal(mail.mailDomain.domainName, 'example.com');

  const db = await runtime.execute({ name: 'database.inspect', input: { websiteId: 'web-1' } });
  assert.equal(db.bindings[0].databaseName, 'app_db');

  const backup = await runtime.execute({ name: 'backup.inspect', input: { websiteId: 'web-1' } });
  assert.equal(backup.backupSet.snapshots[0].id, 'snap-1');

  const logs = await runtime.execute({ name: 'logs.query', input: { websiteId: 'web-1', query: 'active', limit: 10 } });
  assert.equal(logs.source, 'journal');
  assert.equal(logs.count, 1);
  assert.equal(logs.entries[0].unit, 'yunpanel-node-fd0012401b542e29.service');
});

test('Read Diagnostics: reject ambiguous scopes and enforce boundary lookups', async () => {
  const { runtime } = createFullToolFixture();

  await assert.rejects(
    runtime.execute({ name: 'website.inspect', input: { websiteId: 'non-existent' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'website_not_found',
  );
  await assert.rejects(
    runtime.execute({ name: 'dns.inspect', input: { websiteId: 'web-1', dnsZoneId: 'zone-1' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'invalid_ai_dns_scope',
  );
  await assert.rejects(
    runtime.execute({ name: 'certificate.inspect', input: {} }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'invalid_ai_certificate_scope',
  );
  await assert.rejects(
    runtime.execute({ name: 'database.inspect', input: {} }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'invalid_ai_database_scope',
  );
});

// =========================================================================
// Section 3: Owner Session Reversible Writes via Existing Durable Job Registry
// =========================================================================

test('Reversible Writes: service.restart queues only allowlisted managed service and returns jobPublicView', async () => {
  const { runtime, enqueuedJobs } = createFullToolFixture();

  const result = await runtime.execute({ name: 'service.restart', input: { serviceId: 'nginx' } });
  assert.equal(result.status, 'queued');
  assert.equal(Object.hasOwn(result, 'payload'), false); // Raw payload is hidden
  assert.equal(enqueuedJobs.length, 1);
  assert.equal(enqueuedJobs[0].operation, OPERATIONS.SYSTEM_SERVICE_CONTROL);
  assert.deepEqual(enqueuedJobs[0].payload, { serviceId: 'nginx', action: 'restart' });

  // Disallowed service ID fails closed
  await assert.rejects(
    runtime.execute({ name: 'service.restart', input: { serviceId: 'unmanaged-service' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'unsupported_managed_service',
  );
  await assert.rejects(
    runtime.execute({ name: 'service.restart', input: { serviceId: 'yunpanel-api' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'unsupported_managed_service',
  );
});

test('Reversible Writes: website.restart queues durable job with exact release and revision payload', async () => {
  const { runtime, enqueuedJobs } = createFullToolFixture();

  const result = await runtime.execute({ name: 'website.restart', input: { websiteId: 'web-1' } });
  assert.equal(result.status, 'queued');
  assert.equal(enqueuedJobs.length, 1);
  assert.equal(enqueuedJobs[0].operation, OPERATIONS.APP_NODE_RESTART);
  assert.deepEqual(enqueuedJobs[0].payload, {
    applicationId: 'app-node-1',
    releaseId: 'rel-2',
    runtime: { nodeMajor: 24 },
    environmentRevision: 5,
  });
});

test('Reversible Writes: application.deploy queues durable deploy job and supports idempotent replay', async () => {
  const { runtime, enqueuedJobs } = createFullToolFixture();

  const result = await runtime.execute({
    name: 'application.deploy',
    input: { applicationId: 'app-node-1', gitTarget: 'refs/heads/main' },
  });
  assert.equal(result.job.status, 'queued');
  assert.equal(result.replayed, false);
  assert.equal(enqueuedJobs.length, 1);
  assert.equal(enqueuedJobs[0].operation, OPERATIONS.APP_NODE_DEPLOY);
});

test('Reversible Writes: application.rollback queues durable rollback job and marks app rolling back', async () => {
  const { runtime, enqueuedJobs } = createFullToolFixture();

  const result = await runtime.execute({
    name: 'application.rollback',
    input: { applicationId: 'app-node-1', releaseId: 'rel-1' },
  });
  assert.equal(result.job.status, 'queued');
  assert.equal(result.application.activeDeploymentId, result.job.id);
  assert.equal(enqueuedJobs.length, 1);
  assert.equal(enqueuedJobs[0].operation, OPERATIONS.APP_NODE_ROLLBACK);
});

test('Reversible Writes: dns.update queues dns.record.apply durable job', async () => {
  const { runtime, enqueuedJobs } = createFullToolFixture();

  const result = await runtime.execute({
    name: 'dns.update',
    input: { dnsZoneId: 'zone-1', change: { action: 'UPSERT', name: 'api.example.com', type: 'A', ttl: 300, content: '1.2.3.4' } },
  });
  assert.equal(result.job.status, 'queued');
  assert.equal(enqueuedJobs.length, 1);
  assert.equal(enqueuedJobs[0].operation, OPERATIONS.DNS_RECORD_APPLY);
});

test('Reversible Writes: certificate.issue and certificate.renew queue ssl durable jobs', async () => {
  const { runtime, enqueuedJobs } = createFullToolFixture();

  const issueResult = await runtime.execute({ name: 'certificate.issue', input: { domainId: 'dom-1' } });
  assert.equal(issueResult.job.status, 'queued');
  assert.equal(enqueuedJobs[0].operation, OPERATIONS.SSL_ISSUE);

  const renewResult = await runtime.execute({ name: 'certificate.renew', input: { certificateId: 'cert-1' } });
  assert.equal(renewResult.job.status, 'queued');
  assert.equal(enqueuedJobs[1].operation, OPERATIONS.SSL_RENEW);
});

test('Reversible Writes: backup.create executes backup through websiteBackupService', async () => {
  const { runtime, backupOperations } = createFullToolFixture();

  const result = await runtime.execute({ name: 'backup.create', input: { websiteId: 'web-1' } });
  assert.equal(result.result.status, 'succeeded');
  assert.equal(backupOperations.length, 1);
  assert.equal(backupOperations[0].type, 'create');
  assert.deepEqual(backupOperations[0].tags, ['ai-agent']);
});

// =========================================================================
// Section 4: Resource Locking & Concurrency Protection
// =========================================================================

test('Resource Locking: AI write operations fail-closed when a job is already queued or running on the resource', async () => {
  const runningAppJob = {
    id: 'job-active-1',
    serverId: 'server-local-1',
    resourceType: 'application',
    resourceId: 'app-node-1',
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  const { runtime: appLockedRuntime } = createFullToolFixture({ activeJob: runningAppJob });

  // website.restart blocked by active job on application
  await assert.rejects(
    appLockedRuntime.execute({ name: 'website.restart', input: { websiteId: 'web-1' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'ai_resource_job_conflict' && err.status === 409,
  );

  // application.deploy blocked by active job
  await assert.rejects(
    appLockedRuntime.execute({ name: 'application.deploy', input: { applicationId: 'app-node-1' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'ai_resource_job_conflict' && err.status === 409,
  );

  // application.rollback blocked by active job
  await assert.rejects(
    appLockedRuntime.execute({ name: 'application.rollback', input: { applicationId: 'app-node-1', releaseId: 'rel-1' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'ai_resource_job_conflict' && err.status === 409,
  );

  // System service blocked by active job on system
  const runningSystemJob = {
    id: 'job-active-sys',
    serverId: 'server-local-1',
    resourceType: 'system',
    resourceId: 'server-local-1',
    status: 'queued',
    createdAt: new Date().toISOString(),
  };
  const { runtime: sysLockedRuntime } = createFullToolFixture({ activeJob: runningSystemJob });
  await assert.rejects(
    sysLockedRuntime.execute({ name: 'service.restart', input: { serviceId: 'nginx' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'ai_resource_job_conflict' && err.status === 409,
  );

  // Backup create and restore blocked by active job on website
  const runningWebsiteJob = {
    id: 'job-active-web',
    serverId: 'server-local-1',
    resourceType: 'website',
    resourceId: 'web-1',
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  const { runtime: webLockedRuntime } = createFullToolFixture({ activeJob: runningWebsiteJob });
  await assert.rejects(
    webLockedRuntime.execute({ name: 'backup.create', input: { websiteId: 'web-1' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'ai_resource_job_conflict' && err.status === 409,
  );
  await assert.rejects(
    webLockedRuntime.execute({ name: 'backup.restore', input: { websiteId: 'web-1', snapshotId: 'snap-1' } }),
    (err) => err instanceof AiToolRuntimeError && err.code === 'ai_resource_job_conflict' && err.status === 409,
  );
});

// =========================================================================
// Section 5: Action Plan Preview, Confirmation, and Idempotency
// =========================================================================

test('Action Plan: preview creates deterministic SHA-256 digest and verifies confirmation token', () => {
  const { runtime } = createFullToolFixture();

  const plan = createAiActionPlan({
    registry: runtime,
    name: 'application.deploy',
    input: { applicationId: 'app-node-1', gitTarget: 'refs/heads/main' },
    auth: ownerAuth,
  });

  assert.equal(plan.decision, 'confirm');
  assert.match(plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.confirmation, `ai:application.deploy:${plan.previewDigest}`);

  // Exact confirmation matches
  assert.equal(verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: plan.confirmation }), true);

  // Tampered previewDigest fails with stale error
  assert.throws(
    () => verifyAiActionExecution({ plan, previewDigest: 'a'.repeat(64), confirmation: plan.confirmation }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_preview_stale',
  );

  // Missing or wrong confirmation token fails
  assert.throws(
    () => verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: 'ai:wrong:token' }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_confirmation_required',
  );
});

test('Action Plan: destructive backup.restore ALWAYS requires confirmation and cannot be bypassed', () => {
  const { runtime } = createFullToolFixture();

  // Try to bypass confirmation via permissive overrides
  const plan = createAiActionPlan({
    registry: runtime,
    name: 'backup.restore',
    input: { websiteId: 'web-1', snapshotId: 'snap-1' },
    auth: ownerAuth,
    overrides: {
      tool: { 'backup.restore': 'allow' },
      risk: { destructive: 'allow' },
    },
  });

  assert.equal(plan.decision, 'confirm');
  assert.equal(plan.reason, 'always_confirm');
  assert.match(plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.confirmation, `ai:backup.restore:${plan.previewDigest}`);
});

// =========================================================================
// Section 6: Audit Trail & Information Privacy
// =========================================================================

test('Audit Trail: MCP adapter logs accepted before write and succeeded on completion, redacting secrets', async () => {
  const { runtime } = createFullToolFixture();
  const audit = createMockAudit();
  const adapter = createAiMcpAdapter({ registry: runtime, audit });

  // 1. Safe read execution
  await adapter.callTool({
    name: 'server.health',
    arguments: {},
    auth: ownerAuth,
  });

  const readEvent = audit.events.find((e) => e.action === 'ai.tool.server.health');
  assert.ok(readEvent);
  assert.equal(readEvent.outcome, 'succeeded');
  assert.equal(readEvent.resourceType, 'ai_tool');
  assert.equal(readEvent.resourceId, 'server.health');

  // 2. Reversible write with default allow (service.restart)
  await adapter.callTool({
    name: 'service.restart',
    arguments: { serviceId: 'nginx' },
    auth: ownerAuth,
  });

  const writeEvents = audit.events.filter((e) => e.action === 'ai.tool.service.restart');
  assert.ok(writeEvents.some((e) => e.outcome === 'accepted'));
  assert.ok(writeEvents.some((e) => e.outcome === 'succeeded'));

  // Ensure no passwords, private keys, or command strings appear in audit events
  for (const event of audit.events) {
    assert.equal(Object.hasOwn(event, 'input'), false);
    assert.equal(Object.hasOwn(event, 'result'), false);
    assert.equal(Object.hasOwn(event, 'password'), false);
    assert.equal(Object.hasOwn(event, 'apiKey'), false);
  }
});

// =========================================================================
// Section 7: Security Boundaries: Zero Shell Escapes & Zero Second Transports
// =========================================================================

test('Security Boundary: non-management actors fail-closed on all write tools', async () => {
  const { runtime } = createFullToolFixture();
  const audit = createMockAudit();
  const adapter = createAiMcpAdapter({ registry: runtime, audit });

  // Customer cannot execute service.restart
  await assert.rejects(
    adapter.callTool({
      name: 'service.restart',
      arguments: { serviceId: 'nginx' },
      auth: customerTenantAuth,
    }),
    (err) => err.code === 'ai_tool_denied' && err.status === 403,
  );

  // Read-only actor cannot execute website.restart
  await assert.rejects(
    adapter.callTool({
      name: 'website.restart',
      arguments: { websiteId: 'web-1' },
      auth: readOnlyAuth,
    }),
    (err) => err.code === 'ai_tool_denied' && err.status === 403,
  );

  // Unauthenticated actor cannot execute any tool
  await assert.rejects(
    adapter.callTool({
      name: 'server.health',
      arguments: {},
      auth: null,
    }),
    (err) => err.code === 'unauthenticated' && err.status === 401,
  );
});

test('Security Boundary: injection attempts in tool inputs fail input schema validation', async () => {
  const { runtime } = createFullToolFixture();

  // Attempting command injection via websiteId
  await assert.rejects(
    runtime.execute({
      name: 'website.inspect',
      input: { websiteId: 'web-1; id; /bin/bash' },
    }),
    // Fails because websiteId is not found (and does not execute shell command)
    (err) => err.code === 'website_not_found',
  );

  // Extra unauthorized properties rejected by additionalProperties: false
  await assert.rejects(
    runtime.execute({
      name: 'service.restart',
      input: { serviceId: 'nginx', shell: '/bin/sh', exec: 'whoami' },
    }),
    (err) => err.code === 'invalid_ai_tool_input',
  );
});
