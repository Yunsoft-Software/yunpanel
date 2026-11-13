import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { test, expect, apiContext } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const accepted = (result, status = 200) => { expect(result.status, result.body?.error?.code).toBe(status); return result.data; };
const domainPath = fixture => '/api/panel/domains/' + fixture.ledger.domainId;
async function uploadOwned(fixture, filename, value) {
  try { await fixture.upload(filename, value); }
  catch (error) {
    if (error.code !== 'owned_fixture_transport') throw error;
    let readback;
    try { readback = await fixture.readText(filename); }
    catch { fixture.record('files.upload.unconfirmed', { filename, receiptKnown: false }); throw error; }
    const sha256 = createHash('sha256').update(value).digest('hex');
    expect(readback.sha256).toBe(sha256); expect(readback.content).toBe(Buffer.from(value).toString('utf8'));
    fixture.record('files.upload.reconciled', { filename, sha256, receiptKnown: false, actualContentVerified: true });
  }
}
async function config(fixture) {
  const value = await readOnlyHostProbe(fixture, 'nginx-config');
  expect(value.regular).toBe(true); expect(value.symlink).toBe(false); expect(value.uid).toBe(0);
  expect(value.mode & 0o022).toBe(0); expect(value.bytes).toBeGreaterThan(0); return value;
}
async function domain(fixture) {
  const value = accepted(await fixture.call('GET', domainPath(fixture)));
  expect(value.websiteId).toBe(fixture.ledger.websiteId); expect(value.primaryDomain).toBe(fixture.ledger.hostname); return value;
}
async function publish(fixture, settings) {
  const root = domainPath(fixture), current = await domain(fixture);
  if (!isDeepStrictEqual(current.nginxSettings, settings)) {
    const input = { changes: { nginxSettings: settings } }, preview = accepted(await fixture.call('POST', root + '/update-preview', input));
    accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
  }
  const pending = await domain(fixture);
  if (pending.state !== 'active' || pending.appliedRevision !== pending.desiredRevision) for (const action of ['stage', 'activate']) {
    const job = accepted(await fixture.call('POST', root + '/' + action, {}), 202); expect((await fixture.waitJob(job.id)).status).toBe('succeeded');
  }
  const applied = await domain(fixture); expect(applied.nginxSettings).toEqual(settings); expect(applied.appliedRevision).toBe(applied.desiredRevision);
}
async function zone(fixture) { return accepted(await fixture.call('GET', domainPath(fixture) + '/dns/zone')); }
const recordMatches = (fixture, owner, rrset) => rrset.type === 'TXT' && [owner, owner + '.' + fixture.ledger.hostname, owner + '.' + fixture.ledger.hostname + '.'].includes(rrset.owner);
async function writeTxt(fixture, owner, value) {
  const current = await zone(fixture);
  return accepted(await fixture.call('POST', domainPath(fixture) + '/dns/records', { owner, type: 'TXT', ttl: 300, values: [value], expectedSerial: current.serial }));
}
async function deleteTxt(fixture, owner) {
  const current = await zone(fixture);
  if (current.rrsets.some(rrset => recordMatches(fixture, owner, rrset))) accepted(await fixture.call('POST', domainPath(fixture) + '/dns/records/delete', { owner, type: 'TXT', expectedSerial: current.serial }));
}
async function finished(fixture, operation, status = 'succeeded') {
  const job = await fixture.waitJob(operation.jobId, 180000); expect(job.status).toBe('succeeded');
  const result = accepted(await fixture.call('GET', fixture.endpoint('/backup-operations/' + operation.id)));
  expect(result.status, result.error?.code).toBe(status); return result;
}
async function restoreSnapshot(fixture, repositoryId, snapshotId, healthPath = '/') {
  const input = { repositoryId, snapshotId, include: ['dns', 'hosting'], healthPath, timeoutSeconds: healthPath === '/' ? 30 : 5 };
  const preview = accepted(await fixture.call('POST', fixture.endpoint('/restore/preview'), input));
  return accepted(await fixture.call('POST', fixture.endpoint('/backup-operations'), { kind: 'restore', ...input, expectedPreviewDigest: preview.previewDigest, confirmation: preview.confirmation }), 202);
}

test.describe('T887 real owned DNS and hosting restore', () => {
  let actor, fixture, projectName, key;
  async function site() {
    if (!fixture) {
      key = 't887-dns-hosting-' + projectName;
      fixture = await createOwnedFixture(actor, { key, runtime: 'static', dns: { mode: 'local' } });
      await uploadOwned(fixture, 'index.html', '<!doctype html><p>T887 owned DNS hosting restore</p>');
      expect((await fixture.http('/')).status).toBe(200);
    }
    return fixture;
  }
  test.beforeAll(async ({}, info) => { projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = await apiContext(); });
  test.afterAll(async () => {
    try {
      if (key) {
        const ledger = fixture ? await fixture.cleanup() : await cleanupOwnedFixture(actor, { key });
        const absent = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
        expect(absent.unixUserExists).toBe(false); expect(absent.unixGroupExists).toBe(false);
        expect(absent.roots.every(value => !value.exists)).toBe(true); expect(absent.nginxFiles.every(value => !value.exists)).toBe(true);
        expect(absent.fpmFiles).toEqual([]); expect(absent.sockets).toEqual([]); expect(absent.mounts).toEqual([]);
      }
    } finally { await actor?.api.dispose(); }
  });

  test('@mutation reconciles only the current owned ledger DNS hosting and health artifacts', async () => {
    test.setTimeout(300000); const f = await site(), before = await domain(f), owner = '_yprestore_' + randomBytes(6).toString('hex');
    const filename = 'yp-t887-health-' + randomBytes(6).toString('hex') + '.html';
    f.record('dns-hosting.recovery.intent', { owner, filename, originalSettings: before.nginxSettings });
    f.record('openAcceptance', { historicalCommit: 'ba33f4a8^', historicalFile: '16-native-hosting-dns-restore.spec.js',
      historicalTitle: '@mutation source recovers only the owned DNS and health-file artifacts left by the earlier Nginx receipt conflict',
      reason: 'The original interrupted October candidate and receipt conflict are intentionally not restored. Current normal API reconciliation is exercised with this exact fresh ledger.',
      requiredChannel: 'Owned interrupted current-run reconciliation through normal API' });
    try {
      await writeTxt(f, owner, 'T887-own-recovery'); await uploadOwned(f, filename, '<p>T887 own recovery health</p>');
      await publish(f, { ...before.nginxSettings, clientMaxBodySizeMb: 17 });
      expect((await config(f)).clientMaxBodySizeMb).toBe(17);
      await publish(f, before.nginxSettings); expect((await config(f)).clientMaxBodySizeMb).not.toBe(17);
      await deleteTxt(f, owner); expect((await zone(f)).rrsets.some(rrset => recordMatches(f, owner, rrset))).toBe(false);
      await f.deleteFile(filename);
      expect(accepted(await f.call('GET', f.endpoint('/files'))).entries.some(entry => entry.name === filename)).toBe(false);
      expect((await f.http('/')).status).toBe(200); f.record('dns-hosting.recovery.current-ledger', { verified: true });
    } finally { await publish(f, before.nginxSettings); await deleteTxt(f, owner); }
  });

  test('@mutation repository create with initialization returns a ready catalog and a physically valid repository', async () => {
    test.setTimeout(240000); const f = await site(); let repository, failure;
    const name = 'ypaudit-t887-init-' + f.ledger.nonce;
    const observations = [], pollerFailures = [];
    let createStartedAt = null, createFinishedAt = null, pollers = [];
    f.record('backup.repository.intent', { name, initialize: true });
    try {
      const baseline = accepted(await f.call('GET', '/api/panel/backups/repositories'));
      expect(Array.isArray(baseline)).toBe(true);
      expect(baseline.some(row => row.name === name)).toBe(false);
      const baselineIds = new Set(baseline.map(row => row.id));
      createStartedAt = Date.now();
      // Exactly one mutation. Concurrent catalog reads never replay a lost POST.
      const creation = f.call('POST', '/api/panel/backups/repositories', {
        name, backend: 'local', password: randomBytes(36).toString('base64url'), initialize: true,
      }).finally(() => { createFinishedAt = Date.now(); });
      const pollUntil = createStartedAt + 15000;
      pollers = [1, 2].map(async poller => {
        let lastStartedAt = null, lastPendingAtStart = null;
        try {
          for (let attempt = 0; attempt < 100 && createFinishedAt === null && Date.now() < pollUntil; attempt++) {
            const startedAt = Date.now(), postPendingAtStart = createFinishedAt === null;
            lastStartedAt = startedAt; lastPendingAtStart = postPendingAtStart;
            const reply = await f.call('GET', '/api/panel/backups/repositories', undefined, { requestTimeoutMs: 10000, retryGets: false });
            const finishedAt = Date.now(), postPendingAtEnd = createFinishedAt === null;
            const rows = Array.isArray(reply.data) ? reply.data : [];
            const ownRows = rows.filter(row => row.name === name).map(row => ({
              id: /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.id ?? '') ? row.id : null,
              status: ['uninitialized', 'ready', 'error'].includes(row.status) ? row.status : 'unknown',
            }));
            const observation = { poller, attempt, startedAt, finishedAt, postPendingAtStart, postPendingAtEnd,
              httpStatus: reply.status, ownRows };
            observations.push(observation); f.record('backup.repository.concurrent-list', observation);
            accepted(reply); expect(Array.isArray(reply.data)).toBe(true);
            expect(ownRows.every(row => row.id !== null && !baselineIds.has(row.id))).toBe(true);
            if (createFinishedAt !== null) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (error) {
          pollerFailures.push(error);
          f.record('backup.repository.concurrent-list-failure', { poller, startedAt: lastStartedAt, finishedAt: Date.now(),
            postPendingAtStart: lastPendingAtStart, postPendingAtEnd: createFinishedAt === null,
            errorKind: error.name, errorCode: error.code ?? null });
        }
      });
      const created = accepted(await creation, 201);
      expect(created.name).toBe(name); expect(created.backend).toBe('local'); expect(created.serverId).toBe(f.ledger.serverId);
      expect(created.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
      expect(baselineIds.has(created.id)).toBe(false); expect(typeof created.target).toBe('string'); expect(created.target.length).toBeGreaterThan(0);
      repository = created;
      f.record('backup.repository.owned', { repositoryId: repository.id, target: repository.target, name });
      await Promise.all(pollers);
      if (pollerFailures.length) throw pollerFailures[0];
      const concurrent = observations.filter(row => row.httpStatus === 200 && row.postPendingAtStart && row.postPendingAtEnd);
      expect(concurrent.length, 'At least one real catalog response must return while the single create POST is pending').toBeGreaterThan(0);
      const ownUninitialized = concurrent.some(row => row.ownRows.some(own => own.id === repository.id && own.status === 'uninitialized'));
      f.record('backup.repository.concurrent-init-window', { repositoryId: repository.id, createStartedAt, createFinishedAt,
        successfulListsWhilePending: concurrent.length, ownUninitializedObserved: ownUninitialized, causalAcceptance: ownUninitialized ? 'observed' : 'open' });
      if (!ownUninitialized) f.record('openAcceptance', { id: 'T893.actual-uninitialized-list-window',
        reason: 'Concurrent real catalog reads completed before create returned, but this run did not observe its owned row uninitialized during that window.',
        requiredChannel: 'A real native initialization window with the exact owned uninitialized catalog row; no fake delay or engine response' });
      const readback = accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id));
      const checked = await f.call('POST', '/api/panel/backups/repositories/' + repository.id + '/check', {});
      const snapshots = accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id + '/snapshots'));
      f.record('backup.repository.initialize-contract', { createStatus: repository.status, readbackStatus: readback.status,
        physicalCheckHttpStatus: checked.status, physicalCheckErrorCode: checked.body?.error?.code ?? null,
        emptySnapshots: Array.isArray(snapshots) && snapshots.length === 0 });
      expect(repository.status).toBe('ready'); expect(readback.status).toBe('ready'); expect(checked.status, checked.body?.error?.code).toBe(200);
      expect(snapshots).toEqual([]);
    } catch (error) { failure = error; }
    finally {
      await Promise.all(pollers);
      if (createStartedAt !== null && !repository) f.record('backup.repository.create-unconfirmed', { name, createStartedAt, createFinishedAt,
        postReplayed: false, observedOwnRepositoryIds: [...new Set(observations.flatMap(row => row.ownRows.map(own => own.id)))], automaticCleanupAttempted: false });
    }
    if (repository) try {
      const current = accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id));
      expect(current.id).toBe(repository.id); expect(current.name).toBe(name); expect(current.target).toBe(repository.target);
      expect(current.serverId).toBe(f.ledger.serverId); expect(current.backend).toBe('local');
      accepted(await f.call('DELETE', '/api/panel/backups/repositories/' + repository.id));
      expect((await f.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe(404);
      f.record('backup.repository.physical-cleanup-required', { repositoryId: repository.id, target: repository.target, name: repository.name, registryAbsent: true });
    } catch (error) { f.record('backup.repository.cleanup-failure', { errorKind: error.name }); failure ??= error; }
    if (failure) throw failure;
  });

  test('@mutation restores actual TXT Nginx bytes and settings twice and rolls back a real failed health check', async () => {
    test.setTimeout(480000); const f = await site(), before = await domain(f), initial = await config(f);
    expect(initial.bytes).toBeGreaterThan(0); expect(initial.sha256).toMatch(/^[a-f0-9]{64}$/);
    const owner = '_yprestore_' + randomBytes(6).toString('hex'), value = 'T887-DNS-' + randomBytes(12).toString('hex');
    const matches = rrset => recordMatches(f, owner, rrset); expect((await zone(f)).rrsets.some(matches)).toBe(false);
    let repository, healthFile, failure;
    f.record('dns-hosting.restore.intent', { owner, originalSettings: before.nginxSettings, originalConfigSha256: initial.sha256 });
    try {
      await writeTxt(f, owner, value); expect((await zone(f)).rrsets.find(matches)?.records.map(record => record.value)).toContain(value);
      const name = 'ypaudit-t887-dns-' + f.ledger.nonce;
      f.record('backup.repository.intent', { name, websiteId: f.ledger.websiteId });
      repository = accepted(await f.call('POST', '/api/panel/backups/repositories', { name, backend: 'local', password: randomBytes(36).toString('base64url'), initialize: false }), 201);
      f.record('backup.repository.owned', { repositoryId: repository.id, target: repository.target, name });
      expect(repository.status).toBe('uninitialized');
      const initialized = accepted(await f.call('POST', '/api/panel/backups/repositories/' + repository.id + '/init', {})); expect(initialized.status).toBe('ready');
      accepted(await f.call('POST', '/api/panel/backups/repositories/' + repository.id + '/check', {}));
      expect(accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe('ready');
      f.record('backup.repository.explicit-init-check', { verified: true, repositoryId: repository.id });
      const preview = accepted(await f.call('POST', f.endpoint('/backup/preview'), { repositoryId: repository.id }));
      const backup = accepted(await f.call('POST', f.endpoint('/backup-operations'), { kind: 'backup', repositoryId: repository.id, expectedPreviewDigest: preview.backupSetDigest, confirmation: preview.confirmation, tags: ['t887-dns-' + f.ledger.nonce] }), 202);
      const snapshotId = (await finished(f, backup)).result?.snapshot?.snapshotId; expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
      f.record('backup.snapshot.owned', { repositoryId: repository.id, snapshotId });
      for (let pass = 1; pass <= 2; pass++) {
        await writeTxt(f, owner, value + '-CHANGED-' + pass); await publish(f, { ...before.nginxSettings, clientMaxBodySizeMb: 17 });
        const changed = await config(f); expect(changed.clientMaxBodySizeMb).toBe(17); expect(changed.sha256).not.toBe(initial.sha256);
        const operation = await restoreSnapshot(f, repository.id, snapshotId); await finished(f, operation);
        expect((await config(f)).sha256).toBe(initial.sha256);
        expect((await domain(f)).nginxSettings).toEqual(before.nginxSettings);
        expect((await zone(f)).rrsets.find(matches)?.records.map(record => record.value)).toContain(value);
        expect((await f.http('/')).status).toBe(200);
        f.record('dns-hosting.restore.real', { verified: true, pass, snapshotId, operationId: operation.id, configSha256: initial.sha256 });
      }
      healthFile = 'yp-t887-health-' + randomBytes(6).toString('hex') + '.html';
      f.record('dns-hosting.bad-health.intent', { filename: healthFile }); await uploadOwned(f, healthFile, '<p>T887 unreadable health</p>');
      accepted(await f.call('POST', f.endpoint('/files/permissions'), { path: healthFile, mode: '0600' }));
      expect((await f.http('/' + healthFile)).status).toBe(403);
      const preserve = value + '-PRESERVE'; await writeTxt(f, owner, preserve); await publish(f, { ...before.nginxSettings, clientMaxBodySizeMb: 17 });
      const changed = await config(f), operation = await restoreSnapshot(f, repository.id, snapshotId, '/' + healthFile);
      const result = await finished(f, operation, 'rolled_back'); expect(result.result?.rollbackReason).toBe('health_check_failed');
      expect((await config(f)).sha256).toBe(changed.sha256);
      expect((await domain(f)).nginxSettings.clientMaxBodySizeMb).toBe(17);
      expect((await zone(f)).rrsets.find(matches)?.records.map(record => record.value)).toContain(preserve);
      expect((await f.http('/')).status).toBe(200); f.record('dns-hosting.rollback.real', { verified: true, operationId: operation.id, httpStatus: 403 });
    } catch (error) { failure = error; }
    {
      const failures = [];
      for (const cleanup of [() => publish(f, before.nginxSettings), () => deleteTxt(f, owner), ...(healthFile ? [() => f.deleteFile(healthFile)] : []),
        ...(repository ? [async () => { accepted(await f.call('DELETE', '/api/panel/backups/repositories/' + repository.id));
          expect((await f.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe(404);
          f.record('backup.repository.physical-cleanup-required', { repositoryId: repository.id, target: repository.target, name: repository.name, registryAbsent: true }); }] : [])]) {
        try { await cleanup(); } catch (error) { failures.push(error.name); failure ??= error; }
      }
      if (failures.length) f.record('dns-hosting.cleanup-failure', { errorKinds: failures });
    }
    if (failure) throw failure;
  });
});
