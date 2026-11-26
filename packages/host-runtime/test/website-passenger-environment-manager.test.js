import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWebsitePassengerEnvironmentManager, WebsitePassengerEnvironmentError } from '../src/website-passenger-environment-manager.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const includePath = `/etc/yunpanel/passenger-env/${applicationId}.conf`;

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    lstatFn: async (target) => {
      if (!files.has(target)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return {
        uid: 0,
        gid: 0,
        mode: 0o100600,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    mkdirFn: async () => {},
    readFileFn: async (target) => {
      if (!files.has(target)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(target);
    },
    writeFileFn: async (target, content) => { files.set(target, content); },
    renameFn: async (from, to) => {
      if (!files.has(from)) throw new Error('rename source missing');
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmFn: async (target) => { files.delete(target); },
  };
}

function spec(overrides = {}) {
  return {
    applicationId,
    environmentRevision: 3,
    values: {
      API_TOKEN: 'secret-value',
      PUBLIC_NAME: 'yunpanel',
    },
    ...overrides,
  };
}

test('Passenger environment writes bounded env vars without leaking values into public evidence', async () => {
  const fs = memoryFs();
  const manager = createWebsitePassengerEnvironmentManager(fs);
  const applied = await manager.apply(spec(), { operationId });

  assert.equal(applied.satisfied, true);
  assert.equal(applied.environmentRevision, 3);
  assert.equal(applied.environmentInclude, includePath);
  assert.equal(applied.variableCount, 2);
  assert.equal(applied.ownedByOperation, true);
  assert.equal(Object.hasOwn(applied, 'values'), false);
  assert.equal(Object.values(applied).includes('secret-value'), false);
  assert.match(fs.files.get(includePath), /passenger_env_var API_TOKEN "secret-value";/);
  assert.match(fs.files.get(includePath), /passenger_env_var PUBLIC_NAME "yunpanel";/);

  const pinned = await manager.operation(applicationId, operationId);
  assert.equal(pinned.environmentRevision, 3);
  assert.equal(pinned.includeSha256, applied.includeSha256);
  assert.equal((await manager.inspect(spec(), { operationId })).satisfied, true);
});

test('Passenger environment compensation restores exact pre-operation include state', async () => {
  const previous = '# existing managed include\npassenger_env_var OLD "value";\n';
  const fs = memoryFs({ [includePath]: previous });
  const manager = createWebsitePassengerEnvironmentManager(fs);
  const applied = await manager.apply(spec(), { operationId });
  assert.notEqual(fs.files.get(includePath), previous);

  const pending = await manager.inspectCompensation(spec(), {
    operationId,
    ownedByOperation: applied.ownedByOperation,
  });
  assert.equal(pending.satisfied, false);

  const compensated = await manager.compensate(spec(), {
    operationId,
    ownedByOperation: applied.ownedByOperation,
  });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.restored, true);
  assert.equal(fs.files.get(includePath), previous);
  assert.equal((await manager.inspectCompensation(spec(), {
    operationId,
    ownedByOperation: true,
  })).satisfied, true);
});

test('Passenger environment does not claim ownership when the exact include pre-existed', async () => {
  const seed = memoryFs();
  const first = createWebsitePassengerEnvironmentManager(seed);
  const applied = await first.apply(spec(), { operationId });
  const exact = seed.files.get(includePath);

  const secondFs = memoryFs({ [includePath]: exact });
  const second = createWebsitePassengerEnvironmentManager(secondFs);
  const result = await second.apply(spec(), { operationId: '216e4db8-468b-4e2f-a021-3ab31e0f4123' });
  assert.equal(result.satisfied, true);
  assert.equal(result.ownedByOperation, false);
  assert.equal((await second.compensate(spec(), {
    operationId: '216e4db8-468b-4e2f-a021-3ab31e0f4123',
    ownedByOperation: false,
  })).satisfied, true);
  assert.equal(secondFs.files.get(includePath), exact);
});

test('Passenger environment rejects Passenger-managed environment keys', async () => {
  const manager = createWebsitePassengerEnvironmentManager(memoryFs());
  await assert.rejects(
    manager.apply(spec({ values: { NODE_ENV: 'development' } }), { operationId }),
    (error) => error instanceof WebsitePassengerEnvironmentError
      && error.code === 'website_passenger_environment_reserved_key',
  );
});

async function realRetirementFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yp-passenger-retirement-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const includeRoot = path.join(root, 'includes'), receiptRoot = path.join(root, 'receipts');
  await mkdir(includeRoot, { mode: 0o700 });
  const manager = createWebsitePassengerEnvironmentManager({ includeRoot, receiptRoot,
    ownerUid: process.getuid(), ownerGid: process.getgid() });
  assert.equal(typeof manager.retire, 'function', 'normal removal needs a physical Passenger include retirement path');
  const application = randomUUID(), sourceOperationId = randomUUID(), releaseId = randomUUID();
  const applied = await manager.apply({ applicationId: application, environmentRevision: 0, values: {} }, { operationId: sourceOperationId });
  const authority = { websiteId: randomUUID(), applicationId: application, serverId: randomUUID(),
    removalId: 'ws-rem-' + randomUUID(), sourceOperationId, releaseId,
    savedRevision: 0, appliedRevision: 0, appliedReleaseId: releaseId,
    originalIncludeSha256: applied.includeSha256, initialReleaseId: null };
  const target = path.join(includeRoot, application + '.conf');
  const journal = path.join(root, 'retirement-checkpoints.jsonl');
  const checkpoints = [];
  async function checkpoint(proof) {
    // Real disk checkpoint plus actual before-effect observation; not a host/service stub.
    if (proof.state === 'prepared' && proof.hadInclude) assert.equal((await lstat(target)).isFile(), true);
    await writeFile(journal, JSON.stringify(proof) + '\n', { mode: 0o600, flag: 'a' });
    checkpoints.push(proof);
  }
  return { root, manager, authority, target, checkpoints, checkpoint, journal };
}

test('real filesystem Passenger retirement checkpoints the exact include before normal deletion', async t => {
  const f = await realRetirementFixture(t);
  const original = await readFile(f.target);
  const result = await f.manager.retire(f.authority, { checkpoint: f.checkpoint });
  assert.equal(result.satisfied, true); assert.equal(result.includeAbsent, true);
  assert.equal(result.applicationId, f.authority.applicationId);
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  assert.deepEqual(f.checkpoints.map(p => p.state), ['prepared', 'retired']);
  assert.equal(f.checkpoints[0].includeSha256, f.authority.originalIncludeSha256);
  assert.equal((await readFile(f.journal, 'utf8')).includes(original.toString()), false);
  const again = await f.manager.retire(f.authority, { priorReceipt: result, checkpoint: f.checkpoint });
  assert.deepEqual(again, result); assert.equal(f.checkpoints.length, 2);
  const laterRelease = randomUUID();
  const zeroEffect = await f.manager.retire({ ...f.authority, releaseId: laterRelease, appliedReleaseId: laterRelease,
    appliedRevision: 1, savedRevision: 1 }, { priorReceipt: result, checkpoint: f.checkpoint });
  assert.deepEqual(zeroEffect, result); assert.equal(f.checkpoints.length, 2);
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
});

test('real filesystem retirement uses current applied bytes when saved revision is newer', async t => {
  const f = await realRetirementFixture(t);
  await f.manager.apply({ applicationId: f.authority.applicationId, environmentRevision: 2,
    values: { OWN_RETIREMENT_PROOF: randomUUID() } }, { operationId: randomUUID() });
  const current = await readFile(f.target);
  const authority = { ...f.authority, savedRevision: 3, appliedRevision: 2 };
  const result = await f.manager.retire(authority, { checkpoint: f.checkpoint });
  assert.equal(result.environmentRevision, 2); assert.notEqual(result.includeSha256, f.authority.originalIncludeSha256);
  assert.equal(result.includeAbsent, true); await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  assert.equal((await readFile(f.journal, 'utf8')).includes(current.toString()), false);
});

test('real disk checkpoint failure preserves the include and a later post-unlink failure reconciles the same journal', async t => {
  const f = await realRetirementFixture(t), original = await readFile(f.target);
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: () => writeFile(f.root, 'no overwrite') }), { code: 'EISDIR' });
  assert.deepEqual(await readFile(f.target), original);
  let prepared;
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: async proof => {
    if (proof.state === 'prepared') { await f.checkpoint(proof); prepared = proof; }
    else await writeFile(f.root, 'no overwrite');
  } }), { code: 'EISDIR' });
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  const recovered = await f.manager.retire({ ...f.authority, savedRevision: 1 }, { priorReceipt: prepared, checkpoint: f.checkpoint });
  assert.equal(recovered.retired, true); assert.equal(recovered.removalId, prepared.removalId);
  assert.deepEqual(f.checkpoints.map(p => p.state), ['prepared', 'retired']);
});

test('real filesystem retirement rejects changed applied revision and completed include reappearance', async t => {
  const f = await realRetirementFixture(t), original = await readFile(f.target);
  await assert.rejects(f.manager.retire({ ...f.authority, savedRevision: 1, appliedRevision: 1 }, { checkpoint: f.checkpoint }),
    e => e.code === 'website_passenger_environment_retirement_drift');
  assert.deepEqual(await readFile(f.target), original); assert.equal(f.checkpoints.length, 0);
  const retired = await f.manager.retire(f.authority, { checkpoint: f.checkpoint });
  await writeFile(f.target, original, { mode: 0o600, flag: 'wx' });
  await assert.rejects(f.manager.retire(f.authority, { priorReceipt: retired, checkpoint: f.checkpoint }),
    e => e.code === 'website_passenger_environment_retirement_drift');
  assert.deepEqual(await readFile(f.target), original);
});

test('real filesystem retirement rejects a symlink, hardlink and unsafe receipt without touching other include bytes', async t => {
  const f = await realRetirementFixture(t), original = await readFile(f.target), other = path.join(f.root, 'other.conf');
  await writeFile(other, original, { mode: 0o600, flag: 'wx' });
  await rm(f.target); await symlink(other, f.target);
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: f.checkpoint }), e => e instanceof WebsitePassengerEnvironmentError);
  assert.deepEqual(await readFile(other), original); assert.equal(f.checkpoints.length, 0);
  await rm(f.target); await link(other, f.target);
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: f.checkpoint }), e => e instanceof WebsitePassengerEnvironmentError);
  assert.deepEqual(await readFile(other), original); assert.equal(f.checkpoints.length, 0);
  await rm(f.target); await writeFile(f.target, original, { mode: 0o600, flag: 'wx' });
  await chmod(path.join(f.root, 'receipts', f.authority.sourceOperationId + '.json'), 0o644);
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: f.checkpoint }), e => e instanceof WebsitePassengerEnvironmentError);
  assert.deepEqual(await readFile(f.target), original); assert.equal(f.checkpoints.length, 0);
});

test('real FIFO include and original receipt are rejected without waiting for a writer', { timeout: 2000 }, async t => {
  const f = await realRetirementFixture(t), original = await readFile(f.target);
  await rm(f.target); await promisify(execFile)('/usr/bin/mkfifo', ['-m', '600', f.target]);
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: f.checkpoint }), e => e instanceof WebsitePassengerEnvironmentError);
  assert.equal((await lstat(f.target)).isFIFO(), true); assert.equal(f.checkpoints.length, 0);
  await rm(f.target); await writeFile(f.target, original, { mode: 0o600, flag: 'wx' });
  const receipt = path.join(f.root, 'receipts', f.authority.sourceOperationId + '.json');
  await rm(receipt); await promisify(execFile)('/usr/bin/mkfifo', ['-m', '600', receipt]);
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: f.checkpoint }), e => e instanceof WebsitePassengerEnvironmentError);
  assert.equal((await lstat(receipt)).isFIFO(), true); assert.deepEqual(await readFile(f.target), original);
  assert.equal(f.checkpoints.length, 0);
});

test('a persisted retirement receipt cannot carry extra values or malformed ownership metadata into a retry', async t => {
  const f = await realRetirementFixture(t), retired = await f.manager.retire(f.authority, { checkpoint: f.checkpoint });
  for (const priorReceipt of [
    { ...retired, values: { UNPUBLISHED: 'not-a-journal-field' } },
    { ...retired, authoritySnapshot: { ...retired.authoritySnapshot, values: {} } },
    { ...retired, fileIdentity: { ...retired.fileIdentity, uid: '999999' } },
    { ...retired, authoritySnapshot: { ...retired.authoritySnapshot, appliedRevision: null, appliedReleaseId: null, initialReleaseId: null } },
    { ...retired, retired: false },
  ]) await assert.rejects(f.manager.retire(f.authority, { priorReceipt, checkpoint: f.checkpoint }),
    e => e.code === 'website_passenger_environment_retirement_drift');
  assert.equal(f.checkpoints.length, 2); await assert.rejects(lstat(f.target), { code: 'ENOENT' });
});

test('initial unapplied bytes cannot authorize a different current release without an original-release witness', async t => {
  const f = await realRetirementFixture(t), before = await readFile(f.target);
  await assert.rejects(f.manager.retire({ ...f.authority, releaseId: randomUUID(), appliedRevision: null, appliedReleaseId: null }, { checkpoint: f.checkpoint }),
    e => e instanceof WebsitePassengerEnvironmentError);
  assert.deepEqual(await readFile(f.target), before); assert.equal(f.checkpoints.length, 0);
});

test('retirement rejects invalid UTF8 raw bytes rather than publishing a lossy text checksum', async t => {
  const f = await realRetirementFixture(t);
  const before = Buffer.concat([Buffer.from('# YunPanel Passenger environment ' + f.authority.applicationId + ' revision 1\npassenger_env_var OWN_BYTES "'), Buffer.from([255]), Buffer.from('";\n')]);
  await writeFile(f.target, before);
  await assert.rejects(f.manager.retire({ ...f.authority, savedRevision: 1, appliedRevision: 1 }, { checkpoint: f.checkpoint }),
    e => e instanceof WebsitePassengerEnvironmentError);
  assert.deepEqual(await readFile(f.target), before); assert.equal(f.checkpoints.length, 0);
});

for (const dimension of ['applied revision', 'release', 'initial witness']) {
  test('prepared retirement rejects current ' + dimension + ' drift before unlink or absent reconciliation', async t => {
    for (const alreadyAbsent of [false, true]) {
      const f = await realRetirementFixture(t), original = await readFile(f.target);
      const captured = dimension === 'initial witness' ? { ...f.authority, releaseId: f.authority.sourceOperationId,
        appliedRevision: null, appliedReleaseId: null, initialReleaseId: f.authority.sourceOperationId } : f.authority;
      let prepared;
      await assert.rejects(f.manager.retire(captured, { checkpoint: async proof => {
        if (proof.state === 'prepared') { await f.checkpoint(proof); prepared = proof; }
        if (!alreadyAbsent || proof.state === 'retired') await writeFile(f.root, 'actual checkpoint EISDIR');
      } }), { code: 'EISDIR' });
      const current = { ...captured };
      if (dimension === 'applied revision') { current.savedRevision = 1; current.appliedRevision = 1; }
      if (dimension === 'release') { current.releaseId = randomUUID(); current.appliedReleaseId = current.releaseId; }
      if (dimension === 'initial witness') current.initialReleaseId = null;
      await assert.rejects(f.manager.retire(current, { priorReceipt: prepared, checkpoint: f.checkpoint }),
        error => error.code === 'website_passenger_environment_retirement_drift');
      assert.deepEqual(f.checkpoints.map(row => row.state), ['prepared']);
      if (alreadyAbsent) await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      else assert.deepEqual(await readFile(f.target), original);
    }
  });
}

test('prepared retirement permits a newer saved draft while the same applied authority and actual bytes remain', async t => {
  const f = await realRetirementFixture(t); let prepared;
  await assert.rejects(f.manager.retire(f.authority, { checkpoint: async proof => {
    await f.checkpoint(proof); prepared = proof; await writeFile(f.root, 'actual checkpoint EISDIR');
  } }), { code: 'EISDIR' });
  const result = await f.manager.retire({ ...f.authority, savedRevision: 1 }, { priorReceipt: prepared, checkpoint: f.checkpoint });
  assert.equal(result.retired, true); assert.equal(result.environmentRevision, 0);
  assert.equal(result.authoritySnapshot.savedRevision, 0); // Captured authority stays historical, never materializes draft values.
  assert.deepEqual(f.checkpoints.map(row => row.state), ['prepared', 'retired']);
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
});

test('real filesystem retirement removes the exact provisioning include of an Application that never got a release', async t => {
  // Provisioning stopped before its first release (failed health check): no release and no applied environment.
  const f = await realRetirementFixture(t);
  const authority = { ...f.authority, releaseId: null, appliedRevision: null, appliedReleaseId: null, initialReleaseId: null };
  let prepared;
  await assert.rejects(f.manager.retire(authority, { checkpoint: async proof => {
    await f.checkpoint(proof); prepared = proof; await writeFile(f.root, 'actual checkpoint EISDIR');
  } }), { code: 'EISDIR' });
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.includeSha256, f.authority.originalIncludeSha256);
  assert.ok((await readFile(f.target)).length > 0);
  const result = await f.manager.retire(authority, { priorReceipt: prepared, checkpoint: f.checkpoint });
  assert.equal(result.retired, true); assert.equal(result.includeAbsent, true); assert.equal(result.environmentRevision, 0);
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  assert.deepEqual(f.checkpoints.map(row => row.state), ['prepared', 'retired']);
  assert.deepEqual(await f.manager.retire(authority, { priorReceipt: result, checkpoint: f.checkpoint }), result);
  assert.equal(f.checkpoints.length, 2);
});

test('unreleased retirement authority rejects include bytes that are not the owned provisioning bytes', async t => {
  const f = await realRetirementFixture(t);
  const authority = { ...f.authority, releaseId: null, appliedRevision: null, appliedReleaseId: null, initialReleaseId: null };
  await f.manager.apply({ applicationId: f.authority.applicationId, environmentRevision: 1,
    values: { OTHER_WRITER_PROOF: randomUUID() } }, { operationId: randomUUID() });
  const before = await readFile(f.target);
  await assert.rejects(f.manager.retire({ ...authority, savedRevision: 1 }, { checkpoint: f.checkpoint }),
    e => e.code === 'website_passenger_environment_retirement_drift');
  await assert.rejects(f.manager.retire({ ...authority, releaseId: randomUUID() }, { checkpoint: f.checkpoint }),
    e => e.code === 'website_passenger_environment_retirement_drift');
  assert.deepEqual(await readFile(f.target), before); assert.equal(f.checkpoints.length, 0);
});
