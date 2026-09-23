import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source wiring checks only; these are not React rendering or HTTP tests.
const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
const [drawer, table, client] = await Promise.all([
  source('JobDrawer.jsx'), source('JobsTable.jsx'), source('provisioning-client.js'),
]);
const auto = client.slice(client.indexOf('export async function autoAdvanceWebsiteProvisioning'), client.indexOf('export const provisioningClientInternals'));

test('job screens no longer present a status fraction as measured progress', () => {
  for (const view of [drawer, table]) assert.doesNotMatch(view, /lifecycle\.progress|[123] \/ 3/);
  assert.match(drawer, /\['Deneme sayısı', jobAttemptCount\(job\) \?\? 'Bildirilmedi'\]/);
  assert.match(table, /const attempts = jobAttemptCount\(job\)/);
  assert.match(table, /attempts === null \? '' : ` · \$\{attempts\} deneme`/);
});

test('source navigation, existing observation, logs, diagnostics and queued cancellation stay connected', () => {
  assert.match(drawer, /observeJob\(\{ id, request: panelRequest/);
  assert.match(drawer, /jobSupportsDeployLogs\(job\)/);
  assert.match(drawer, /safeJobResultMetadata\(job\)/);
  assert.match(drawer, /logs\/deploy\?limit=50/);
  assert.match(drawer, /job\.diagnosis/);
  assert.match(table, /jobResourceTarget\(job/);
  assert.match(table, /onCancel && job.status === 'queued'/);
  assert.match(table, /onClick=\{\(\) => observe\(job\)\}/);
});

test('automatic advancement delegates to the tested driver with the existing API and confirmation', () => {
  assert.match(client, /import \{ advanceProvisioning \} from '\.\/provisioning-advance\.js'/);
  assert.match(auto, /return advanceProvisioning\(/);
  assert.match(auto, /read: .*panelRequest\(`\/sites\/provisioning\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(auto, /advance: .*panelRequest\(`\/sites\/provisioning\/\$\{encodeURIComponent\(id\)\}\/continue`/);
  assert.match(auto, /confirmation: continueConfirmation\(id\)/);
  assert.match(auto, /signal: requestSignal/);
  assert.doesNotMatch(auto, /retryWebsiteProvisioningStep|setTimeout|catch|retriedSteps|retryExhausted/);
});

test('one captured session generation gates the entire automatic sequence', () => {
  assert.match(client, /import \{ sessionVersion, sessionTransitionPending \} from '\.\.\/session-client\.js'/);
  assert.match(auto, /const started = sessionVersion\(\)/);
  assert.match(auto, /isCurrent: \(\) => started === sessionVersion\(\) && !sessionTransitionPending\(\)/);
});

test('explicit continue, retry and compensation keep their existing scoped POST confirmations', () => {
  for (const name of ['continueWebsiteProvisioning', 'retryWebsiteProvisioningStep', 'compensateWebsiteProvisioningStep']) {
    assert.ok(client.includes(`export function ${name}(`));
  }
  for (const action of ['continue', 'retry', 'compensate']) {
    assert.ok(client.includes(`confirmation: provisioningConfirmation('${action}', id`));
  }
  assert.match(client, /\/steps\/\$\{encodeURIComponent\(step\)\}\/retry/);
  assert.match(client, /\/steps\/\$\{encodeURIComponent\(step\)\}\/compensate/);
});
