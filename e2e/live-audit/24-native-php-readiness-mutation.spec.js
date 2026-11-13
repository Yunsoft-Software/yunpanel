import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import dns from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, apiContext, manifest, privateJson, RUN_DIR, ORIGIN } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';
import { readOwnedPhpReadiness } from './php-readiness-probe.js';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';
import { nginxConfigFileName } from '../../packages/config-templates/src/index.js';

export const openAcceptances = [{
  id: 'T889.original-forensic-reason',
  reason: 'The original failed run retained only the generic php_fpm_apply_unverified code. Its initial inspection reason was not persisted.',
  assertions: ['The historical first failure is not assigned a socket/config/UMask cause from later passing runs'],
  requiredChannel: 'Actual original reason evidence, or a separately described newly reproduced false-negative readiness class',
}];

const TARGET = '157.180.11.28';
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
const helperSha256 = hash(fs.readFileSync(new URL('./owned-fixture.js', import.meta.url)));
const probeSha256 = hash(fs.readFileSync(new URL('./php-readiness-probe.js', import.meta.url)));
const entries = [];
let actor, original;
const proof = { sourceSha256, helperSha256, probeSha256, waves: [], cleanups: [], mechanism: 'OPEN' };

function accepted(reply, label, statuses = [200]) {
  const code = /^[a-z0-9_]+$/.test(reply.body?.error?.code ?? '') ? reply.body.error.code : null;
  expect(statuses, label + ' ' + (code ?? '')).toContain(reply.status);
  return reply.data;
}

async function inventory() {
  const reply = await actor.api.get('/api/panel/websites', { headers: { Connection: 'close' } });
  expect(reply.status()).toBe(200); const rows = (await reply.json()).data;
  expect(Array.isArray(rows)).toBe(true); return rows;
}

async function originalRequest({ hostname, scheme }) {
  assert.match(hostname, /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/);
  assert.ok(['http', 'https'].includes(scheme));
  const addresses = await dns.lookup(hostname, { all: true });
  assert.ok(addresses.length && addresses.every(row => row.address === TARGET));
  return new Promise((resolve, reject) => {
    const transport = scheme === 'https' ? https : http;
    const req = transport.get({ hostname: TARGET, port: scheme === 'https' ? 443 : 80, path: '/', agent: false,
      headers: { Host: hostname, Connection: 'close' }, timeout: 15000,
      ...(scheme === 'https' ? {
        servername: hostname, rejectUnauthorized: true,
        checkServerIdentity: (servername, certificate) => servername === hostname
          ? checkServerIdentity(hostname, certificate)
          : new Error('Original sibling TLS server name changed'),
      } : {}),
    }, res => {
      const tlsVerified = scheme === 'https' ? res.socket?.authorized === true : null;
      if (scheme === 'https' && tlsVerified !== true) {
        req.destroy(new Error('Original sibling TLS peer was not authenticated')); return;
      }
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(new Error('Owned sibling response exceeds the bounded read')); });
      const locations = [];
      for (let index = 0; index < res.rawHeaders.length; index += 2) {
        if (res.rawHeaders[index].toLowerCase() === 'location') locations.push(res.rawHeaders[index + 1]);
      }
      res.on('end', () => resolve({ status: res.statusCode, locations, tlsVerified }));
      res.on('error', () => reject(new Error('Original sibling bounded response failed')));
    });
    req.on('timeout', () => req.destroy(new Error('Original sibling first canonical response timed out')));
    // TLS errors can carry a raw certificate. Preserve only the safe code.
    req.on('error', error => {
      const code = /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'REQUEST_FAILED';
      reject(new Error('Original sibling canonical request failed: ' + code));
    });
  });
}

async function originalEndpoint(hostname) {
  const preflight = await originalRequest({ hostname, scheme: 'http' });
  let scheme = 'http', validatedLocation = null;
  if (preflight.status !== 200) {
    assert.ok([301, 308].includes(preflight.status), 'Original sibling preflight must be HTTP200 or a permanent canonical HTTPS redirect');
    assert.equal(preflight.locations.length, 1, 'Original sibling canonical redirect must have exactly one Location');
    const location = preflight.locations[0];
    assert.ok(typeof location === 'string' && location.length <= 2048 && !/[\u0000-\u0020\u007f@?#]/.test(location),
      'Original sibling redirect must contain no credentials, query, fragment or whitespace');
    let canonical;
    try { canonical = new URL(location); } catch { throw new Error('Original sibling canonical redirect must be an absolute HTTPS URL'); }
    assert.ok(canonical.protocol === 'https:' && canonical.hostname === hostname && canonical.port === ''
      && canonical.username === '' && canonical.password === '' && canonical.pathname === '/'
      && canonical.search === '' && canonical.hash === '' && canonical.origin === 'https://' + hostname,
    'Original sibling canonical redirect must stay on the exact hostname, HTTPS443 and root path');
    scheme = 'https';
    validatedLocation = location;
  }
  const endpoint = { hostname, scheme };
  proof.originalSiblingPreflight = { status: preflight.status, requestScheme: 'http', requestPort: 80,
    redirectVerified: scheme === 'https', redirectLocation: validatedLocation, canonicalUrl: scheme + '://' + hostname + '/',
    canonicalPort: scheme === 'https' ? 443 : 80, requiredCanonicalStatus: 200 };
  privateJson('t889-original-sibling-preflight.json', proof.originalSiblingPreflight);
  return endpoint;
}

async function originalPreserved(phase) {
  const rows = await inventory();
  expect(original.websiteIds.every(id => rows.some(row => row.id === id)), 'Every original Website identity must survive ' + phase).toBe(true);
  // One exact request, without an HTTP retry hiding a first failure.
  const reply = await originalRequest(original.endpoint);
  proof.originalSiblingReads ??= []; proof.originalSiblingReads.push({ phase, scheme: original.endpoint.scheme,
    status: reply.status, tlsVerified: reply.tlsVerified });
  if (original.endpoint.scheme === 'https') expect(reply.tlsVerified, 'Canonical sibling TLS chain and hostname must remain verified').toBe(true);
  expect(reply.status, 'Original healthy PHP sibling first response after ' + phase).toBe(200);
}

function createGate() {
  let arrived = 0, resolve, reject;
  const baselineCaptures = [], postIntents = [];
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A failure before either callback arrives must not leave an unhandled rejected promise.
  promise.catch(() => {});
  const timer = setTimeout(() => reject(new Error('The two owned normal create previews did not reach their common baseline barrier')), 30000);
  return {
    arrive: async entry => {
      const ledger = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'owned-fixtures', entry.key + '.json'), 'utf8'));
      assert.equal(ledger.key, entry.key); assert.equal(ledger.createSent, true);
      assert.ok(Array.isArray(ledger.baselineSiteIds) && Array.isArray(ledger.baselineRepositories));
      baselineCaptures.push({ key: entry.key, operationId: ledger.operationId, websiteId: ledger.websiteId,
        baselineSiteIds: [...ledger.baselineSiteIds], baselineRepositoryIds: [...ledger.baselineRepositories] });
      arrived += 1; assert.ok(arrived <= 2); if (arrived === 2) resolve(); await promise;
    },
    beforePost: key => {
      assert.equal(baselineCaptures.length, 2); assert.equal(new Set(baselineCaptures.map(row => row.key)).size, 2);
      postIntents.push({ key, baselineKeysAlreadyCaptured: baselineCaptures.map(row => row.key) });
    },
    evidence: () => ({ baselineCaptures, postIntents }),
    cancel: () => reject(new Error('The other owned create did not reach its normal preview; no request is replayed')),
    close: () => clearTimeout(timer),
  };
}

async function normalCreateAtBarrier(input, preview, gate, entry) {
  await gate.arrive(entry); gate.beforePost(entry.key);
  let response;
  try {
    response = await actor.api.post('/api/panel/sites', { data: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
      headers: { Origin: ORIGIN, 'x-csrf-token': actor.csrf, Connection: 'close' }, timeout: 120000, maxRedirects: 0 });
  } catch {
    // The helper may only reconcile this exact persisted operation with reads, never POST it again.
    throw Object.assign(new Error('Owned normal PHP create receipt is uncertain; reconcile the exact journal without replay'), { code: 'owned_fixture_transport' });
  }
  expect([200, 201], 'Normal PHP creation must return its actual receipt').toContain(response.status());
  return (await response.json()).data;
}

function assertPhp(reply, site, challenge, phase) {
  site.fixture.record('php.first-response', { phase, challenge, status: reply.status });
  expect(reply.status, 'First actual dynamic PHP response, without retry: ' + phase).toBe(200);
  let body = null; try { body = JSON.parse(reply.body); } catch { /* Exact comparison rejects source text and proxy errors. */ }
  expect(body).toEqual({ marker: site.marker, challenge, phpVersion: site.phpVersion, uid: site.uid, sapi: 'fpm-fcgi' });
  expect(reply.headers['cache-control']).toContain('no-store');
}

async function firstPhp(site, phase) {
  const challenge = randomBytes(12).toString('hex');
  const reply = await site.fixture.http('/t889-readiness.php?challenge=' + challenge);
  assertPhp(reply, site, challenge, phase);
}

async function createMember(entry, gate) {
  try {
    const fixture = await createOwnedFixture(actor, { key: entry.key, runtime: 'php',
      create: (input, preview) => normalCreateAtBarrier(input, preview, gate, entry) });
    entry.fixture = fixture;
    fixture.record('readiness.source', { sourceSha256, helperSha256, probeSha256 });
    const marker = 'T889-' + fixture.ledger.nonce, challenge = randomBytes(12).toString('hex');
    const code = '<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(['
      + '"marker"=>' + JSON.stringify(marker) + ',"challenge"=>(string)($_GET["challenge"]??""),'
      + '"phpVersion"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"sapi"=>PHP_SAPI]);';
    await fixture.upload('t889-readiness.php', code);
    // Capture the first dynamic response before slower API/config/physical diagnostic reads.
    const first = await fixture.http('/t889-readiness.php?challenge=' + challenge);
    const config = accepted(await fixture.call('GET', fixture.endpoint('/php-tools/config')), 'Read actual configured PHP version');
    const physical = readOnlyHostProbe(fixture, 'owned-site-files');
    expect(physical.unixUserExists).toBe(true); expect(physical.uid).toBeGreaterThan(0);
    const site = { fixture, marker, phpVersion: config.phpVersion, uid: physical.uid };
    assertPhp(first, site, challenge, 'normal-provisioning-ready'); entry.site = site;
    const observed = readOwnedPhpReadiness(fixture);
    fixture.record('readiness.actual-observation', observed);
    entry.readiness = observed;
    return entry;
  } catch (error) { gate.cancel(); throw error; }
}

function absence(ledger) {
  const p = readOnlyHostProbe({ ledger }, 'lifecycle-absence'), c = createWebsitePathContract(ledger);
  const roots = [ledger.documentRoot, c.runtime.applicationRoot, c.workspace.homeDirectory, c.static.buildRoot, c.static.publishRoot];
  expect(p.roots.map(row => row.path).sort()).toEqual([...new Set(roots)].sort());
  expect(p.roots.every(row => row.exists === false)).toBe(true);
  expect(p.unixUserExists).toBe(false); expect(p.unixGroupExists).toBe(false);
  expect(p.fpmFiles).toEqual([]); expect(p.sockets).toEqual([]); expect(p.mounts).toEqual([]);
  const name = 'yunpanel-' + nginxConfigFileName(ledger.hostname);
  expect(p.nginxFiles.map(row => row.path).sort()).toEqual(['sites-available', 'sites-enabled'].map(v => '/etc/nginx/' + v + '/' + name).sort());
  expect(p.nginxFiles.every(row => row.exists === false)).toBe(true);
}

async function cleanupAll() {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    if (entry.removed || entry.noCreateLedger) continue;
    try {
      if (!entry.fixture && !fs.existsSync(path.join(RUN_DIR, 'owned-fixtures', entry.key + '.json'))) {
        // The helper persists its ledger before any create POST. No ledger means no create was sent.
        entry.noCreateLedger = true; proof.cleanups.push({ key: entry.key, noCreateLedger: true, physicalAbsenceClaimed: false });
        continue;
      }
      const ledger = entry.fixture ? await entry.fixture.cleanup() : await cleanupOwnedFixture(actor, { key: entry.key });
      for (const [resource, field] of [['websites', 'websiteId'], ['domains', 'domainId'], ['applications', 'applicationId']]) {
        expect((await actor.api.get('/api/panel/' + resource + '/' + ledger[field])).status()).toBe(404);
      }
      absence(ledger); entry.removed = true;
      proof.cleanups.push({ key: entry.key, websiteId: ledger.websiteId, allThreeIdentitiesAbsent: true,
        canonicalRootsUnixNginxFpmSocketMountAbsent: true });
      await originalPreserved('removal-' + entry.key);
      // Remaining group members keep their original identities and first dynamic responses.
      for (const survivor of entries.filter(row => row.site && !row.removed)) {
        for (const [resource, field] of [['websites', 'websiteId'], ['domains', 'domainId'], ['applications', 'applicationId']]) {
          const reply = await actor.api.get('/api/panel/' + resource + '/' + survivor.fixture.ledger[field]);
          expect(reply.status(), 'Normal group cleanup must preserve every other live owned identity').toBe(200);
          expect((await reply.json()).data.id).toBe(survivor.fixture.ledger[field]);
        }
        await firstPhp(survivor.site, 'sibling-removal-' + entry.key);
      }
    } catch (error) { failures.push({ key: entry.key, errorKind: error.name, code: /^[a-z0-9_]+$/.test(error.code ?? '') ? error.code : null }); }
  }
  expect(failures, 'Every exact owned fixture must finish its normal lifecycle, or remain an explicit cleanup failure').toEqual([]);
}

test.beforeAll(async () => {
  actor = await apiContext(); const run = manifest(), rows = await inventory();
  expect(run.target).toBe(TARGET); expect(rows.some(row => row.id === run.existingPhpWebsiteId)).toBe(true);
  original = { websiteIds: rows.map(row => row.id), hostname: run.existingPhpDomain };
  original.endpoint = await originalEndpoint(original.hostname);
  await originalPreserved('before-owned-waves');
});

test.afterAll(async () => {
  test.setTimeout(360000);
  try { if (actor && entries.length) await cleanupAll(); }
  finally { await actor?.api.dispose(); }
});

test('@mutation source records actual PHP readiness across two bounded parallel owned waves and proves an initial inspect false-to-true transition', async ({}, info) => {
  test.setTimeout(1200000); let primaryFailure;
  try {
    const project = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex;
    for (let wave = 1; wave <= 2; wave += 1) {
      const gate = createGate();
      const group = [1, 2].map(member => ({ key: 't889-wave' + wave + '-m' + member + '-' + project, fixture: null, removed: false }));
      entries.push(...group);
      let results; try { results = await Promise.allSettled(group.map(entry => createMember(entry, gate))); }
      finally { gate.close(); }
      const failed = results.filter(row => row.status === 'rejected');
      if (failed.length) throw failed[0].reason;
      expect(new Set(entries.map(row => row.fixture.ledger.websiteId)).size).toBe(entries.length);
      expect(new Set(entries.map(row => row.fixture.ledger.unixUser)).size).toBe(entries.length);
      expect(new Set(entries.map(row => row.site.uid)).size).toBe(entries.length);
      const barrier = gate.evidence(); expect(barrier.baselineCaptures).toHaveLength(2); expect(barrier.postIntents).toHaveLength(2);
      proof.waves.push({ wave, barrier, members: group.map(entry => ({ key: entry.key, websiteId: entry.fixture.ledger.websiteId,
        firstDynamicHttpPassed: true, uid: entry.site.uid, readiness: entry.readiness })) });
      await originalPreserved('completed-wave-' + wave);
      for (const entry of entries) await firstPhp(entry.site, 'completed-wave-' + wave);
    }
    proof.readinessAndDynamicHttpPassed = true;
    const recovered = entries.filter(entry => {
      const r = entry.readiness.readiness.poolActivation;
      return r.firstSatisfied === false && r.firstReason !== null && r.lastSatisfied === true && r.attempts > 1;
    });
    proof.mechanism = recovered.length ? 'actual-initial-inspect-false-to-true-observed' : 'OPEN';
    proof.actualCausalOperationIds = recovered.map(entry => entry.fixture.ledger.provisioningId);
    proof.historicalFirstFailureReason = 'unknown-not-persisted';
    for (const entry of entries) entry.fixture.record('readiness.mechanism', { mechanism: proof.mechanism,
      actualCausalOperationIds: proof.actualCausalOperationIds, historicalFirstFailureReason: proof.historicalFirstFailureReason });
  } catch (error) { primaryFailure = error; }
  finally {
    try { await cleanupAll(); } catch (error) { proof.cleanupFailed = true; primaryFailure ??= error; }
    privateJson('t889-native-readiness.json', proof);
  }
  if (primaryFailure) throw primaryFailure;
  expect(proof.readinessAndDynamicHttpPassed).toBe(true);
  expect(proof.actualCausalOperationIds.length,
    'T889 mechanism remains OPEN unless a real initial INSPECT false becomes true; listener-only delay and all-first-true green runs do not prove its cause').toBeGreaterThan(0);
});
