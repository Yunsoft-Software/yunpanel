import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { test, expect, apiContext, manifest, privateJson, RUN_DIR } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';
import { nginxConfigFileName } from '../../packages/config-templates/src/index.js';
import { OPERATIONS } from '../../packages/protocol/src/index.js';

export const openAcceptances = [{
  id: 'T899.native-ack-window',
  assertions: ['Native request timing is not presented as proof of the internal completion/reconciliation acknowledgment barrier'],
  reason: 'Normal concurrent API jobs do not expose that internal barrier. The separate real HTTP/disk regression test exercises its deterministic window.',
  requiredChannel: 'The existing deterministic real HTTP reconciliation regression, considered separately from this native test',
}];

const TARGET = '157.180.11.28';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status);
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
const helperSha256 = hash(fs.readFileSync(new URL('./owned-fixture.js', import.meta.url)));
const entries = [], sent = new Set(), seenJobIds = new Set();
const proof = { sourceSha256, helperSha256, waves: [], cleanups: [], internalAckWindowProved: false };
let actor, baseline;

function accepted(reply, label, status = 200) {
  const code = /^[a-z0-9_]+$/.test(reply.body?.error?.code ?? '') ? reply.body.error.code : null;
  expect(reply.status, label + ' ' + (code ?? '')).toBe(status); return reply.data;
}

async function inventory() {
  const response = await actor.api.get('/api/panel/websites', { headers: { Connection: 'close' } });
  expect(response.status()).toBe(200); const rows = (await response.json()).data;
  expect(Array.isArray(rows)).toBe(true); return rows;
}

async function baselineRequest({ hostname, scheme }) {
  assert.match(hostname, /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/);
  assert.ok(['http', 'https'].includes(scheme));
  const addresses = await dns.lookup(hostname, { all: true });
  assert.ok(addresses.length && addresses.every(row => row.address === TARGET));
  return new Promise((resolve, reject) => {
    const transport = scheme === 'https' ? https : http;
    const req = transport.get({ hostname: TARGET, port: scheme === 'https' ? 443 : 80, path: '/', agent: false,
      headers: { Host: hostname, Connection: 'close' }, timeout: 15000,
      ...(scheme === 'https' ? { servername: hostname, rejectUnauthorized: true,
        checkServerIdentity: (servername, certificate) => servername === hostname
          ? checkServerIdentity(hostname, certificate) : new Error('Baseline sibling TLS server name changed'),
      } : {}),
    }, response => {
      const tlsVerified = scheme === 'https' ? response.socket?.authorized === true : null;
      if (scheme === 'https' && tlsVerified !== true) { req.destroy(new Error('Baseline sibling TLS peer was not authenticated')); return; }
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(new Error('Baseline sibling response exceeds the bounded read')); });
      const locations = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index].toLowerCase() === 'location') locations.push(response.rawHeaders[index + 1]);
      }
      response.on('end', () => resolve({ status: response.statusCode, locations, tlsVerified }));
      response.on('error', () => reject(new Error('Baseline sibling bounded response failed')));
    });
    req.on('timeout', () => req.destroy(new Error('Baseline sibling first canonical response timed out')));
    req.on('error', error => {
      const code = /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'REQUEST_FAILED';
      reject(new Error('Baseline sibling canonical request failed: ' + code));
    });
  });
}

async function baselineEndpoint(hostname) {
  const preflight = await baselineRequest({ hostname, scheme: 'http' });
  let scheme = 'http', validatedLocation = null;
  if (preflight.status !== 200) {
    assert.ok([301, 308].includes(preflight.status), 'Baseline preflight must be HTTP200 or a permanent canonical HTTPS redirect');
    assert.equal(preflight.locations.length, 1, 'Baseline canonical redirect must have exactly one Location');
    const location = preflight.locations[0];
    assert.ok(typeof location === 'string' && location.length <= 2048 && !/[\u0000-\u0020\u007f@?#]/.test(location),
      'Baseline redirect must contain no credentials, query, fragment or whitespace');
    let canonical; try { canonical = new URL(location); } catch { throw new Error('Baseline canonical redirect must be an absolute HTTPS URL'); }
    assert.ok(canonical.protocol === 'https:' && canonical.hostname === hostname && canonical.port === ''
      && canonical.username === '' && canonical.password === '' && canonical.pathname === '/'
      && canonical.search === '' && canonical.hash === '' && canonical.origin === 'https://' + hostname,
    'Baseline canonical redirect must stay on the exact hostname, HTTPS443 and root path');
    scheme = 'https'; validatedLocation = location;
  }
  proof.baselinePreflight = { status: preflight.status, requestScheme: 'http', requestPort: 80,
    redirectVerified: scheme === 'https', redirectLocation: validatedLocation, canonicalUrl: scheme + '://' + hostname + '/',
    canonicalPort: scheme === 'https' ? 443 : 80, requiredCanonicalStatus: 200 };
  privateJson('t899-original-sibling-preflight.json', proof.baselinePreflight);
  return { hostname, scheme };
}

const baselineHttp = () => baselineRequest(baseline.endpoint);

async function preserveBaseline(phase, firstReply = null) {
  const first = firstReply ?? await baselineHttp();
  proof.baselineReads ??= []; proof.baselineReads.push({ phase, scheme: baseline.endpoint.scheme, firstHttpStatus: first.status, tlsVerified: first.tlsVerified });
  if (baseline.endpoint.scheme === 'https') expect(first.tlsVerified, 'Canonical sibling TLS chain and hostname must remain verified').toBe(true);
  expect(first.status, 'Original healthy PHP sibling first response after ' + phase).toBe(200);
  const rows = await inventory();
  expect(baseline.websiteIds.every(id => rows.some(row => row.id === id)), 'All original Website identities must survive').toBe(true);
  for (const [resource, id] of [['websites', baseline.phpWebsiteId], ['domains', baseline.phpDomainId], ['applications', baseline.phpApplicationId]]) {
    const reply = await actor.api.get('/api/panel/' + resource + '/' + id); expect(reply.status()).toBe(200);
    expect((await reply.json()).data.id).toBe(id);
  }
}

async function domain(entry) {
  const value = accepted(await entry.fixture.call('GET', '/api/panel/domains/' + entry.fixture.ledger.domainId), 'Read exact owned Domain');
  expect(value.id).toBe(entry.fixture.ledger.domainId); expect(value.websiteId).toBe(entry.fixture.ledger.websiteId);
  expect(value.serverId).toBe(entry.fixture.ledger.serverId); expect(value.primaryDomain).toBe(entry.fixture.ledger.hostname);
  return value;
}

function activeConfig(entry) {
  const value = readOnlyHostProbe(entry.fixture, 'nginx-config');
  expect(value.regular).toBe(true); expect(value.symlink).toBe(false); expect(value.uid).toBe(0);
  expect(value.mode & 0o022).toBe(0); expect(value.bytes).toBeGreaterThan(0); expect(value.sha256).toMatch(SHA);
  return value;
}

function assertHttp(entry, reply, phase) {
  entry.fixture.record('jobs.first-http', { phase, status: reply.status, markerSha256: hash(entry.marker) });
  expect(reply.status, 'First actual owned HTTP response without retry: ' + phase).toBe(200);
  expect(reply.body).toBe(entry.marker);
  for (const [name, value] of entry.appliedHeaders) expect(reply.headers[name.toLowerCase()]).toBe(value);
}

async function createSite(key) {
  const entry = { key, fixture: null, appliedHeaders: [], removed: false };
  entries.push(entry);
  entry.fixture = await createOwnedFixture(actor, { key, runtime: 'static' });
  entry.fixture.record('jobs.source', { sourceSha256, helperSha256 });
  entry.filename = 't899-http-' + entry.fixture.ledger.nonce + '.txt'; entry.marker = 'T899-ACTUAL-HTTP-' + entry.fixture.ledger.nonce;
  await entry.fixture.upload(entry.filename, entry.marker);
  const first = await entry.fixture.http('/' + entry.filename);
  assertHttp(entry, first, 'fresh-normal-static-site');
  const current = await domain(entry);
  expect(current.state).toBe('active'); expect(current.appliedRevision).toBe(current.desiredRevision);
  entry.active = activeConfig(entry); expect(entry.active.sha256).toBe(current.stagedChecksum);
  entry.fixture.record('jobs.initial-active-config', { sha256: entry.active.sha256, domainRevision: current.appliedRevision });
  for (const previous of entries.filter(row => row !== entry && row.fixture)) assertHttp(previous, await previous.fixture.http('/' + previous.filename), 'sibling-created');
  await preserveBaseline('created-' + key); return entry;
}

async function draft(entry, wave) {
  const before = await domain(entry), root = '/api/panel/domains/' + before.id;
  const header = { name: 'X-YunPanel-T899-W' + wave, value: entry.fixture.ledger.nonce + '-wave-' + wave, always: true };
  expect(before.nginxSettings.headers.some(row => row.name.toLowerCase() === header.name.toLowerCase())).toBe(false);
  const changes = { nginxSettings: { ...before.nginxSettings, headers: [...before.nginxSettings.headers, header] } };
  const preview = accepted(await entry.fixture.call('POST', root + '/update-preview', { changes }), 'Preview normal owned settings');
  expect(preview.domainId).toBe(before.id); expect(preview.currentRevision).toBe(before.desiredRevision);
  expect(preview.nextRevision).toBe(before.desiredRevision + 1); expect(preview.previewDigest).toMatch(SHA);
  expect(preview.confirmation).toBe('update-domain:' + before.id + ':' + preview.previewDigest);
  const saved = accepted(await entry.fixture.call('PATCH', root, { changes, previewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'Confirm normal owned settings');
  expect(saved.previewDigest).toBe(preview.previewDigest); expect(saved.domain.id).toBe(before.id);
  const current = await domain(entry);
  expect(current.state).toBe('draft'); expect(current.desiredRevision).toBe(preview.nextRevision);
  expect(current.appliedRevision).toBe(before.appliedRevision); expect(current.stagedRevision).toBe(0);
  expect(current.nginxSettings).toEqual(changes.nginxSettings); expect(activeConfig(entry).sha256).toBe(entry.active.sha256);
  entry.desired = current; entry.pendingHeader = header;
  entry.fixture.record('jobs.draft-saved', { wave, domainId: before.id, desiredRevision: current.desiredRevision,
    appliedRevision: current.appliedRevision, previousActiveSha256: entry.active.sha256, headerName: header.name, headerValue: header.value });
}

function assertJob(job, entry, action, id = null) {
  expect(job.id).toMatch(UUID); if (id !== null) expect(job.id).toBe(id);
  expect(job.serverId).toBe(entry.fixture.ledger.serverId); expect(job.resourceType).toBe('domain'); expect(job.resourceId).toBe(entry.fixture.ledger.domainId);
  expect(job.type).toBe('domain.' + action); expect(job.operation).toBe(action === 'stage' ? OPERATIONS.DOMAIN_STAGE : OPERATIONS.DOMAIN_ACTIVATE);
  expect(STATUSES).toContain(job.status);
}

async function pair(action, wave) {
  const observations = await Promise.all(entries.map(async entry => {
    const key = entry.key + ':' + wave + ':' + action; expect(sent.has(key), 'Each normal enqueue POST is sent exactly once').toBe(false); sent.add(key);
    const row = { key: entry.key, action, wave, startedAt: Date.now(), finishedAt: null, postCount: 1, receiptKnown: false, ownedJobReceiptVerified: false };
    entry.fixture.record('jobs.enqueue-intent', row);
    try {
      const reply = await entry.fixture.call('POST', '/api/panel/domains/' + entry.fixture.ledger.domainId + '/' + action, {});
      row.finishedAt = Date.now(); row.httpStatus = reply.status; row.receiptKnown = true;
      row.errorCode = /^[a-z0-9_]+$/.test(reply.body?.error?.code ?? '') ? reply.body.error.code : null;
      const queued = accepted(reply, 'Single normal ' + action + ' enqueue', 202); assertJob(queued, entry, action);
      row.ownedJobReceiptVerified = true; row.jobId = queued.id; row.receiptStatus = queued.status;
      entry.fixture.record('jobs.enqueue-receipt', row);
      return { entry, row, queued };
    } catch (error) {
      row.finishedAt ??= Date.now(); row.transportUncertain = error.code === 'owned_fixture_transport';
      entry.fixture.record('jobs.enqueue-not-verified', row); return { entry, row, error };
    }
  }));
  proof.waves[wave - 1][action] = { posts: observations.map(row => row.row),
    observedClientPostOverlap: Math.max(...observations.map(row => row.row.startedAt)) < Math.min(...observations.map(row => row.row.finishedAt)),
    internalAckWindowProved: false };
  // Resolve both actual HTTP attempts before raising one failure; a successful sibling job is never abandoned.
  const failed = observations.find(row => row.error); if (failed) throw failed.error;
  expect(new Set(observations.map(row => row.queued.id)).size).toBe(2);
  for (const { queued } of observations) { expect(seenJobIds.has(queued.id), 'A new wave/action must not reuse an earlier own job ID').toBe(false); seenJobIds.add(queued.id); }
  const completed = await Promise.all(observations.map(async ({ entry, row, queued }) => {
    try {
      const readStartedAt = Date.now();
      const actual = accepted(await entry.fixture.call('GET', '/api/panel/jobs/' + queued.id, undefined, { retryGets: false }), 'Read actual own job');
      assertJob(actual, entry, action, queued.id);
      const pendingObservation = { wave, action, jobId: queued.id, startedAt: readStartedAt, finishedAt: Date.now(), status: actual.status };
      entry.fixture.record('jobs.actual-status', pendingObservation); row.actualStatus = pendingObservation;
      const final = terminal(actual.status) ? actual : await entry.fixture.waitJob(queued.id, 180000);
      assertJob(final, entry, action, queued.id); row.terminalStatus = final.status;
      entry.fixture.record('jobs.terminal', { wave, action, jobId: final.id, status: final.status,
        errorCode: /^[a-z0-9_]+$/.test(final.error?.code ?? '') ? final.error.code : null });
      expect(final.status).toBe('succeeded');
      expect(final.result?.checksum).toMatch(SHA);
      if (action === 'activate') { expect(final.result.active).toBe(true); expect(final.result.checksum).toBe(entry.stagedChecksum); }
      return { entry, final };
    } catch (error) { return { entry, error }; }
  }));
  const failedJob = completed.find(row => row.error); if (failedJob) throw failedJob.error;
  return completed;
}

function physicalAbsence(ledger) {
  const value = readOnlyHostProbe({ ledger }, 'lifecycle-absence'), c = createWebsitePathContract(ledger);
  const roots = [ledger.documentRoot, c.runtime.applicationRoot, c.workspace.homeDirectory, c.static.buildRoot, c.static.publishRoot];
  expect(value.roots.map(row => row.path).sort()).toEqual([...new Set(roots)].sort()); expect(value.roots.every(row => row.exists === false)).toBe(true);
  expect(value.unixUserExists).toBe(false); expect(value.unixGroupExists).toBe(false);
  expect(value.fpmFiles).toEqual([]); expect(value.sockets).toEqual([]); expect(value.mounts).toEqual([]);
  const name = 'yunpanel-' + nginxConfigFileName(ledger.hostname);
  expect(value.nginxFiles.map(row => row.path).sort()).toEqual(['sites-available', 'sites-enabled'].map(v => '/etc/nginx/' + v + '/' + name).sort());
  expect(value.nginxFiles.every(row => row.exists === false)).toBe(true);
}

async function cleanupEntry(entry) {
  if (entry.removed || entry.noCreateLedger) return;
  const file = path.join(RUN_DIR, 'owned-fixtures', entry.key + '.json');
  if (!entry.fixture && !fs.existsSync(file)) { entry.noCreateLedger = true; return; }
  const ledger = entry.fixture?.ledger ?? JSON.parse(fs.readFileSync(file, 'utf8'));
  if (ledger.domainId) {
    const response = await actor.api.get('/api/panel/jobs?resourceType=domain&resourceId=' + ledger.domainId);
    expect(response.status()).toBe(200); const jobs = (await response.json()).data; expect(Array.isArray(jobs)).toBe(true);
    for (const job of jobs) {
      expect(job.serverId).toBe(ledger.serverId); expect(job.resourceType).toBe('domain'); expect(job.resourceId).toBe(ledger.domainId);
      if (!terminal(job.status)) {
        const final = entry.fixture ? await entry.fixture.waitJob(job.id, 180000) : await actor.api.get('/api/panel/jobs/' + job.id).then(async r => {
          expect(r.status()).toBe(200); const value = (await r.json()).data; expect(terminal(value.status)).toBe(true); return value;
        });
        expect(final.id).toBe(job.id); expect(terminal(final.status)).toBe(true);
        entry.fixture?.record('jobs.cleanup-terminal', { jobId: final.id, status: final.status });
      }
    }
  }
  const removed = entry.fixture ? await entry.fixture.cleanup() : await cleanupOwnedFixture(actor, { key: entry.key });
  entry.metadataRemoved = true;
  const siblingReads = await Promise.all(entries.filter(row => row !== entry && row.fixture && row.marker && !row.metadataRemoved).map(async row => ({ entry: row, first: await row.fixture.http('/' + row.filename) })));
  const firstBaseline = await baselineHttp();
  for (const row of siblingReads) {
    assertHttp(row.entry, row.first, 'normal-sibling-removal');
    for (const [resource, field] of [['websites', 'websiteId'], ['domains', 'domainId'], ['applications', 'applicationId']]) {
      const reply = await actor.api.get('/api/panel/' + resource + '/' + row.entry.fixture.ledger[field]); expect(reply.status()).toBe(200);
      expect((await reply.json()).data.id).toBe(row.entry.fixture.ledger[field]);
    }
  }
  for (const [resource, field] of [['websites', 'websiteId'], ['domains', 'domainId'], ['applications', 'applicationId']]) expect((await actor.api.get('/api/panel/' + resource + '/' + removed[field])).status()).toBe(404);
  physicalAbsence(removed); entry.removed = true; await preserveBaseline('normal-removal-' + entry.key, firstBaseline);
  proof.cleanups.push({ key: entry.key, websiteId: removed.websiteId, metadata404: true, canonicalRootsUnixFpmSocketNginxMountAbsent: true });
}

async function cleanupAll() {
  const failures = [];
  for (const entry of [...entries].reverse()) try { await cleanupEntry(entry); }
  catch (error) { failures.push({ key: entry.key, errorKind: error.name, code: /^[a-z0-9_]+$/.test(error.code ?? '') ? error.code : null }); }
  expect(failures, 'Every exact owned fixture must complete normal cleanup or remain an explicit failure').toEqual([]);
}

test.beforeAll(async () => {
  actor = await apiContext(); const run = manifest(); expect(run.target).toBe(TARGET);
  const rows = await inventory(), php = rows.find(row => row.id === run.existingPhpWebsiteId); expect(php).toBeTruthy();
  expect(php.applicationId).toMatch(UUID); expect(run.existingPhpDomainId).toMatch(UUID);
  baseline = { websiteIds: rows.map(row => row.id), hostname: run.existingPhpDomain, phpWebsiteId: php.id,
    phpApplicationId: php.applicationId, phpDomainId: run.existingPhpDomainId };
  baseline.endpoint = await baselineEndpoint(baseline.hostname);
  await preserveBaseline('before-owned-sites');
});
test.afterAll(async () => {
  test.setTimeout(360000); try { if (actor && entries.length) await cleanupAll(); } finally { await actor?.api.dispose(); }
});

test('@mutation source stages and activates two owned static domains concurrently in three bounded normal API waves', async ({}, info) => {
  test.setTimeout(1200000); let failure;
  try {
    const project = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex;
    await createSite('t899-jobs-a-' + project); await createSite('t899-jobs-b-' + project);
    expect(entries[0].fixture.ledger.websiteId).not.toBe(entries[1].fixture.ledger.websiteId);
    expect(entries[0].fixture.ledger.domainId).not.toBe(entries[1].fixture.ledger.domainId);
    expect(entries[0].fixture.ledger.unixUser).not.toBe(entries[1].fixture.ledger.unixUser);
    for (let wave = 1; wave <= 3; wave += 1) {
      proof.waves.push({ wave });
      for (const entry of entries) await draft(entry, wave);
      const staged = await pair('stage', wave);
      for (const { entry, final } of staged) {
        const current = await domain(entry); expect(current.state).toBe('staged'); expect(current.stagedRevision).toBe(current.desiredRevision);
        expect(current.desiredRevision).toBe(entry.desired.desiredRevision); expect(current.appliedRevision).toBe(entry.desired.appliedRevision);
        expect(current.stagedChecksum).toBe(final.result.checksum); entry.stagedChecksum = current.stagedChecksum;
        expect(activeConfig(entry).sha256).toBe(entry.active.sha256);
        const first = await entry.fixture.http('/' + entry.filename); assertHttp(entry, first, 'stage-wave-' + wave);
        expect(first.headers[entry.pendingHeader.name.toLowerCase()]).toBeUndefined();
      }
      await preserveBaseline('stage-wave-' + wave);
      await pair('activate', wave);
      const firstReplies = await Promise.all(entries.map(async entry => ({ entry, first: await entry.fixture.http('/' + entry.filename) })));
      const firstBaseline = await baselineHttp();
      for (const { entry, first } of firstReplies) {
        entry.appliedHeaders.push([entry.pendingHeader.name, entry.pendingHeader.value]); assertHttp(entry, first, 'activate-wave-' + wave);
      }
      for (const entry of entries) {
        const current = await domain(entry); expect(current.state).toBe('active'); expect(current.appliedRevision).toBe(entry.desired.desiredRevision);
        expect(current.stagedRevision).toBe(current.appliedRevision); expect(current.stagedChecksum).toBe(entry.stagedChecksum);
        const actual = activeConfig(entry); expect(actual.sha256).toBe(entry.stagedChecksum); expect(actual.sha256).not.toBe(entry.active.sha256);
        entry.active = actual; entry.fixture.record('jobs.wave-http-and-config', { wave, actualNginxSha256: actual.sha256,
          appliedRevision: current.appliedRevision, firstHttp200NonceAndHeader: true });
      }
      await preserveBaseline('activate-wave-' + wave, firstBaseline);
    }
    proof.actualNormalWavesPassed = 3; proof.distinctActualJobIds = [...seenJobIds]; expect(seenJobIds.size).toBe(12);
    for (const entry of entries) for (const open of openAcceptances) entry.fixture.record('openAcceptance', open);
  } catch (error) { failure = error; }
  finally {
    try { await cleanupAll(); } catch (error) { proof.cleanupFailed = true; failure ??= error; }
    privateJson('t899-native-job-concurrency.json', proof);
  }
  if (failure) throw failure;
  expect(proof.actualNormalWavesPassed).toBe(3); expect(proof.cleanups).toHaveLength(2);
});
