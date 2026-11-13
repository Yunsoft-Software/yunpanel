import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, apiContext } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';
import { nginxConfigFileName } from '../../packages/config-templates/src/index.js';

export const openAcceptances = [
  {
    id: 'T892.historical-removed-identities',
    assertions: ['the two previously recorded orphan Nginx files are recovered through an authorized native channel'],
    reason: 'Those Websites and Domains are already absent. Fresh lifecycle tests cannot prove recovery of their historical identities, and must not delete their files behind the panel.',
    requiredChannel: 'Separately scoped recovery of the exact historical owned journals and files',
  },
  {
    id: 'T892.unknown-applied-source',
    assertions: ['removal refuses ambiguous legacy applied identity or mismatching physical configuration without deleting a foreign file'],
    reason: 'A fresh normally provisioned Website has a verified applied identity. Manufacturing missing registry evidence or changing host configuration is outside these tests.',
    requiredChannel: 'A legitimate owned legacy/source-drift fixture and separately authorized native negative acceptance',
  },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const domainPath = fixture => '/api/panel/domains/' + fixture.ledger.domainId;
const removalPath = id => '/api/panel/website-removal-operations/' + id;
const sourceSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
const helperSha256 = hash(fs.readFileSync(new URL('./owned-fixture.js', import.meta.url)));
let actor;
const entries = [];

function accepted(result, label, status = 200) {
  const code = /^[a-z0-9_]+$/.test(result.body?.error?.code ?? '') ? result.body.error.code : 'unknown';
  expect(result.status, label + ': ' + code).toBe(status);
  return result.data;
}

async function domain(fixture) {
  const value = accepted(await fixture.call('GET', domainPath(fixture)), 'Read owned Domain');
  expect(value.id).toBe(fixture.ledger.domainId);
  expect(value.websiteId).toBe(fixture.ledger.websiteId);
  expect(value.primaryDomain).toBe(fixture.ledger.hostname);
  return value;
}

function activeConfig(fixture) {
  const value = readOnlyHostProbe(fixture, 'nginx-config');
  expect(value.regular).toBe(true);
  expect(value.symlink).toBe(false);
  expect(value.uid).toBe(0);
  expect(value.mode & 0o022).toBe(0);
  expect(value.bytes).toBeGreaterThan(0);
  expect(value.sha256).toMatch(/^[a-f0-9]{64}$/);
  return value;
}

function physicalAbsence(ledger) {
  const value = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
  const contract = createWebsitePathContract(ledger);
  const roots = [ledger.documentRoot, contract.runtime.applicationRoot, contract.workspace.homeDirectory,
    contract.static.buildRoot, contract.static.publishRoot];
  expect(value.roots.map(item => item.path).sort()).toEqual([...new Set(roots)].sort());
  expect(value.roots.every(item => item.exists === false)).toBe(true);
  expect(value.unixUserExists).toBe(false);
  expect(value.unixGroupExists).toBe(false);
  expect(value.fpmFiles).toEqual([]);
  expect(value.sockets).toEqual([]);
  expect(value.mounts).toEqual([]);
  const name = 'yunpanel-' + nginxConfigFileName(ledger.hostname);
  expect(value.nginxFiles.map(item => item.path).sort()).toEqual(
    ['sites-available', 'sites-enabled'].map(directory => '/etc/nginx/' + directory + '/' + name).sort(),
  );
  expect(value.nginxFiles.every(item => item.exists === false)).toBe(true);
}

async function identitiesAbsent(fixture) {
  for (const [resource, key] of [['websites', 'websiteId'], ['domains', 'domainId'], ['applications', 'applicationId']]) {
    const reply = await fixture.call('GET', '/api/panel/' + resource + '/' + fixture.ledger[key]);
    expect(reply.status, 'The exact removed ' + resource + ' identity must be absent').toBe(404);
  }
}

function assertPhp(reply, site, challenge, phase) {
  site.fixture.record('php.first-response', { phase, challenge, status: reply.status });
  expect(reply.status, 'The first actual PHP response must succeed without a replacement request').toBe(200);
  let body = null;
  try { body = JSON.parse(reply.body); } catch { /* The exact JSON assertion below rejects PHP source and error pages. */ }
  expect(body).toEqual({ proof: site.marker, challenge, phpVersion: site.phpVersion, uid: site.uid, sapi: 'fpm-fcgi' });
  expect(reply.headers['cache-control']).toContain('no-store');
  return reply;
}

async function phpReply(site, phase, challenge = randomBytes(12).toString('hex')) {
  const reply = await site.fixture.http('/' + site.filename + '?challenge=' + challenge);
  return assertPhp(reply, site, challenge, phase);
}

async function createPhp(key) {
  const entry = { key, fixture: null, cleanupDone: false, startSent: false, removalId: null, baselineOperationIds: [] };
  entries.push(entry);
  const fixture = await createOwnedFixture(actor, { key, runtime: 'php' });
  entry.fixture = fixture;
  fixture.record('source-proof', { sourceSha256, helperSha256 });
  const initial = await domain(fixture);
  expect(initial.state).toBe('active');
  expect(initial.appliedRevision).toBeGreaterThan(0);
  expect(initial.appliedRevision).toBe(initial.desiredRevision);
  const php = accepted(await fixture.call('GET', fixture.endpoint('/php-tools/config')), 'Read configured PHP version');
  const physical = readOnlyHostProbe(fixture, 'owned-site-files');
  expect(physical.unixUserExists).toBe(true);
  expect(physical.uid).toBeGreaterThan(0);
  const site = { fixture, entry, initial, uid: physical.uid, phpVersion: php.phpVersion,
    filename: 't892-dynamic-proof.php', marker: 'T892-' + fixture.ledger.nonce };
  const code = '<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(['
    + '"proof"=>' + JSON.stringify(site.marker) + ',"challenge"=>(string)($_GET["challenge"]??""),'
    + '"phpVersion"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"sapi"=>PHP_SAPI]);';
  await fixture.upload(site.filename, code);
  expect((await fixture.http('/')).status).toBe(200);
  await phpReply(site, 'fully-applied');
  site.config = activeConfig(fixture);
  fixture.record('applied.baseline', { desiredRevision: initial.desiredRevision, appliedRevision: initial.appliedRevision,
    activeNginxSha256: site.config.sha256, configPath: site.config.path, phpVersion: site.phpVersion, uid: site.uid });
  return site;
}

async function cleanupEntry(entry) {
  if (entry.cleanupDone) return;
  if (entry.fixture && entry.startSent && !entry.removalId) {
    const current = await entry.fixture.call('GET', entry.fixture.endpoint('/removal'));
    if (current.status === 404) {
      await identitiesAbsent(entry.fixture);
      physicalAbsence(entry.fixture.ledger);
      entry.fixture.record('cleanup.uncertain-start-absent', { sameJournalAcceptanceProved: false });
      entry.cleanupDone = true;
      return;
    }
    const preview = accepted(current, 'Read uncertain owned removal without replay');
    const candidates = preview.operations.filter(operation => operation.websiteId === entry.fixture.ledger.websiteId
      && !entry.baselineOperationIds.includes(operation.id));
    expect(candidates, 'An uncertain start must reconcile to exactly one owned journal, without another POST').toHaveLength(1);
    entry.removalId = candidates[0].id;
    entry.fixture.record('cleanup.uncertain-start-journal', { operationId: entry.removalId });
  }
  const ledger = entry.fixture ? await entry.fixture.cleanup() : await cleanupOwnedFixture(actor, { key: entry.key });
  physicalAbsence(ledger);
  entry.fixture?.record('cleanup.physical-absence', { allCanonicalRootsAbsent: true, unixUserGroupAbsent: true,
    nginxFpmSocketMountAbsent: true });
  entry.cleanupDone = true;
}

async function removeNormally(site) {
  const fixture = site.fixture, entry = site.entry;
  const before = accepted(await fixture.call('GET', fixture.endpoint('/removal')), 'Preview normal owned removal');
  expect(before.preview.readyToStart).toBe(true);
  expect(before.operations).toEqual([]);
  entry.baselineOperationIds = before.operations.map(operation => operation.id);
  entry.startSent = true;
  fixture.record('removal.intent', { baselineOperationIds: entry.baselineOperationIds, desiredState: site.scenario });
  const operation = accepted(await fixture.call('POST', fixture.endpoint('/removal'), {
    previewDigest: before.preview.previewDigest, confirmation: before.preview.confirmation,
  }), 'Start normal owned removal once', 201);
  expect(operation.id).toMatch(/^ws-rem-[a-f0-9-]{36}$/i);
  expect(operation.websiteId).toBe(fixture.ledger.websiteId);
  expect(operation.execution.mode).toBe('automatic');
  entry.removalId = operation.id;
  fixture.record('removal.started', { operationId: operation.id, receiptKnown: true });
  const stop = Date.now() + 180000;
  while (Date.now() < stop) {
    const current = accepted(await fixture.call('GET', removalPath(operation.id)), 'Read the same native removal journal');
    expect(current.id).toBe(operation.id);
    expect(current.websiteId).toBe(fixture.ledger.websiteId);
    expect(current.serverId).toBe(fixture.ledger.serverId);
    expect(current.applicationId).toBe(fixture.ledger.applicationId);
    expect(['failed', 'blocked', 'cancelled'], 'Normal removal must not hide a stopped journal').not.toContain(current.status);
    if (current.status === 'removed') {
      expect(current.error).toBeNull();
      expect(current.steps.length).toBeGreaterThan(0);
      expect(current.steps.every(step => step.status === 'succeeded')).toBe(true);
      expect(current.steps.find(step => step.kind === 'domain_removal' && step.resourceId === fixture.ledger.domainId)?.status).toBe('succeeded');
      fixture.record('removal.same-journal-completed', { operationId: operation.id, stateBeforeRemoval: site.scenario });
      return current;
    }
    await sleep(500);
  }
  throw new Error('The exact native owned removal journal did not finish');
}

test.beforeAll(async () => { actor = await apiContext(); });
test.afterAll(async () => {
  test.setTimeout(360000);
  const failures = [];
  for (const entry of [...entries].reverse()) try { await cleanupEntry(entry); }
  catch (error) { failures.push({ key: entry.key, errorKind: error.name, errorCode: error.code ?? null }); }
  await actor?.api.dispose();
  expect(failures, 'Every owned lifecycle fixture must finish normal cleanup or remain an explicit failure').toEqual([]);
});

for (const scenario of ['draft', 'staged']) {
  test('@mutation source removes a previously applied PHP site from ' + scenario + ' while preserving the first dynamic PHP sibling response', async ({}, info) => {
    test.setTimeout(600000);
    const project = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex;
    const created = [];
    let failure;
    try {
      const sibling = await createPhp('t892-' + scenario + '-sibling-' + project); created.push(sibling.entry);
      const target = await createPhp('t892-' + scenario + '-target-' + project); created.push(target.entry);
      target.scenario = scenario;
      expect(target.uid).not.toBe(sibling.uid);
      expect(target.fixture.ledger.unixUser).not.toBe(sibling.fixture.ledger.unixUser);
      for (const open of openAcceptances) target.fixture.record('openAcceptance', open);
      const original = target.initial, fixture = target.fixture, header = 'X-YunPanel-T892';
      expect(original.nginxSettings.headers.some(item => item.name.toLowerCase() === header.toLowerCase())).toBe(false);
      const desired = { ...original.nginxSettings,
        clientMaxBodySizeMb: original.nginxSettings.clientMaxBodySizeMb === 17 ? 19 : 17,
        headers: [...original.nginxSettings.headers, { name: header, value: target.fixture.ledger.nonce, always: true }] };
      const input = { changes: { nginxSettings: desired } }, root = domainPath(fixture);
      const preview = accepted(await fixture.call('POST', root + '/update-preview', input), 'Preview newer desired Nginx settings');
      accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'Save desired settings without activation');
      let changed = await domain(fixture);
      expect(changed.state).toBe('draft');
      expect(changed.desiredRevision).toBe(original.desiredRevision + 1);
      expect(changed.appliedRevision).toBe(original.appliedRevision);
      expect(changed.desiredRevision).toBeGreaterThan(changed.appliedRevision);
      expect(changed.stagedRevision).toBe(0);
      expect(changed.nginxSettings).toEqual(desired);
      if (scenario === 'staged') {
        const queued = accepted(await fixture.call('POST', root + '/stage', {}), 'Stage the newer desired revision without activation', 202);
        const job = await fixture.waitJob(queued.id, 180000);
        expect(job.status).toBe('succeeded');
        expect(job.resourceId).toBe(fixture.ledger.domainId);
        changed = await domain(fixture);
        expect(changed.state).toBe('staged');
        expect(changed.stagedRevision).toBe(changed.desiredRevision);
        expect(changed.stagedChecksum).toMatch(/^[a-f0-9]{64}$/);
        expect(changed.appliedRevision).toBe(original.appliedRevision);
        expect(changed.desiredRevision).toBeGreaterThan(changed.appliedRevision);
        fixture.record('desired.real-stage', { jobId: job.id, stagedRevision: changed.stagedRevision, activated: false });
      }
      expect(activeConfig(fixture).sha256).toBe(target.config.sha256);
      const stillApplied = await phpReply(target, scenario + '-still-applied');
      expect(stillApplied.headers[header.toLowerCase()]).toBeUndefined();
      fixture.record('desired.newer-than-applied', { desiredRevision: changed.desiredRevision,
        appliedRevision: changed.appliedRevision, stagedRevision: changed.stagedRevision, state: changed.state,
        activeNginxSha256: target.config.sha256, desiredSettingsSha256: hash(JSON.stringify(desired)), activated: false });
      const challenge = randomBytes(12).toString('hex');
      const removed = await removeNormally(target);
      // Capture the first sibling reply before metadata reads, cleanup, or slow physical probes.
      const first = await sibling.fixture.http('/' + sibling.filename + '?challenge=' + challenge);
      assertPhp(first, sibling, challenge, 'immediately-after-' + scenario + '-removal');
      sibling.fixture.record('sibling.first-response-after-removal', { operationId: removed.id, status: first.status,
        challenge, dynamicUidSapiAndNoStoreVerified: true });
      await identitiesAbsent(fixture);
      physicalAbsence(fixture.ledger);
      expect(activeConfig(sibling.fixture).sha256).toBe(sibling.config.sha256);
      fixture.record('removal.native-physical-result', { operationId: removed.id, allThreeIdentitiesAbsent: true,
        canonicalRootsUnixNginxFpmSocketMountAbsent: true, siblingFirstResponsePreserved: true });
    } catch (error) { failure = error; }
    finally {
      for (const entry of [...created].reverse()) try { await cleanupEntry(entry); }
      catch (error) {
        entry.fixture?.record('cleanup.failure', { errorKind: error.name, errorCode: error.code ?? null });
        failure ??= error;
      }
    }
    if (failure) throw failure;
  });
}
