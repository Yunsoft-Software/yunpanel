import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import dns from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, apiContext, manifest, main, ready, privateJson, RUN_DIR, ORIGIN } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';

const TARGET = '157.180.11.28';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LOCK_CODES = new Set(['site_mutation_locked', 'site_mutation_lock_race']);
const STATES = new Set(['pending', 'applying', 'succeeded', 'failed', 'blocked', 'compensating', 'compensated']);
const terminalJob = value => ['succeeded', 'failed', 'cancelled'].includes(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
const entries = [];
const proof = { sourceSha256, helperSha256: hash(fs.readFileSync(new URL('./owned-fixture.js', import.meta.url))),
  trials: [], maxTrials: 3, maximumSidePostsPerTrial: 2, causalAcceptance: 'open' };
let owner, contender, baseline;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCode = value => typeof value === 'string' && /^[a-z0-9_]{1,120}$/.test(value) ? value : null;

async function get(endpoint, actor = owner, timeout = 10000) {
  const response = await actor.api.get(endpoint, { timeout, maxRedirects: 0, headers: { Connection: 'close' } });
  const body = await response.json().catch(() => null);
  return { status: response.status(), data: body?.data, code: safeCode(body?.error?.code) };
}

// The same first-response/canonical TLS contract as native26; no redirect following or retry.
async function canonicalRequest(hostname, scheme) {
  assert.match(hostname, /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/);
  const addresses = await dns.lookup(hostname, { all: true });
  assert.ok(addresses.length && addresses.every(row => row.address === TARGET));
  return new Promise((resolve, reject) => {
    const transport = scheme === 'https' ? https : http;
    const request = transport.get({ hostname: TARGET, port: scheme === 'https' ? 443 : 80, path: '/', agent: false,
      headers: { Host: hostname, Connection: 'close' }, timeout: 15000,
      ...(scheme === 'https' ? { servername: hostname, rejectUnauthorized: true,
        checkServerIdentity: (servername, certificate) => servername === hostname
          ? checkServerIdentity(hostname, certificate) : new Error('Baseline TLS server name changed'),
      } : {}),
    }, response => {
      const tlsVerified = scheme === 'https' ? response.socket?.authorized === true : null;
      const locations = []; let bytes = 0;
      for (let i = 0; i < response.rawHeaders.length; i += 2) if (response.rawHeaders[i].toLowerCase() === 'location') locations.push(response.rawHeaders[i + 1]);
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) request.destroy(new Error('Bounded baseline response exceeded')); });
      response.on('end', () => resolve({ status: response.statusCode, locations, tlsVerified }));
      response.on('error', () => reject(new Error('Baseline response failed')));
    });
    request.on('timeout', () => request.destroy(new Error('Baseline first response timed out')));
    request.on('error', () => reject(new Error('Baseline canonical request failed')));
  });
}

async function preserveBaseline(phase, firstReply = null) {
  const first = firstReply ?? await canonicalRequest(baseline.hostname, baseline.scheme);
  proof.baselineReads ??= []; proof.baselineReads.push({ phase, ...first });
  expect(first.status, 'Protected sibling first canonical response').toBe(200);
  if (baseline.scheme === 'https') expect(first.tlsVerified).toBe(true);
  const catalog = await get('/api/panel/websites'); expect(catalog.status).toBe(200);
  expect(baseline.websiteIds.every(id => catalog.data.some(row => row.id === id))).toBe(true);
  for (const [resource, id] of baseline.identities) {
    const current = await get('/api/panel/' + resource + '/' + id); expect(current.status).toBe(200); expect(current.data.id).toBe(id);
  }
}

function snapshot(value, entry) {
  assert.equal(value?.operationId, entry.ids.provisioningId); assert.equal(value.websiteId, entry.ids.websiteId);
  assert.equal(typeof value.ready, 'boolean'); assert.ok(Array.isArray(value.steps) && value.steps.length > 0);
  const steps = value.steps.map(row => {
    assert.match(row.id, /^[a-z0-9_]{1,80}$/); assert.ok(STATES.has(row.state)); assert.equal(typeof row.required, 'boolean');
    return { id: row.id, state: row.state, required: row.required };
  });
  assert.equal(new Set(steps.map(row => row.id)).size, steps.length);
  const signature = steps.map(row => [row.id, row.required]);
  if (entry.signature) assert.deepEqual(signature, entry.signature); else entry.signature = signature;
  const required = steps.filter(row => row.required);
  assert.ok(required.length > 0); assert.equal(value.ready, required.every(row => row.state === 'succeeded'));
  return { operationId: value.operationId, websiteId: value.websiteId, ready: value.ready, status: value.status, steps };
}

async function operation(entry, phase, timeout = 10000) {
  assert.ok(entry.ids); const startedAt = Date.now();
  const reply = await get('/api/panel/sites/provisioning/' + entry.ids.provisioningId, owner, timeout);
  expect(reply.status, 'Exact known provisioning read ' + phase).toBe(200);
  const value = snapshot(reply.data, entry); entry.proof.reads.push({ phase, startedAt, finishedAt: Date.now(), ...value }); return value;
}

function bindPreview(entry, value) {
  assert.equal(value.hostname?.primaryDomain, entry.hostname); assert.match(value.operationId, UUID);
  const ids = { createOperationId: value.operationId, provisioningId: value.provisioning?.operationId,
    websiteId: value.ids?.websiteId, domainId: value.ids?.primaryDomainId, applicationId: value.ids?.applicationId };
  for (const id of Object.values(ids)) assert.match(id ?? '', UUID);
  assert.equal(value.plan?.website?.serverId, entry.serverId); assert.equal(value.plan.website.name, entry.hostname);
  assert.equal(value.plan.website.id, ids.websiteId); assert.equal(value.plan.website.applicationId, ids.applicationId);
  assert.ok(!baseline.websiteIds.includes(ids.websiteId));
  if (entry.ids) assert.deepEqual(ids, entry.ids); else entry.ids = ids;
  entry.proof.identities = ids; snapshot(value.provisioning, entry);
}

function track(entry, promise) {
  const observed = promise.catch(error => { entry.errors.push(error); entry.proof.observerFailures.push({ errorKind: error.name }); });
  entry.tasks.add(observed); observed.finally(() => entry.tasks.delete(observed)); return observed;
}

function sideContinue(entry, before) {
  const next = before.steps.find(row => row.state === 'pending');
  if (entry.uncertain || entry.sideStopped || entry.documentedUiConflictSeen || entry.proof.sidePosts.length >= 2 || !next || entry.sideSteps.has(next.id)) return;
  assert.ok(before.steps.every(row => ['pending', 'succeeded'].includes(row.state)) && !before.ready);
  entry.sideSteps.add(next.id);
  const receipt = { operationId: entry.ids.provisioningId, websiteId: entry.ids.websiteId, nextStep: next.id,
    before, startedAt: Date.now(), postCount: 1, mutationReplayed: false };
  entry.proof.sidePosts.push(receipt); entry.sideInFlight = true;
  track(entry, (async () => {
    try {
      const response = await contender.api.post('/api/panel/sites/provisioning/' + entry.ids.provisioningId + '/continue', {
        data: { confirmation: 'continue-site-provisioning:' + entry.ids.provisioningId },
        headers: { Origin: ORIGIN, 'x-csrf-token': contender.csrf, Connection: 'close' }, timeout: 60000, maxRedirects: 0,
      });
      receipt.httpStatus = response.status(); const body = await response.json(); receipt.code = safeCode(body?.error?.code);
      if (response.status() === 409) { expect(LOCK_CODES.has(receipt.code)).toBe(true); entry.sideStopped = true; }
      else {
        expect([200, 202]).toContain(response.status()); assert.equal(body.data?.operationId, entry.ids.provisioningId);
        receipt.after = snapshot(body.data.operation, entry); receipt.outcome = safeCode(body.data.outcome);
      }
    } catch (error) { entry.uncertain = true; entry.sideStopped = true; receipt.transportOrReceiptUncertain = true; throw error; }
    finally { receipt.finishedAt = Date.now(); entry.sideInFlight = false; }
  })());
}

async function createUi(entry, page, input, recordInput) {
  entry.hostname = input.primaryDomain; entry.serverId = input.serverId;
  let creationWaiter = null, primaryError = null;
  const createPattern = '**/api/panel/sites';
  const continuePattern = /\/api\/panel\/sites\/provisioning\/[a-f0-9-]{36}\/continue$/i;
  const createObserver = async route => {
    if (route.request().method() === 'POST') {
      entry.proof.uiCreateIntents += 1;
      expect(entry.proof.uiCreateIntents, 'Reject a second create before changing the owned identity ledger').toBe(1);
      const actual = route.request().postDataJSON()?.input;
      assert.equal(actual.primaryDomain, entry.hostname);
      recordInput(actual);
      entry.proof.uiCreatePosts += 1;
    }
    // A rejected guard throws before this success-only forwarding point.
    await route.continue();
  };
  const barrier = async route => {
    const request = route.request(), id = new URL(request.url()).pathname.split('/').at(-2);
    if (request.method() !== 'POST' || !entry.ids || id !== entry.ids.provisioningId) { await route.continue(); return; }
    const observation = { operationId: id, startedAt: Date.now(), releasedAt: null, unchangedPassThrough: true, reason: 'bounded-no-overlap-observed' };
    entry.proof.barriers.push(observation);
    try {
      assert.deepEqual(request.postDataJSON(), { confirmation: 'continue-site-provisioning:' + id });
      if (entry.proof.barriers.length <= 2 && !entry.uncertain && !entry.documentedUiConflictSeen) {
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !entry.uncertain) {
          const current = await operation(entry, 'ui-send-barrier', Math.max(1, Math.min(1000, deadline - Date.now())));
          if (current.steps.some(row => row.state === 'applying')) { observation.reason = 'actual-journal-applying'; break; }
          if (current.ready || current.steps.some(row => ['failed', 'blocked', 'compensating', 'compensated'].includes(row.state))) break;
          if (!entry.sideInFlight) sideContinue(entry, current);
          if (entry.sideInFlight) {
            await delay(50); if (Date.now() >= deadline) break;
            const overlap = await operation(entry, 'second-client-in-flight', Math.max(1, Math.min(1000, deadline - Date.now())));
            if (overlap.steps.some(row => row.state === 'applying') || entry.sideInFlight) {
              observation.reason = overlap.steps.some(row => row.state === 'applying') ? 'actual-journal-applying' : 'normal-second-client-request-running'; break;
            }
          }
          await delay(50);
        }
      }
    } catch (error) { entry.errors.push(error); }
    finally { observation.releasedAt = Date.now(); await route.continue(); }
  };
  const routedBarrier = route => track(entry, barrier(route));
  const onRequest = request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (pathname === '/api/panel/sites' || entry.ids && pathname === '/api/panel/sites/provisioning/' + entry.ids.provisioningId + '/continue')) {
      entry.requests.set(request, { kind: pathname === '/api/panel/sites' ? 'create' : 'continue',
        requestSequence: ++entry.eventSequence, startedAt: Date.now(), finished: false });
    }
  };
  const onFinished = request => { const row = entry.requests.get(request); if (row) { row.finished = true; row.finishedAt = Date.now(); } };
  const onFailed = request => {
    const row = entry.requests.get(request); if (!row) return;
    row.finished = true; row.finishedAt = Date.now(); row.transportUncertain = true; entry.uncertain = true;
  };
  const onResponse = response => track(entry, (async () => {
    const request = response.request(), pathname = new URL(response.url()).pathname;
    if (request.method() !== 'POST') return;
    // Capture browser event order before JSON/identity awaits; Date.now can tie.
    const responseSequence = ++entry.eventSequence, observedAt = Date.now();
    const wire = entry.requests.get(request); if (wire) wire.httpStatus = response.status();
    if (pathname === '/api/panel/sites/create-preview' && request.postDataJSON()?.input?.primaryDomain === entry.hostname) {
      expect(response.status()).toBe(200); bindPreview(entry, (await response.json()).data); return;
    }
    if (!continuePattern.test(pathname)) return;
    const identityDeadline = Date.now() + 2000;
    while (!entry.ids && Date.now() < identityDeadline) await delay(10);
    if (!entry.ids || pathname !== '/api/panel/sites/provisioning/' + entry.ids.provisioningId + '/continue') return;
    const body = await response.json();
    const row = { operationId: entry.ids.provisioningId, httpStatus: response.status(), code: safeCode(body?.error?.code), responseSequence, observedAt };
    entry.proof.uiResponses.push(row);
    if (response.status() === 409) {
      if (LOCK_CODES.has(row.code)) entry.documentedUiConflictSeen = true;
      row.atError = await operation(entry, 'actual-ui409-at-error');
      expect(LOCK_CODES.has(row.code), 'Only documented actual UI pre-execution409 is causal evidence').toBe(true);
      entry.proof.uiConflicts.push(row);
    } else { expect([200, 202]).toContain(response.status()); assert.equal(body.data?.operationId, entry.ids.provisioningId); snapshot(body.data.operation, entry); }
  })());
  await page.route(createPattern, createObserver); await page.route(continuePattern, routedBarrier);
  page.on('request', onRequest); page.on('requestfinished', onFinished); page.on('requestfailed', onFailed); page.on('response', onResponse);
  try {
    await ready(page, '/websites/new'); await page.getByLabel('Alan adı', { exact: true }).fill(input.primaryDomain);
    await page.locator('label').filter({ hasText: 'www davranışı' }).locator('select').selectOption('none');
    await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
    await expect(page.getByRole('textbox', { name: 'GitHub repository', exact: true })).toHaveCount(0);
    await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('external'); await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
    await page.getByRole('checkbox', { name: /Otomatik E-Posta|E-posta ve Webmail/ }).uncheck();
    const waiter = { startedAt: Date.now(), timeoutMs: 180000, settled: false };
    entry.proof.createWaiter = waiter;
    creationWaiter = page.waitForResponse(response => new URL(response.url()).pathname === '/api/panel/sites' && response.request().method() === 'POST', { timeout: 180000 }).then(
      response => { Object.assign(waiter, { settled: true, settledAt: Date.now(), httpStatus: response.status() }); return { response }; },
      error => { Object.assign(waiter, { settled: true, settledAt: Date.now(), errorKind: error.name }); return { error }; },
    );
    track(entry, creationWaiter);
    await main(page).getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
    const settled = await creationWaiter; if (settled.error) throw settled.error;
    const response = settled.response; expect([200, 201]).toContain(response.status()); const created = (await response.json()).data;
    assert.ok(entry.ids); assert.equal(created.operationId, entry.ids.createOperationId);
    assert.equal(created.website?.id, entry.ids.websiteId); assert.equal(created.website?.applicationId, entry.ids.applicationId);
    assert.equal(created.primaryDomain?.id, entry.ids.domainId); assert.equal(created.primaryDomain.primaryDomain, entry.hostname);
    assert.equal(created.website.serverId, entry.serverId); snapshot(created.provisioning, entry);
    entry.proof.createReceipt = { httpStatus: response.status(), ...entry.ids, hostname: entry.hostname, serverId: entry.serverId };
    const progress = main(page).getByLabel('Site kurulum durumu');
    await expect(progress).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı', { timeout: 180000 });
    const result = main(page).locator('.ws-site-create-result'); await expect(result).toContainText(entry.hostname);
    await result.getByText('Kurulum teknik ayrıntıları', { exact: true }).click();
    await expect(result).toContainText(entry.ids.createOperationId); await expect(result).toContainText(entry.ids.websiteId);
    const href = '/websites/' + entry.ids.domainId + '/overview'; await expect(result.getByRole('link', { name: 'Site genel bakışı', exact: true })).toHaveAttribute('href', href);
    const final = await operation(entry, 'backend-ready-before-cleanup'); expect(final.ready).toBe(true);
    await preserveBaseline('own-ui-ready-' + entry.key);
    entry.proof.domReady = { hostname: entry.hostname, ...entry.ids,
      overviewHref: await result.getByRole('link', { name: 'Site genel bakışı', exact: true }).getAttribute('href'),
      actualProgressText: await progress.innerText(), observedAt: Date.now() };
    const screenshot = path.join(RUN_DIR, entry.key + '-same-operation-ready.png');
    await page.screenshot({ path: screenshot, fullPage: false }); fs.chmodSync(screenshot, 0o600);
    return created;
  } catch (error) { primaryError = error; throw error; }
  finally {
    try {
      // The handled waiter keeps its original deadline even if click fails first.
      if (creationWaiter) await creationWaiter;
      const deadline = Date.now() + 120000;
      while ((entry.tasks.size || [...entry.requests.values()].some(row => !row.finished)) && Date.now() < deadline) await delay(50);
      expect(entry.tasks.size, 'Every actual side request/response/barrier must settle before cleanup').toBe(0);
      expect([...entry.requests.values()].every(row => row.finished)).toBe(true);
      entry.proof.uiRequests = [...entry.requests.values()]; entry.proof.transportUncertain = entry.uncertain;
      entry.observersSettled = true;
    } catch (error) {
      entry.proof.observerFailures.push({ errorKind: error.name });
      if (!primaryError) { primaryError = error; throw error; }
    } finally {
      try {
        page.off('request', onRequest); page.off('requestfinished', onFinished); page.off('requestfailed', onFailed); page.off('response', onResponse);
        await page.unroute(createPattern, createObserver); await page.unroute(continuePattern, routedBarrier);
      } catch (error) { entry.observersSettled = false; if (!primaryError) throw error; }
    }
  }
}

async function drainKnown(entry) {
  assert.ok(entry.ids, 'Unknown create identity is retained, never recreated or automatically deleted');
  const deadline = Date.now() + 180000; let current;
  while (Date.now() < deadline) {
    current = await operation(entry, 'get-only-before-cleanup');
    if (!current.steps.some(row => ['applying', 'compensating'].includes(row.state))
      && (current.ready || current.steps.some(row => row.required && ['failed', 'blocked', 'compensated'].includes(row.state)))) break;
    await delay(500);
  }
  assert.ok(current && !current.steps.some(row => ['applying', 'compensating'].includes(row.state))
    && (current.ready || current.steps.some(row => row.required && ['failed', 'blocked', 'compensated'].includes(row.state))),
    'Known operation must settle through GET-only reconciliation before any cleanup mutation');
  entry.proof.knownJobs = [];
  for (const [resourceType, resourceId] of [['website', entry.ids.websiteId], ['application', entry.ids.applicationId], ['domain', entry.ids.domainId]]) {
    const response = await get('/api/panel/jobs?resourceType=' + resourceType + '&resourceId=' + resourceId);
    expect(response.status).toBe(200); assert.ok(Array.isArray(response.data));
    for (const known of response.data) {
      assert.match(known.id, UUID); assert.equal(known.serverId, entry.serverId); assert.equal(known.resourceType, resourceType); assert.equal(known.resourceId, resourceId);
      let job = known; const stop = Date.now() + 180000;
      while (!terminalJob(job.status) && Date.now() < stop) { await delay(500); const reply = await get('/api/panel/jobs/' + known.id); expect(reply.status).toBe(200); job = reply.data; assert.equal(job.id, known.id); }
      expect(terminalJob(job.status)).toBe(true); entry.proof.knownJobs.push({ id: job.id, resourceType, resourceId, status: job.status });
    }
  }
  entry.drained = true;
}

async function cleanup(entry) {
  if (entry.removed) return;
  assert.equal(entry.cleanupAttempted, undefined, 'An uncertain cleanup is preserved and never automatically retried');
  entry.cleanupAttempted = true;
  await drainKnown(entry);
  assert.equal(entry.observersSettled, true, 'Uncollected browser responses cannot be followed by cleanup mutations');
  assert.equal(entry.tasks.size, 0); assert.ok([...entry.requests.values()].every(row => row.finished));
  const ledger = entry.fixture ? await entry.fixture.cleanup() : await cleanupOwnedFixture(owner, { key: entry.key });
  const firstBaseline = await canonicalRequest(baseline.hostname, baseline.scheme);
  for (const [field, resource] of [['websiteId', 'websites'], ['domainId', 'domains'], ['applicationId', 'applications']]) {
    expect(ledger[field]).toBe(entry.ids[field]); expect((await get('/api/panel/' + resource + '/' + ledger[field])).status).toBe(404);
  }
  const actual = readOnlyHostProbe({ ledger }, 'lifecycle-absence'), contract = createWebsitePathContract(ledger);
  const roots = [ledger.documentRoot, contract.runtime.applicationRoot, contract.workspace.homeDirectory, contract.static.buildRoot, contract.static.publishRoot];
  expect(actual.roots.map(row => row.path).sort()).toEqual([...new Set(roots)].sort()); expect(actual.roots.every(row => !row.exists)).toBe(true);
  expect(actual.unixUserExists).toBe(false); expect(actual.unixGroupExists).toBe(false);
  expect(actual.fpmFiles).toEqual([]); expect(actual.sockets).toEqual([]); expect(actual.mounts).toEqual([]); expect(actual.nginxFiles.every(row => !row.exists)).toBe(true);
  entry.removed = true; entry.proof.cleanup = { allThreeMetadata404: true, canonicalRootsUnixFpmSocketsNginxMountsAbsent: true };
  await preserveBaseline('normal-cleanup-' + entry.key, firstBaseline);
}

test.beforeAll(async () => {
  owner = await apiContext(); contender = await apiContext(); const run = manifest(); expect(run.target).toBe(TARGET);
  expect(owner.session.user?.role).toBe('owner'); expect(contender.session.user?.role).toBe('owner');
  expect(contender.session.user.id).toBe(owner.session.user.id);
  const deployment = await get('/api/panel/system/diagnostics/version'); expect(deployment.status).toBe(200);
  expect(deployment.data.commit).toBe(run.sourceCommit); expect(deployment.data.sourceInfo?.sourceMatchesDeployed).toBe(true);
  proof.run = { runId: run.runId, target: run.target, sourceCommit: run.sourceCommit,
    actualBuildCommit: deployment.data.commit, buildId: deployment.data.buildId, assetId: deployment.data.assetId };
  const rows = await get('/api/panel/websites'); expect(rows.status).toBe(200); const php = rows.data.find(row => row.id === run.existingPhpWebsiteId); assert.ok(php);
  baseline = { hostname: run.existingPhpDomain, scheme: 'http', websiteIds: rows.data.map(row => row.id),
    identities: [['websites', php.id], ['applications', php.applicationId], ['domains', run.existingPhpDomainId]] };
  const first = await canonicalRequest(baseline.hostname, 'http');
  if (first.status !== 200) {
    expect([301, 308]).toContain(first.status); expect(first.locations).toHaveLength(1);
    const location = first.locations[0]; assert.ok(typeof location === 'string' && location.length <= 2048 && !/[\u0000-\u0020\u007f@?#]/.test(location));
    const url = new URL(location); assert.equal(url.href, 'https://' + baseline.hostname + '/'); baseline.scheme = 'https';
  }
  proof.baselineCanonical = { hostname: baseline.hostname, scheme: baseline.scheme, preflightStatus: first.status };
  await preserveBaseline('before-owned-trials');
});
test.afterAll(async () => {
  test.setTimeout(600000); const failures = [];
  for (const entry of [...entries].reverse()) if (!entry.removed) try { await cleanup(entry); } catch (error) { failures.push({ key: entry.key, errorKind: error.name }); }
  privateJson('t894-native-ui-race.json', proof); await contender?.api.dispose(); await owner?.api.dispose();
  expect(failures, 'Uncertain or failed cleanup retains exact ledgers and remains a failure').toEqual([]);
});

test('@mutation source actual UI lock409 reconciles the same owned operation to backend and DOM ready', async ({ page }, info) => {
  test.setTimeout(1500000); let causal = false;
  try {
    for (let trial = 1; trial <= 3; trial++) {
      const key = 't894-ui-' + trial + '-' + (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex;
      const entry = { key, tasks: new Set(), requests: new Map(), errors: [], sideSteps: new Set(), uncertain: false, eventSequence: 0,
        proof: { key, trial, uiCreateIntents: 0, uiCreatePosts: 0, sidePosts: [], uiResponses: [], uiConflicts: [], barriers: [], reads: [], observerFailures: [] } };
      entries.push(entry); proof.trials.push(entry.proof);
      let trialError = null;
      try {
        entry.fixture = await createOwnedFixture(owner, { key, runtime: 'static', create: (input, _preview, recordInput) => createUi(entry, page, input, recordInput) });
        expect(entry.errors).toEqual([]);
        expect(page.auditErrors ?? []).toEqual([]);
        expect(entry.uncertain, 'Uncertain transport stops new trial/side mutations and upload; only known-ID drain and cleanup remain').toBe(false);
        const firstConflict = entry.proof.uiConflicts[0];
        if (firstConflict) expect(entry.proof.uiRequests.filter(row => row.kind === 'continue' && row.requestSequence > firstConflict.responseSequence),
          'The UI must reconcile with GETs instead of replaying continue after its documented409').toHaveLength(0);
        const physical = readOnlyHostProbe(entry.fixture, 'owned-site-files'); expect(physical.unixUserExists).toBe(true); expect(physical.uid).toBeGreaterThan(0);
        const filename = 'index.html', nonce = randomBytes(18).toString('hex');
        await entry.fixture.upload(filename, nonce); const first = await entry.fixture.http('/' + filename + '?challenge=' + nonce);
        expect(first.status, 'First actual uploaded nonce HTTP response without retry').toBe(200); expect(first.body).toBe(nonce);
        const uploaded = readOnlyHostProbe(entry.fixture, 'owned-site-files'); expect(uploaded.indexFile?.uid).toBe(physical.uid);
        entry.proof.actualSite = { firstHttpStatus: first.status, nonceSha256: hash(nonce), unixUid: physical.uid,
          uploadedFileUid: uploaded.indexFile.uid, unixUser: entry.fixture.ledger.unixUser };
        await preserveBaseline('ui-ready-' + key); expect(entry.proof.uiCreatePosts).toBe(1); expect(entry.errors).toEqual([]);
        expect(entry.uncertain, 'Uncertain transport remains a failure; no new trial or mutation replay').toBe(false);
        causal = entry.proof.uiConflicts.length > 0 && Boolean(entry.proof.domReady);
      } catch (error) { trialError = error; throw error; }
      finally {
        try { await cleanup(entry); }
        catch (error) { entry.proof.cleanupFailure = { errorKind: error.name, automaticRetry: false }; if (!trialError) throw error; }
      }
      if (causal) { proof.causalAcceptance = 'observed'; proof.causalTrial = trial; break; }
    }
    if (!causal) {
      proof.openAcceptance = { id: 'T894.actual-ui-preexecution409', trials: entries.length,
        reason: 'No documented actual UI409 observed within three normal owned trials; side-client409 or happy UI is insufficient.' };
    }
    expect(causal, 'OPEN: actual UI documented409 + same-operation at-error GET + backend/own DOM ready are required').toBe(true);
  } finally { privateJson('t894-native-ui-race.json', proof); }
});
