import assert from 'node:assert/strict';
import test from 'node:test';
import { certificateHttpInternals } from '../src/certificate-http.js';

const {
  renewalOutcome,
  renewalMetadata,
  verifyTlsPresentation,
  normalizeReloadService,
  checkReloadOutcome,
} = certificateHttpInternals;

const sampleFingerprint = Array(32).fill('ab').join(':');
const renewedFingerprint = Array(32).fill('cd').join(':');

test('renewalMetadata normalizes valid dates and uppercase fingerprint', () => {
  const meta = renewalMetadata({
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2026-04-01T00:00:00.000Z',
    fingerprint256: sampleFingerprint,
  });

  assert.equal(meta.validFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(meta.validTo, '2026-04-01T00:00:00.000Z');
  assert.equal(meta.fingerprint256, sampleFingerprint.toUpperCase());
});

test('renewalMetadata throws ssl_renewal_unverified error for invalid inputs', () => {
  assert.throws(
    () => renewalMetadata(null),
    (err) => err?.code === 'ssl_renewal_unverified',
  );

  assert.throws(
    () => renewalMetadata({ fingerprint256: 'not-a-fingerprint' }),
    (err) => err?.code === 'ssl_renewal_unverified',
  );

  assert.throws(
    () => renewalMetadata({
      validFrom: '2026-05-01T00:00:00.000Z',
      validTo: '2026-01-01T00:00:00.000Z',
      fingerprint256: sampleFingerprint,
    }),
    (err) => err?.code === 'ssl_renewal_unverified',
  );
});

test('renewalOutcome computes outcome correctly across renewal lifecycles', () => {
  // Idle when no job
  assert.equal(renewalOutcome(null), 'idle');
  assert.equal(renewalOutcome(undefined), 'idle');

  // Waiting when queued or running
  assert.equal(renewalOutcome({ status: 'queued' }), 'waiting');
  assert.equal(renewalOutcome({ status: 'running' }), 'waiting');

  // Cancelled when cancelled
  assert.equal(renewalOutcome({ status: 'cancelled' }), 'cancelled');

  // Failed when job failed (even without error property)
  assert.equal(renewalOutcome({ status: 'failed' }), 'failed');

  // Dry run testing
  assert.equal(
    renewalOutcome({ status: 'succeeded', result: { dryRun: true } }, null, { state: 'active' }, true),
    'tested',
  );
  assert.equal(
    renewalOutcome({ status: 'succeeded', result: { dryRun: true } }, null, { state: 'renewing' }, true),
    'syncing',
  );

  // Unchanged when fingerprint matches before
  const beforeCert = { fingerprint256: sampleFingerprint.toUpperCase() };
  const currentCert = { state: 'active', fingerprint256: sampleFingerprint.toUpperCase() };
  const sameJob = { status: 'succeeded', result: { fingerprint256: sampleFingerprint } };
  assert.equal(renewalOutcome(sameJob, beforeCert, currentCert, false), 'unchanged');

  // Renewed when fingerprint differs from before and matches current synced cert
  const renewedJob = { status: 'succeeded', result: { fingerprint256: renewedFingerprint } };
  const syncedCert = { state: 'active', fingerprint256: renewedFingerprint.toUpperCase() };
  assert.equal(renewalOutcome(renewedJob, beforeCert, syncedCert, false), 'renewed');

  // Syncing when certificate registry has not updated yet
  assert.equal(renewalOutcome(renewedJob, beforeCert, currentCert, false), 'syncing');
});

test('verifyTlsPresentation validates certificates and exposes presentation checks safely', () => {
  const domain = {
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
  };

  const validCert = {
    id: 'cert-1',
    certName: 'example.com',
    domains: ['example.com', 'www.example.com'],
    validFrom: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    validTo: new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString(),
    fingerprint256: sampleFingerprint,
    state: 'active',
  };

  const presentation = verifyTlsPresentation({ domain, certificate: validCert });
  assert.equal(presentation.verified, true);
  assert.equal(presentation.status, 'valid');
  assert.equal(presentation.code, 'tls_verified');
  assert.equal(presentation.presentationChecks.domainsMatch, true);
  assert.equal(presentation.presentationChecks.notExpired, true);
  assert.equal(presentation.presentationChecks.fingerprintValid, true);

  // Expired certificate
  const expiredCert = {
    ...validCert,
    validTo: new Date(Date.now() - 1000 * 60).toISOString(),
  };
  const expiredPres = verifyTlsPresentation({ domain, certificate: expiredCert });
  assert.equal(expiredPres.verified, false);
  assert.equal(expiredPres.status, 'expired');
  assert.equal(expiredPres.code, 'certificate_expired');
  assert.equal(expiredPres.presentationChecks.notExpired, false);

  // Domain mismatch
  const mismatchedCert = {
    ...validCert,
    domains: ['other.com'],
    certName: 'other.com',
  };
  const mismatchPres = verifyTlsPresentation({ domain, certificate: mismatchedCert });
  assert.equal(mismatchPres.verified, false);
  assert.equal(mismatchPres.status, 'domain_mismatch');
  assert.equal(mismatchPres.code, 'domain_mismatch');
  assert.equal(mismatchPres.presentationChecks.domainsMatch, false);

  // Wildcard domain match
  const wildcardCert = {
    ...validCert,
    domains: ['example.com', '*.example.com'],
  };
  const wildcardDomain = {
    primaryDomain: 'example.com',
    aliases: ['sub.example.com', 'api.example.com'],
  };
  const wildcardPres = verifyTlsPresentation({ domain: wildcardDomain, certificate: wildcardCert });
  assert.equal(wildcardPres.verified, true);
  assert.equal(wildcardPres.presentationChecks.domainsMatch, true);

  // Certificate expiring soon: valid TLS presentation with isExpiringSoon presentation check
  const expiringSoonCert = {
    ...validCert,
    validTo: new Date(Date.now() + 1000 * 60 * 60 * 24 * 5).toISOString(),
  };
  const expiringSoonPres = verifyTlsPresentation({ domain, certificate: expiringSoonCert });
  assert.equal(expiringSoonPres.verified, true);
  assert.equal(expiringSoonPres.status, 'valid');
  assert.equal(expiringSoonPres.code, 'tls_verified');
  assert.equal(expiringSoonPres.presentationChecks.isExpiringSoon, true);
  assert.equal(expiringSoonPres.presentationChecks.notExpired, true);
});

test('normalizeReloadService and checkReloadOutcome handle partial reloads and undefined errors gracefully', () => {
  // Normalization with undefined input
  const undefSvc = normalizeReloadService('test-svc', undefined);
  assert.equal(undefSvc.ok, false);
  assert.equal(undefSvc.status, 'failed');
  assert.equal(undefSvc.code, 'service_reload_unspecified');
  assert.equal(undefSvc.error?.code, 'service_reload_unspecified');

  // Normalization with ok: false and undefined error
  const failedNoErr = normalizeReloadService('mail', { ok: false });
  assert.equal(failedNoErr.ok, false);
  assert.equal(failedNoErr.code, 'service_reload_failed');
  assert.equal(failedNoErr.error?.code, 'service_reload_failed');

  // Normalization with successful service
  const successSvc = normalizeReloadService('nginx', { ok: true });
  assert.equal(successSvc.ok, true);
  assert.equal(successSvc.code, 'ok');
  assert.equal(successSvc.error, null);

  // Complete reload
  const complete = checkReloadOutcome({
    services: {
      nginx: { ok: true },
    },
  });
  assert.equal(complete.status, 'reloaded');
  assert.equal(complete.outcome, 'complete_reload');
  assert.equal(complete.partial, false);
  assert.equal(complete.code, 'reload_succeeded');
  assert.equal(complete.presentationChecks.allServicesReloaded, true);
  assert.equal(complete.presentationChecks.partialReload, false);

  // Partial reload
  const partial = checkReloadOutcome({
    services: {
      nginx: { ok: true },
      mail: { ok: false }, // undefined error.code scenario
    },
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.outcome, 'partial_reload');
  assert.equal(partial.partial, true);
  assert.equal(partial.code, 'partial_reload');
  assert.equal(partial.presentationChecks.partialReload, true);
  assert.equal(partial.presentationChecks.hasFailures, true);

  const mail = partial.services.find((s) => s.service === 'mail');
  assert.equal(mail.ok, false);
  assert.equal(mail.code, 'service_reload_failed');
  assert.equal(mail.error.code, 'service_reload_failed');

  // All failed
  const failedAll = checkReloadOutcome({
    services: [
      { service: 'nginx', ok: false, error: { code: 'nginx_failed' } },
      { service: 'mail', ok: false, error: { code: 'mail_failed' } },
    ],
  });
  assert.equal(failedAll.status, 'failed');
  assert.equal(failedAll.outcome, 'reload_failed');
  assert.equal(failedAll.partial, false);
  assert.equal(failedAll.code, 'nginx_failed');
  assert.equal(failedAll.presentationChecks.allServicesReloaded, false);
  assert.equal(failedAll.presentationChecks.partialReload, false);
  assert.equal(failedAll.presentationChecks.hasFailures, true);
});
