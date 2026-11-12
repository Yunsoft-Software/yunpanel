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
    f.record('backup.repository.intent', { name, initialize: true });
    try {
      repository = accepted(await f.call('POST', '/api/panel/backups/repositories', { name, backend: 'local', password: randomBytes(36).toString('base64url'), initialize: true }), 201);
      f.record('backup.repository.owned', { repositoryId: repository.id, target: repository.target, name });
      const readback = accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id));
      const checked = await f.call('POST', '/api/panel/backups/repositories/' + repository.id + '/check', {});
      f.record('backup.repository.initialize-contract', { createStatus: repository.status, readbackStatus: readback.status,
        physicalCheckHttpStatus: checked.status, physicalCheckErrorCode: checked.body?.error?.code ?? null });
      expect(repository.status).toBe('ready'); expect(readback.status).toBe('ready'); expect(checked.status, checked.body?.error?.code).toBe(200);
    } catch (error) { failure = error; }
    if (repository) try {
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
