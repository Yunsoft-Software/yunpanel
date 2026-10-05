import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Run web job-progress-wiring test suite as baseline
import '../../web/test/job-progress-wiring.test.js';

const source = (file) => readFile(new URL(file, import.meta.url), 'utf8');

test('Backend job-progress wiring: provisioning routes enforce exact confirmation tokens and panel route guard', async () => {
  const httpCode = await source('../src/website-provisioning-http.js');

  // Verify route guards and declaration
  assert.match(httpCode, /app\.post\('\/api\/sites\/provisioning\/:operationId\/continue',\s*requirePanelRouteAccess/);
  assert.match(httpCode, /app\.post\('\/api\/sites\/provisioning\/:operationId\/steps\/:stepId\/retry',\s*requirePanelRouteAccess/);
  assert.match(httpCode, /app\.post\('\/api\/sites\/provisioning\/:operationId\/steps\/:stepId\/compensate',\s*requirePanelRouteAccess/);

  // Exact confirmation token formats matching web provisioning-client
  assert.match(httpCode, /continue-site-provisioning:\$\{id\}/);
  assert.match(httpCode, /retry-site-provisioning:\$\{id\}:\$\{provisioningStepId\}/);
  assert.match(httpCode, /compensate-site-provisioning:\$\{id\}:\$\{provisioningStepId\}/);
});

test('Backend job-progress wiring: app.js wires siteMutationLock into website provisioning routes', async () => {
  const appCode = await source('../src/app.js');

  assert.match(appCode, /mountWebsiteProvisioningRoutes\(/);
  assert.match(appCode, /siteMutationLock/);
});

test('Backend job-progress wiring: job registry exports public view and safe error classification', async () => {
  const registryCode = await source('../src/job-registry.js');

  assert.match(registryCode, /export function jobPublicView/);
  assert.match(registryCode, /export function classifyJobError/);
  assert.match(registryCode, /export function isTransientJobError/);
  assert.match(registryCode, /export function isPermanentJobError/);
  assert.match(registryCode, /TRANSIENT_JOB_ERROR_CODES/);
});

test('Backend job-progress wiring: audited job registry preserves safe metadata and links audit entries', async () => {
  const auditCode = await source('../src/audited-job-registry.js');

  assert.match(auditCode, /export function createAuditedJobRegistry/);
  assert.match(auditCode, /audit\.linkJob/);
  assert.match(auditCode, /audit\.recordJobOutcome/);
  assert.doesNotMatch(auditCode, /payload|password|secret|token/i);
});

test('Web-to-API wiring parity: web provisioning client calls exact backend endpoints and confirmations', async () => {
  const clientCode = await source('../../web/src/workspace/provisioning-client.js');

  assert.match(clientCode, /\/sites\/provisioning\/\${encodeURIComponent\(id\)}/);
  assert.match(clientCode, /\/sites\/provisioning\/\${encodeURIComponent\(id\)}\/continue/);
  assert.match(clientCode, /continue-site-provisioning:\${uuid\(operationId/);
  assert.match(clientCode, /retry-site-provisioning:\${uuid\(operationId/);
  assert.match(clientCode, /compensate-site-provisioning:\${uuid\(operationId/);
});

test('Backend job-progress wiring: provisioning routes release siteMutationLock before sending response', async () => {
  const httpCode = await source('../src/website-provisioning-http.js');

  assert.match(httpCode, /const result = await withOptionalLock\(operation\.websiteId, async \(\) => \{\s*return orchestrator\.runNext\(id, actor\);\s*\}\);/);
});
