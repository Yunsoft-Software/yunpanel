import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  evaluateLifecycleState,
  LIFECYCLE_STAGES,
  LIFECYCLE_OUTCOMES,
  reconcileCompletedJob,
  jobReconciliationInternals,
} from '../src/job-reconciliation.js';
import {
  createCertificateRegistry,
  certificateDiagnosis,
} from '../src/certificate-registry.js';
import {
  verifyRenewalOutcome,
  verifyCertificateRenewalOutcome,
} from '../src/certificate-renewal-scheduler.js';
import { renderDnsZoneDesiredState } from '../src/dns-zone-desired-state.js';
import { createJobRegistry } from '../src/job-registry.js';

// --- Fixtures & Mock Helpers ---

function createMockDomainRegistry() {
  const domains = new Map();
  return {
    async getDomain(id) {
      return domains.get(id) ?? null;
    },
    async attachCertificate(domainId, certificateId, { domains: certDomains } = {}) {
      const current = domains.get(domainId) ?? { id: domainId, primaryDomain: 'example.com', aliases: [] };
      domains.set(domainId, { ...current, certificateId, domains: certDomains });
    },
    async markApplied(id, result) {
      const current = domains.get(id) ?? { id, primaryDomain: 'example.com', aliases: [] };
      domains.set(id, { ...current, applied: true, result });
    },
    async markStaged(id, result) {
      const current = domains.get(id) ?? { id, primaryDomain: 'example.com', aliases: [] };
      const updated = { ...current, staged: true, result };
      domains.set(id, updated);
      return updated;
    },
    async markFailed(id, code) {
      const current = domains.get(id) ?? { id };
      domains.set(id, { ...current, failed: true, errorCode: code });
    },
    _set(id, data) {
      domains.set(id, data);
    },
  };
}

function createMockApplicationRegistry() {
  const apps = new Map();
  return {
    async getApplication(id) {
      return apps.get(id) ?? null;
    },
    async markDeployed(id, details) {
      const current = apps.get(id) ?? { id };
      apps.set(id, { ...current, deployed: true, ...details });
    },
    async markFailed(id, deploymentId, code) {
      const current = apps.get(id) ?? { id };
      apps.set(id, { ...current, failed: true, deploymentId, code });
    },
    _set(id, data) {
      apps.set(id, data);
    },
  };
}

const VALID_FINGERPRINT = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const NEW_FINGERPRINT = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

// ============================================================================
// Acceptance Criterion 1: Desired record alone does NOT produce active/healthy
// ============================================================================

test('AC1.1 - Mailbox enabled: desired record alone does not produce active or healthy status until applied and verified', () => {
  const desiredMailbox = {
    id: randomUUID(),
    mailDomainId: randomUUID(),
    address: 'test@example.com',
    enabled: true,
    revision: 2,
  };

  // 1. Newly saved desired state (apply has not run yet: applied is null)
  const savedState = evaluateLifecycleState({
    resourceType: 'mailbox',
    desired: desiredMailbox,
    applied: null,
    verified: false,
  });

  assert.equal(savedState.stage, LIFECYCLE_STAGES.SAVED);
  assert.equal(savedState.status, 'pending_apply');
  assert.equal(savedState.pendingApply, true);
  assert.equal(savedState.pendingVerification, false);
  assert.equal(savedState.active, false, 'Desired enabled: true must NOT produce active: true without apply');
  assert.equal(savedState.healthy, false, 'Desired enabled: true must NOT produce healthy: true without apply');
  assert.equal(savedState.outcome, null);

  // 2. Applied on previous revision (stale applied revision: revision 1 < desired revision 2)
  const staleAppliedState = evaluateLifecycleState({
    resourceType: 'mailbox',
    desired: desiredMailbox,
    applied: { revision: 1, enabled: false },
    verified: false,
  });

  assert.equal(staleAppliedState.stage, LIFECYCLE_STAGES.SAVED);
  assert.equal(staleAppliedState.status, 'pending_apply');
  assert.equal(staleAppliedState.pendingApply, true);
  assert.equal(staleAppliedState.active, false);
  assert.equal(staleAppliedState.healthy, false);

  // 3. Applied to runtime, but verification is still pending
  const verifyingState = evaluateLifecycleState({
    resourceType: 'mailbox',
    desired: desiredMailbox,
    applied: { revision: 2, enabled: true },
    verified: false,
  });

  assert.equal(verifyingState.stage, LIFECYCLE_STAGES.VERIFYING);
  assert.equal(verifyingState.status, 'pending_verification');
  assert.equal(verifyingState.pendingApply, false);
  assert.equal(verifyingState.pendingVerification, true);
  assert.equal(verifyingState.active, false, 'Unverified mailbox must NOT be active');
  assert.equal(verifyingState.healthy, false, 'Unverified mailbox must NOT be healthy');

  // 4. Live verification succeeded
  const verifiedState = evaluateLifecycleState({
    resourceType: 'mailbox',
    desired: desiredMailbox,
    applied: { revision: 2, enabled: true },
    verified: true,
  });

  assert.equal(verifiedState.stage, LIFECYCLE_STAGES.OUTCOME);
  assert.equal(verifiedState.status, LIFECYCLE_OUTCOMES.SUCCEEDED);
  assert.equal(verifiedState.outcome, LIFECYCLE_OUTCOMES.SUCCEEDED);
  assert.equal(verifiedState.active, true);
  assert.equal(verifiedState.healthy, true);
});

test('AC1.2 - DNS zone: desired records alone do not produce active or healthy status without live apply and verification', () => {
  const dnsIdentity = {
    serverId: randomUUID(),
    revision: 1,
    settings: {
      publicIpv4: '198.51.100.1',
      publicIpv6: '2001:db8::1',
      ns1: { hostname: 'ns1.example.com' },
      ns2: { hostname: 'ns2.example.com' },
      soa: {
        primaryNs: 'ns1.example.com',
        rname: 'hostmaster.example.com',
        ttl: 3600,
        refresh: 10800,
        retry: 3600,
        expire: 604800,
        minimum: 3600,
      },
    },
  };

  const template = {
    version: 1,
    serverId: dnsIdentity.serverId,
    records: [
      { key: 'root-a', owner: '@', type: 'A', ttl: 3600, values: ['<server-ipv4>'] },
    ],
  };

  const desiredDns = renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template,
    dnsIdentity,
    serial: 2026100101,
  });

  // 1. Desired records rendered, but unapplied
  const unappliedDns = evaluateLifecycleState({
    resourceType: 'dns_zone',
    desired: desiredDns,
    applied: null,
    verified: false,
  });

  assert.equal(unappliedDns.stage, LIFECYCLE_STAGES.SAVED);
  assert.equal(unappliedDns.status, 'pending_apply');
  assert.equal(unappliedDns.pendingApply, true);
  assert.equal(unappliedDns.active, false);
  assert.equal(unappliedDns.healthy, false);

  // 2. Authoritative serial behind desired serial
  const staleDns = evaluateLifecycleState({
    resourceType: 'dns_zone',
    desired: desiredDns,
    applied: { serial: 2026100100 },
    verified: false,
  });

  assert.equal(staleDns.stage, LIFECYCLE_STAGES.SAVED);
  assert.equal(staleDns.pendingApply, true);
  assert.equal(staleDns.active, false);
  assert.equal(staleDns.healthy, false);

  // 3. Applied, live authority verification confirmed
  const verifiedDns = evaluateLifecycleState({
    resourceType: 'dns_zone',
    desired: desiredDns,
    applied: { serial: 2026100101 },
    verified: { satisfied: true },
  });

  assert.equal(verifiedDns.stage, LIFECYCLE_STAGES.OUTCOME);
  assert.equal(verifiedDns.outcome, LIFECYCLE_OUTCOMES.SUCCEEDED);
  assert.equal(verifiedDns.active, true);
  assert.equal(verifiedDns.healthy, true);
});

test('AC1.3 - SSL: desired certificate record alone does not produce active or healthy status without live TLS verification', () => {
  const desiredCert = {
    id: randomUUID(),
    certName: 'example.com',
    state: 'renewing',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: VALID_FINGERPRINT,
  };

  // 1. Desired renewal operation queued (state is renewing, apply not finished)
  const renewingState = evaluateLifecycleState({
    resourceType: 'certificate',
    desired: desiredCert,
    applied: null,
    verified: false,
  });

  assert.equal(renewingState.stage, LIFECYCLE_STAGES.SAVED);
  assert.equal(renewingState.pendingApply, true);
  assert.equal(renewingState.active, false);
  assert.equal(renewingState.healthy, false);

  // 2. Certificate issuance completed on disk, but live TLS verification is pending
  const certOutcome = verifyRenewalOutcome({
    certificate: {
      ...desiredCert,
      state: 'active',
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: NEW_FINGERPRINT,
    },
    before: desiredCert,
    job: {
      status: 'succeeded',
      result: {
        status: 'renewed',
        validFrom: '2026-09-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        fingerprint256: NEW_FINGERPRINT,
      },
    },
    liveTls: null, // missing live TLS presentation
  });

  assert.equal(certOutcome.outcome, 'pending_live_tls_verification');
  assert.equal(certOutcome.verified, false, 'Unverified live TLS presentation must not be verified');
});

test('AC1.4 - Application runtime & services: desired deploy/restart record alone does not produce active or healthy status without health check evidence', () => {
  const desiredApp = {
    applicationId: randomUUID(),
    targetReleaseId: 'rel-123',
  };

  // 1. Deploy job recorded, health not yet proven
  const unverifiedApp = evaluateLifecycleState({
    resourceType: 'application',
    desired: desiredApp,
    applied: { status: 'applying' },
    verified: false,
  });

  assert.equal(unverifiedApp.stage, LIFECYCLE_STAGES.APPLYING);
  assert.equal(unverifiedApp.active, false);
  assert.equal(unverifiedApp.healthy, false);

  // 2. Deployed but health check failed (healthy: false)
  const unhealthyApp = evaluateLifecycleState({
    resourceType: 'application',
    desired: desiredApp,
    applied: { releaseId: 'rel-123', healthy: false },
    verified: false,
  });

  assert.equal(unhealthyApp.stage, LIFECYCLE_STAGES.OUTCOME);
  assert.equal(unhealthyApp.status, LIFECYCLE_OUTCOMES.FAILED);
  assert.equal(unhealthyApp.active, false);
  assert.equal(unhealthyApp.healthy, false);

  // 3. Deployed and verified healthy (healthy: true)
  const healthyApp = evaluateLifecycleState({
    resourceType: 'application',
    desired: desiredApp,
    applied: { releaseId: 'rel-123', healthy: true },
    verified: true,
  });

  assert.equal(healthyApp.stage, LIFECYCLE_STAGES.OUTCOME);
  assert.equal(healthyApp.outcome, LIFECYCLE_OUTCOMES.SUCCEEDED);
  assert.equal(healthyApp.active, true);
  assert.equal(healthyApp.healthy, true);
});

// ============================================================================
// Acceptance Criterion 2: Unified Lifecycle Model
// ============================================================================

test('AC2.1 - Unified lifecycle model: transitions across save -> apply -> live verification -> outcome', () => {
  const desired = { id: 'svc-nginx', action: 'restart' };

  // Phase 1: Save (recorded desired)
  const step1 = evaluateLifecycleState({
    resourceType: 'service',
    desired,
    applied: null,
    verified: null,
  });
  assert.equal(step1.stage, LIFECYCLE_STAGES.SAVED);
  assert.equal(step1.pendingApply, true);
  assert.equal(step1.pendingVerification, false);
  assert.equal(step1.active, false);
  assert.equal(step1.healthy, false);
  assert.equal(step1.outcome, null);

  // Phase 2: Apply (executing)
  const step2 = evaluateLifecycleState({
    resourceType: 'service',
    desired,
    applied: { status: 'applying' },
    verified: null,
  });
  assert.equal(step2.stage, LIFECYCLE_STAGES.APPLYING);
  assert.equal(step2.pendingApply, false);
  assert.equal(step2.active, false);
  assert.equal(step2.healthy, false);
  assert.equal(step2.outcome, null);

  // Phase 3: Live Verification (inspecting live systemd status)
  const step3 = evaluateLifecycleState({
    resourceType: 'service',
    desired,
    applied: { status: 'applied' },
    verified: 'verifying',
  });
  assert.equal(step3.stage, LIFECYCLE_STAGES.VERIFYING);
  assert.equal(step3.pendingVerification, true);
  assert.equal(step3.active, false);
  assert.equal(step3.healthy, false);
  assert.equal(step3.outcome, null);

  // Phase 4: Outcome (succeeded)
  const step4 = evaluateLifecycleState({
    resourceType: 'service',
    desired,
    applied: { status: 'applied', active: true },
    verified: true,
  });
  assert.equal(step4.stage, LIFECYCLE_STAGES.OUTCOME);
  assert.equal(step4.status, LIFECYCLE_OUTCOMES.SUCCEEDED);
  assert.equal(step4.outcome, LIFECYCLE_OUTCOMES.SUCCEEDED);
  assert.equal(step4.active, true);
  assert.equal(step4.healthy, true);
});

test('AC2.2 - Unified lifecycle model: distinguishes success, partial, and failure outcomes consistently', () => {
  const desired = { id: 'test-resource' };

  // Outcome: Succeeded
  const success = evaluateLifecycleState({
    resourceType: 'generic',
    desired,
    applied: { status: 'applied' },
    verified: true,
  });
  assert.equal(success.outcome, LIFECYCLE_OUTCOMES.SUCCEEDED);
  assert.equal(success.healthy, true);
  assert.equal(success.partial, false);

  // Outcome: Partial (e.g. side effects or reload completed partially)
  const partial = evaluateLifecycleState({
    resourceType: 'generic',
    desired,
    applied: { status: 'applied' },
    verified: true,
    sideEffects: {
      status: 'partial',
      service: 'mail_identity',
      error: 'Connection timeout to mail service identity daemon',
    },
  });
  assert.equal(partial.outcome, LIFECYCLE_OUTCOMES.PARTIAL);
  assert.equal(partial.status, LIFECYCLE_OUTCOMES.PARTIAL);
  assert.equal(partial.partial, true);
  assert.equal(partial.healthy, false);
  assert.equal(partial.error, 'Connection timeout to mail service identity daemon');

  // Outcome: Failed
  const failed = evaluateLifecycleState({
    resourceType: 'generic',
    desired,
    error: new Error('Critical host runtime failure'),
  });
  assert.equal(failed.outcome, LIFECYCLE_OUTCOMES.FAILED);
  assert.equal(failed.status, LIFECYCLE_OUTCOMES.FAILED);
  assert.equal(failed.healthy, false);
  assert.equal(failed.error, 'Critical host runtime failure');
});

// ============================================================================
// Acceptance Criterion 3: Post-SSL Mail Identity Errors Not Swallowed
// ============================================================================

test('AC3.1 - SSL renewal: post-SSL mail identity assignment error is surfaced as visible partial result and not swallowed', async () => {
  const certId = randomUUID();
  const serverId = randomUUID();
  const domainId = randomUUID();

  const certRegistry = createCertificateRegistry();
  const domainRegistry = createMockDomainRegistry();
  const appRegistry = createMockApplicationRegistry();

  domainRegistry._set(domainId, {
    id: domainId,
    serverId,
    primaryDomain: 'mail.example.com',
    aliases: [],
  });

  // Pre-seed certificate in registry
  const createdCert = await certRegistry.createForDomain({
    domainId,
    serverId,
    domains: ['mail.example.com'],
    email: 'admin@example.com',
    staging: false,
    purpose: 'web',
  });

  // Mock mail service identity registry that fails on post-SSL bind
  let bindCalled = false;
  const mockMailServiceIdentityRegistry = {
    async getForServer(sId) {
      if (sId !== serverId) return null;
      return {
        serverId,
        webDomainId: domainId,
        hostname: 'mail.example.com',
        revision: 1,
      };
    },
    async bind() {
      bindCalled = true;
      const err = new Error('Dovecot/Postfix TLS identity re-binding failed: EACCES /etc/dovecot/tls.conf');
      err.code = 'mail_identity_bind_failed';
      throw err;
    },
  };

  const renewJob = {
    id: randomUUID(),
    serverId,
    operation: OPERATIONS.SSL_RENEW,
    resourceType: 'certificate',
    resourceId: createdCert.id,
    status: 'succeeded',
    payload: { certName: 'mail.example.com', dryRun: false },
    result: {
      status: 'renewed',
      certName: 'mail.example.com',
      domains: ['mail.example.com'],
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: NEW_FINGERPRINT,
      certificatePath: `/etc/letsencrypt/live/mail.example.com/cert.pem`,
      fullchainPath: `/etc/letsencrypt/live/mail.example.com/fullchain.pem`,
      privateKeyPath: `/etc/letsencrypt/live/mail.example.com/privkey.pem`,
    },
  };

  // Reconcile completed job with failing mailServiceIdentityRegistry
  const reconciliation = await reconcileCompletedJob({
    domainRegistry,
    certificateRegistry: certRegistry,
    applicationRegistry: appRegistry,
    mailServiceIdentityRegistry: mockMailServiceIdentityRegistry,
    job: renewJob,
  });

  // 1. Verify mail identity assignment was attempted
  assert.equal(bindCalled, true, 'Post-SSL mail identity assignment must be attempted');

  // 2. Verify error was NOT swallowed and NOT reported as complete success
  assert.equal(reconciliation.reconciled, true);
  assert.equal(reconciliation.outcome, 'partial', 'Outcome must be partial rather than fake full success');
  assert.equal(reconciliation.partial, true);
  assert.notEqual(reconciliation.outcome, 'succeeded', 'Must not claim full success when side effect failed');
  assert.equal(reconciliation.sideEffects.mailIdentity.service, 'mail_identity');
  assert.equal(reconciliation.sideEffects.mailIdentity.status, 'partial');
  assert.match(reconciliation.sideEffects.mailIdentity.error, /Dovecot\/Postfix TLS identity/);

  // 3. Verify partial reload outcome was recorded on certificate record
  const updatedCert = await certRegistry.getCertificate(createdCert.id);
  assert.ok(updatedCert.lastReloadOutcome, 'Certificate must record lastReloadOutcome');
  assert.equal(updatedCert.lastReloadOutcome.service, 'mail_identity');
  assert.equal(updatedCert.lastReloadOutcome.status, 'partial');
  assert.equal(updatedCert.lastReloadOutcome.stage, 'identity_assignment');
});

test('AC3.2 - verifyRenewalOutcome surfaces partial mail identity assignment failure as partial outcome rather than full success', () => {
  const cert = {
    id: randomUUID(),
    certName: 'mail.example.com',
    state: 'active',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: NEW_FINGERPRINT,
    lastReloadOutcome: {
      service: 'mail_identity',
      status: 'partial',
      stage: 'identity_assignment',
      error: 'Mail identity assignment failed',
      recordedAt: new Date().toISOString(),
    },
  };

  const outcome = verifyRenewalOutcome({
    certificate: cert,
    job: {
      status: 'succeeded',
      result: {
        status: 'renewed',
        validFrom: '2026-09-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        fingerprint256: NEW_FINGERPRINT,
      },
    },
    liveTls: {
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: NEW_FINGERPRINT,
    },
  });

  assert.equal(outcome.outcome, 'partial', 'Must be partial outcome');
  assert.equal(outcome.partial, true);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.reason, 'post_ssl_mail_identity_assignment_failed');
  assert.equal(outcome.service, 'mail_identity');
  assert.notEqual(outcome.outcome, 'renewed_and_live_verified', 'Must NOT produce fake full success');
});

test('AC3.3 - certificateDiagnosis provides actionable warning for partial mail identity assignment failure', () => {
  const certWithPartialMail = {
    state: 'active',
    validTo: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    lastReloadOutcome: {
      service: 'mail_identity',
      status: 'partial',
      stage: 'identity_assignment',
      error: 'Mail identity assignment failed',
    },
  };

  const diagnosis = certificateDiagnosis(certWithPartialMail);
  assert.ok(diagnosis);
  assert.equal(diagnosis.severity, 'warning');
  assert.equal(diagnosis.code, 'certificate_reload_partial');
  assert.match(diagnosis.message, /mail service identity assignment/i);
  assert.match(diagnosis.action, /Inspect mail service identity bindings/i);
});

test('AC3.4 - Initial SSL issuance also captures post-SSL mail identity assignment failure as visible partial result', async () => {
  const serverId = randomUUID();
  const domainId = randomUUID();

  const certRegistry = createCertificateRegistry();
  const domainRegistry = createMockDomainRegistry();
  const appRegistry = createMockApplicationRegistry();

  domainRegistry._set(domainId, {
    id: domainId,
    serverId,
    primaryDomain: 'mail.yunpanel.com',
    aliases: [],
  });

  const createdCert = await certRegistry.createForDomain({
    domainId,
    serverId,
    domains: ['mail.yunpanel.com'],
    email: 'admin@yunpanel.com',
    staging: false,
    purpose: 'web',
  });

  const mockMailIdentityRegistry = {
    async getForServer() {
      return {
        serverId,
        webDomainId: domainId,
        hostname: 'mail.yunpanel.com',
        revision: 1,
      };
    },
    async bind() {
      throw new Error('Dovecot reload timeout after SSL issue');
    },
  };

  const issueJob = {
    id: randomUUID(),
    serverId,
    operation: OPERATIONS.SSL_ISSUE,
    resourceType: 'certificate',
    resourceId: createdCert.id,
    status: 'succeeded',
    payload: { domains: ['mail.yunpanel.com'], staging: false },
    result: {
      status: 'issued',
      certName: 'mail.yunpanel.com',
      domains: ['mail.yunpanel.com'],
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: NEW_FINGERPRINT,
      certificatePath: `/etc/letsencrypt/live/mail.yunpanel.com/cert.pem`,
      fullchainPath: `/etc/letsencrypt/live/mail.yunpanel.com/fullchain.pem`,
      privateKeyPath: `/etc/letsencrypt/live/mail.yunpanel.com/privkey.pem`,
    },
  };

  const res = await reconcileCompletedJob({
    domainRegistry,
    certificateRegistry: certRegistry,
    applicationRegistry: appRegistry,
    mailServiceIdentityRegistry: mockMailIdentityRegistry,
    job: issueJob,
  });

  assert.equal(res.reconciled, true);
  assert.equal(res.outcome, 'partial');
  assert.equal(res.partial, true);
  assert.ok(res.sideEffects.mailIdentity);
  assert.match(res.sideEffects.mailIdentity.error, /Dovecot reload timeout/);
});

// ============================================================================
// Acceptance Criterion 4: Pending apply and verification states clearly surfaced
// ============================================================================

test('AC4.1 - Pending apply and pending verification states are explicitly surfaced across components without user guesswork', () => {
  // Case A: Mailbox with pending apply
  const mailboxState = evaluateLifecycleState({
    resourceType: 'mailbox',
    desired: { address: 'user@example.com', enabled: true, revision: 3 },
    applied: { revision: 2, enabled: false }, // stale applied revision
    verified: false,
  });
  assert.equal(mailboxState.pendingApply, true);
  assert.equal(mailboxState.pendingVerification, false);
  assert.equal(mailboxState.stage, LIFECYCLE_STAGES.SAVED);

  // Case B: Mailbox with pending verification
  const mailboxVerifying = evaluateLifecycleState({
    resourceType: 'mailbox',
    desired: { address: 'user@example.com', enabled: true, revision: 3 },
    applied: { revision: 3, enabled: true }, // applied, but not yet verified
    verified: false,
  });
  assert.equal(mailboxVerifying.pendingApply, false);
  assert.equal(mailboxVerifying.pendingVerification, true);
  assert.equal(mailboxVerifying.stage, LIFECYCLE_STAGES.VERIFYING);

  // Case C: DNS zone with pending apply
  const dnsState = evaluateLifecycleState({
    resourceType: 'dns_zone',
    desired: { serial: 2026100102 },
    applied: { serial: 2026100101 },
    verified: false,
  });
  assert.equal(dnsState.pendingApply, true);
  assert.equal(dnsState.pendingVerification, false);
  assert.equal(dnsState.stage, LIFECYCLE_STAGES.SAVED);

  // Case D: Certificate renewal with pending live TLS verification
  const certVerifying = verifyRenewalOutcome({
    certificate: {
      certName: 'example.com',
      state: 'active',
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: NEW_FINGERPRINT,
    },
    job: {
      status: 'succeeded',
      result: {
        status: 'renewed',
        validFrom: '2026-09-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        fingerprint256: NEW_FINGERPRINT,
      },
    },
    liveTls: null, // live presentation not inspected yet
  });
  assert.equal(certVerifying.outcome, 'pending_live_tls_verification');
  assert.equal(certVerifying.verified, false);
  assert.equal(certVerifying.reason, 'live_tls_presentation_missing');
});

test('AC4.2 - DNS desired state requires applied mail when requireApplied is set', () => {
  const dnsIdentity = {
    serverId: randomUUID(),
    revision: 1,
    settings: {
      publicIpv4: '198.51.100.1',
      publicIpv6: '2001:db8::1',
      ns1: { hostname: 'ns1.example.com' },
      ns2: { hostname: 'ns2.example.com' },
      soa: {
        primaryNs: 'ns1.example.com',
        rname: 'hostmaster.example.com',
        ttl: 3600,
        refresh: 10800,
        retry: 3600,
        expire: 604800,
        minimum: 3600,
      },
    },
  };

  const template = {
    version: 1,
    serverId: dnsIdentity.serverId,
    records: [
      { key: 'root-a', owner: '@', type: 'A', ttl: 3600, values: ['<server-ipv4>'] },
    ],
  };

  // When mail.requireApplied is true and applied is false: mail records are omitted from desired state
  const dnsWithUnappliedMail = renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template,
    dnsIdentity,
    serial: 100,
    mail: {
      enabled: true,
      requireApplied: true,
      applied: false, // mail desired but not applied
      host: 'mail.example.com',
    },
  });

  const mailRecords = dnsWithUnappliedMail.records.filter((r) => r.source === 'mail');
  assert.equal(mailRecords.length, 0, 'Unapplied mail must not emit active mail DNS records when requireApplied is true');

  // When mail.applied is true: mail records are included
  const dnsWithAppliedMail = renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template,
    dnsIdentity,
    serial: 100,
    mail: {
      enabled: true,
      requireApplied: true,
      applied: true,
      host: 'mail.example.com',
    },
  });

  const activeMailRecords = dnsWithAppliedMail.records.filter((r) => r.source === 'mail');
  assert.ok(activeMailRecords.length > 0, 'Applied mail must emit active mail DNS records');
});
