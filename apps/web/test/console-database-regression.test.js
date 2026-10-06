import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { waitForJob } from '../src/api.js';

const { queueAndWait } = await import('../src/workspace/DatabasesPage.jsx');
const source = await readFile(new URL('../src/workspace/DatabasesPage.jsx', import.meta.url), 'utf8');
const panelKitSource = await readFile(new URL('../src/workspace/PanelKit.jsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('database console retains search, pagination and explicit access alternatives', () => {
  assert.match(source, /useSearchParams/);
  assert.match(source, /filterConsoleDatabases/);
  assert.match(source, /paginateConsoleItems/);
  assert.match(source, /view\.canOpen/);
  assert.match(source, /view\.siteHref/);
  assert.match(source, /Erişimi yapılandır/);
  assert.match(source, /Siteye bağla/);
});

test('database create form is opt-in; technical security facts remain available', () => {
  assert.match(source, /createOpen && <Modal/);
  assert.match(source, /<details className="ws-section ws-disclosure ws-database-diagnostics"/);
  for (const label of ['Engine', 'DB güvenlik baseline', 'Admin socket auth', 'Website bağı', 'Credential', 'Eksik schema bağı']) assert.ok(source.includes(label));
});

test('database deletion modal preserves state on failure/cancellation and closes on success', () => {
  assert.match(source, /const terminal = await perform\(\(\) => deleteDatabase\(server\.id, target\.name\)\);/);
  assert.match(source, /if \(terminal\) setDeleteTarget\(null\);/);
  assert.match(source, /<ConfirmDialog[\s\S]*?disabled=\{!canAct\}/);
  assert.match(panelKitSource, /export function ConfirmDialog\(\{[\s\S]*?disabled = false/);
  assert.match(panelKitSource, /disabled=\{busy \|\| disabled \|\|/);
});

test('stale, refreshing or error states lock database mutations and phpMyAdmin handoff', () => {
  assert.match(source, /servers\.status === 'ready' && status === 'ready' && !busy && !loadError/);
  assert.match(source, /Button variant="primary" icon="plus" disabled=\{!canAct\}/);
  assert.match(source, /Button icon="external" disabled=\{!canAct\} onClick=\{.*?openPhpMyAdmin/);
  assert.match(source, /Button icon="trash" disabled=\{!canAct\}/);
  assert.match(source, /type="submit" disabled=\{!canAct \|\| !validDatabaseName\(name\)\}/);
  assert.match(source, /disabled=\{!canAct\} error=\{error\}/);
});

test('search, access filter, pagination and browser URL history navigation are wired', () => {
  assert.match(source, /const \[params, setParams\] = useSearchParams\(\);/);
  assert.match(source, /const query = params\.get\('q'\) \?\? '';/);
  assert.match(source, /const access = \['ready', 'attention'\]\.includes\(params\.get\('access'\)\) \? params\.get\('access'\) : 'all';/);
  assert.match(source, /filter\('q', event\.target\.value\)/);
  assert.match(source, /filter\('access', event\.target\.value\)/);
  assert.match(source, /filter\('page', String\(page\.page - 1\)\)/);
  assert.match(source, /filter\('page', String\(page\.page \+ 1\)\)/);
  assert.match(source, /replace: key === 'q'/);
  assert.match(source, /\['q', 'access', 'page'\]\.forEach\(\(key\) => next\.delete\(key\)\)/);
});

test('api waitForJob retains terminal job object on failed and cancelled states at runtime', async (t) => {
  assert.match(apiSource, /error\.job = job;/);

  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('job-succeeded')) {
      return ok({ id: 'job-succeeded', status: 'succeeded', result: { ok: true } });
    }
    if (url.includes('job-failed')) {
      return ok({ id: 'job-failed', status: 'failed', error: { message: 'Database creation rejected' } });
    }
    if (url.includes('job-cancelled')) {
      return ok({ id: 'job-cancelled', status: 'cancelled' });
    }
    return ok({ id: 'job-unknown', status: 'running' });
  });

  const succeeded = await waitForJob('job-succeeded');
  assert.equal(succeeded.status, 'succeeded');

  await assert.rejects(async () => {
    await waitForJob('job-failed');
  }, (err) => {
    assert.equal(err.code, 'failed');
    assert.equal(err.job?.status, 'failed');
    assert.equal(err.job?.error?.message, 'Database creation rejected');
    return true;
  });

  await assert.rejects(async () => {
    await waitForJob('job-cancelled');
  }, (err) => {
    assert.equal(err.code, 'cancelled');
    assert.equal(err.job?.status, 'cancelled');
    return true;
  });
});

test('queueAndWait rethrows on failed and cancelled jobs, updating job and preserving failure contract', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('job-fail')) {
      return ok({ id: 'job-fail', status: 'failed', error: { message: 'DB creation error' } });
    }
    if (url.includes('job-cancel')) {
      return ok({ id: 'job-cancel', status: 'cancelled' });
    }
    if (url.includes('job-ok')) {
      return ok({ id: 'job-ok', status: 'succeeded' });
    }
    return ok({});
  });

  const observed = [];
  const updated = [];
  let refreshed = 0;
  const context = {
    observe: (j) => observed.push(j),
    updateJob: (j) => updated.push(j),
    refreshJobs: () => { refreshed += 1; },
  };

  // 1. Succeeded job: returns terminal
  const successResult = await queueAndWait(async () => ({ id: 'job-ok' }), context);
  assert.equal(successResult.status, 'succeeded');
  assert.equal(updated.at(-1)?.status, 'succeeded');

  // 2. Failed job: must rethrow and NOT return terminal object
  await assert.rejects(async () => {
    await queueAndWait(async () => ({ id: 'job-fail' }), context);
  }, (err) => {
    assert.equal(err.code, 'failed');
    assert.equal(err.job?.status, 'failed');
    return true;
  });
  assert.equal(updated.at(-1)?.status, 'failed');
  assert.ok(refreshed >= 2);

  // 3. Cancelled job: must rethrow and NOT return terminal object
  await assert.rejects(async () => {
    await queueAndWait(async () => ({ id: 'job-cancel' }), context);
  }, (err) => {
    assert.equal(err.code, 'cancelled');
    assert.equal(err.job?.status, 'cancelled');
    return true;
  });
  assert.equal(updated.at(-1)?.status, 'cancelled');
});

test('perform contract preserves modal and form inputs on failed or cancelled operations', async () => {
  function createHarness() {
    let name = 'test_database';
    let createOpen = true;
    let createdName = '';
    let deleteTarget = { name: 'test_database' };
    let error = null;

    async function performOperation(fn) {
      try {
        const terminal = await fn();
        return terminal;
      } catch (failure) {
        const isCancelled = failure.code === 'cancelled' || failure.message?.includes('cancelled') || failure.job?.status === 'cancelled';
        const isFailed = failure.code === 'failed' || failure.message?.includes('failed') || failure.job?.status === 'failed';
        if (isCancelled || isFailed) {
          error = isCancelled ? 'İşlem iptal edildi. Formunuz korunuyor.' : 'İşlem başarısız oldu. İşlem merkezinden ayrıntıları inceleyin.';
        } else {
          error = failure.message;
        }
        return null;
      }
    }

    async function handleCreate(queueFn) {
      const terminal = await performOperation(queueFn);
      if (terminal) {
        name = '';
        createOpen = false;
        createdName = 'test_database';
      }
    }

    async function handleRemove(queueFn) {
      const terminal = await performOperation(queueFn);
      if (terminal) {
        deleteTarget = null;
      }
    }

    return {
      getState: () => ({ name, createOpen, createdName, deleteTarget, error }),
      handleCreate,
      handleRemove,
    };
  }

  // Failure scenario: modal & input preserved
  const harness1 = createHarness();
  const failedError = new Error('Job failed');
  failedError.code = 'failed';
  failedError.job = { id: 'job-1', status: 'failed' };
  await harness1.handleCreate(async () => { throw failedError; });
  const s1 = harness1.getState();
  assert.equal(s1.name, 'test_database', 'Entered database name must be preserved');
  assert.equal(s1.createOpen, true, 'Create modal must remain open');
  assert.equal(s1.createdName, '', 'Created name notice must not appear');
  assert.equal(s1.error, 'İşlem başarısız oldu. İşlem merkezinden ayrıntıları inceleyin.');

  // Cancellation scenario: delete modal preserved
  const harness2 = createHarness();
  const cancelledError = new Error('Job cancelled');
  cancelledError.code = 'cancelled';
  cancelledError.job = { id: 'job-2', status: 'cancelled' };
  await harness2.handleRemove(async () => { throw cancelledError; });
  const s2 = harness2.getState();
  assert.deepEqual(s2.deleteTarget, { name: 'test_database' }, 'Delete target must remain set');
  assert.equal(s2.error, 'İşlem iptal edildi. Formunuz korunuyor.');

  // Success scenario: input cleared, modal closed
  const harness3 = createHarness();
  await harness3.handleCreate(async () => ({ id: 'job-3', status: 'succeeded' }));
  const s3 = harness3.getState();
  assert.equal(s3.name, '', 'Form input must be reset on success');
  assert.equal(s3.createOpen, false, 'Modal must close on success');
  assert.equal(s3.createdName, 'test_database');
  assert.equal(s3.error, null);
});