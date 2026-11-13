import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, apiContext } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';

const sourceSha256 = createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex');
const entries = [];
let actor;
const accepted = (result, status = 200) => {
  expect(result.status, result.body?.error?.code).toBe(status);
  return result.data;
};
const domainPath = fixture => '/api/panel/domains/' + fixture.ledger.domainId;
const provisioningPath = fixture => '/api/panel/sites/provisioning/' + fixture.ledger.provisioningId;

function physicalAbsence(ledger) {
  const actual = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
  const contract = createWebsitePathContract(ledger);
  const expectedRoots = [ledger.documentRoot, contract.runtime.applicationRoot, contract.workspace.homeDirectory,
    contract.static.buildRoot, contract.static.publishRoot];
  expect(actual.roots.map(item => item.path).sort()).toEqual([...new Set(expectedRoots)].sort());
  expect(actual.roots.every(item => !item.exists)).toBe(true);
  expect(actual.unixUserExists).toBe(false); expect(actual.unixGroupExists).toBe(false);
  expect(actual.nginxFiles.every(item => !item.exists)).toBe(true);
  expect(actual.fpmFiles).toEqual([]); expect(actual.sockets).toEqual([]); expect(actual.mounts).toEqual([]);
}

async function metadataAbsence(fixture) {
  for (const [resource, id] of [['websites', fixture.ledger.websiteId], ['domains', fixture.ledger.domainId], ['applications', fixture.ledger.applicationId]]) {
    expect((await fixture.call('GET', '/api/panel/' + resource + '/' + id)).status).toBe(404);
  }
}

function activeConfig(fixture) {
  const actual = readOnlyHostProbe(fixture, 'nginx-config');
  expect(actual.regular).toBe(true); expect(actual.symlink).toBe(false); expect(actual.uid).toBe(0);
  expect(actual.sha256).toMatch(/^[a-f0-9]{64}$/); expect(actual.bytes).toBeGreaterThan(0);
  return actual.sha256;
}

async function createPhp(key) {
  const entry = { key, fixture: null, removed: false }; entries.push(entry);
  const fixture = await createOwnedFixture(actor, { key, runtime: 'php' }); entry.fixture = fixture;
  fixture.record('source-proof', { sourceSha256 });
  const physical = readOnlyHostProbe(fixture, 'owned-site-files');
  expect(physical.unixUserExists).toBe(true); expect(physical.uid).toBeGreaterThan(0);
  const php = accepted(await fixture.call('GET', fixture.endpoint('/php-tools/config')));
  const marker = 'T892-retirement-' + fixture.ledger.nonce;
  const filename = 't892-retirement-proof.php';
  await fixture.upload(filename, '<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(['
    + '"marker"=>' + JSON.stringify(marker) + ',"challenge"=>(string)($_GET["challenge"]??""),'
    + '"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"phpVersion"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"sapi"=>PHP_SAPI]);');
  const site = { entry, fixture, filename, marker, uid: physical.uid, phpVersion: php.phpVersion, nginxSha256: activeConfig(fixture) };
  await firstPhp(site, 'created');
  return site;
}

async function firstPhp(site, phase) {
  const challenge = randomBytes(12).toString('hex');
  const first = await site.fixture.http('/' + site.filename + '?challenge=' + challenge);
  site.fixture.record('retirement.first-php-response', { phase, challenge, status: first.status });
  expect(first.status, 'The first dynamic PHP response must succeed without retry').toBe(200);
  expect(JSON.parse(first.body)).toEqual({ marker: site.marker, challenge, uid: site.uid, phpVersion: site.phpVersion, sapi: 'fpm-fcgi' });
  expect(first.headers['cache-control']).toContain('no-store');
}

async function cleanup(entry) {
  if (entry.removed) return;
  const ledger = entry.fixture ? await entry.fixture.cleanup() : await cleanupOwnedFixture(actor, { key: entry.key });
  physicalAbsence(ledger);
  if (entry.fixture) await metadataAbsence(entry.fixture);
  entry.removed = true;
}

async function compensate(fixture, stepId) {
  return accepted(await fixture.call('POST', provisioningPath(fixture) + '/steps/' + stepId + '/compensate', {
    confirmation: 'compensate-site-provisioning:' + fixture.ledger.provisioningId + ':' + stepId,
  }));
}

async function setAliases(fixture, aliases) {
  const input = { changes: { aliases } };
  const preview = accepted(await fixture.call('POST', domainPath(fixture) + '/update-preview', input));
  accepted(await fixture.call('PATCH', domainPath(fixture), { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
  const current = accepted(await fixture.call('GET', domainPath(fixture)));
  expect(current.aliases).toEqual(aliases);
  expect(current.state).toBe('draft'); expect(current.desiredRevision).toBeGreaterThan(current.appliedRevision);
  return current;
}

test.beforeAll(async () => { actor = await apiContext(); });
test.afterAll(async () => {
  test.setTimeout(360000);
  const failures = [];
  for (const entry of [...entries].reverse()) try { await cleanup(entry); }
  catch (error) { failures.push({ key: entry.key, errorKind: error.name, errorCode: error.code ?? null }); }
  await actor?.api.dispose();
  expect(failures, 'Every exact owned retirement fixture must be physically cleaned').toEqual([]);
});

test('@mutation source retired provisioning compensation rejects a reassigned alias even when the old Nginx file is already absent', async ({}, info) => {
  test.setTimeout(600000);
  const project = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex;
  let failure;
  try {
    const old = await createPhp('t892-retire-old-' + project);
    const initial = accepted(await old.fixture.call('GET', provisioningPath(old.fixture)));
    expect(initial.ready).toBe(true);
    expect(initial.steps.find(step => step.id === 'domain_activation')?.canCompensate).toBe(true);
    await cleanup(old.entry);
    await metadataAbsence(old.fixture); physicalAbsence(old.fixture.ledger);
    const activation = await compensate(old.fixture, 'domain_activation');
    expect(activation.outcome).toBe('compensated'); expect(activation.error).toBeNull();
    expect(activation.operation.steps.find(step => step.id === 'domain_activation')?.compensation.state).toBe('succeeded');
    old.fixture.record('retirement.activation-compensated', { operationId: old.fixture.ledger.provisioningId, metadataStillAbsent: true });

    // B is created only after A is removed, preserving the fixture's original
    // baseline ownership contract. Reserve A's name through a normal API edit.
    const current = await createPhp('t892-retire-current-' + project);
    expect(current.fixture.ledger.applicationId).not.toBe(old.fixture.ledger.applicationId);
    expect(current.fixture.ledger.unixUser).not.toBe(old.fixture.ledger.unixUser);
    const reserved = await setAliases(current.fixture, [old.fixture.ledger.hostname]);
    expect(activeConfig(current.fixture)).toBe(current.nginxSha256);
    const blocked = await compensate(old.fixture, 'nginx');
    // Capture B's first actual dynamic response immediately after the rejected
    // old compensation, before any metadata or filesystem readback.
    await firstPhp(current, 'after-alias-blocked-compensation');
    expect(blocked.outcome).toBe('compensation_failed');
    expect(blocked.error).toBe('website_provisioning_retirement_name_reassigned');
    expect(blocked.operation.steps.find(step => step.id === 'nginx')?.compensation.state).toBe('failed');
    expect(activeConfig(current.fixture)).toBe(current.nginxSha256);
    physicalAbsence(old.fixture.ledger); await metadataAbsence(old.fixture);
    old.fixture.record('retirement.alias-reassignment-blocked', { aliasOwnerWebsiteId: current.fixture.ledger.websiteId,
      desiredRevision: reserved.desiredRevision, oldConfigAlreadyAbsent: true, siblingFirstDynamicHttpPreserved: true });

    await setAliases(current.fixture, []);
    const compensated = await compensate(old.fixture, 'nginx');
    await firstPhp(current, 'after-absent-old-config-compensation');
    expect(compensated.outcome).toBe('compensated'); expect(compensated.error).toBeNull();
    expect(compensated.operation.steps.find(step => step.id === 'nginx')?.compensation.state).toBe('succeeded');
    physicalAbsence(old.fixture.ledger); await metadataAbsence(old.fixture);
    expect(activeConfig(current.fixture)).toBe(current.nginxSha256);
    old.fixture.record('retirement.nginx-idempotent-absence', { originalOperationId: old.fixture.ledger.provisioningId,
      oldIdentitiesAndPhysicalResourcesAbsent: true, siblingFirstDynamicHttpPreserved: true });
  } catch (error) { failure = error; }
  finally {
    for (const entry of [...entries].reverse()) try { await cleanup(entry); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
});
