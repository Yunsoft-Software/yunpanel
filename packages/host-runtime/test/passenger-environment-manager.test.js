import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPassengerEnvironmentManager,
  PassengerEnvironmentManagerError,
  passengerEnvironmentManagerInternals,
} from '../src/passenger-environment-manager.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '3cf62117-56b3-4db4-98d5-fd7282b2bb0c';
const runtime = {
  mode: 'production',
  port: 3123,
};
const sourceContent = [
  'NODE_ENV="production"',
  'HOST="127.0.0.1"',
  'PORT="3123"',
  `YUNPANEL_APPLICATION_ID="${applicationId}"`,
  'DATABASE_URL="mysql://user:p\\"a\\\\ss@localhost/db"',
  'PRICE="cost$5; #literal"',
  '',
].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-passenger-env-'));
  const sourceRoot = path.join(root, 'source');
  const includeRoot = path.join(root, 'include');
  const receiptRoot = path.join(root, 'receipt');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, `${applicationId}.env`), sourceContent, { mode: 0o600 });
  const manager = createPassengerEnvironmentManager({ sourceRoot, includeRoot, receiptRoot });
  return {
    root,
    sourceRoot,
    includeRoot,
    receiptRoot,
    manager,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('Passenger environment renderer escapes Nginx-sensitive values without exposing NODE_ENV twice', () => {
  const values = passengerEnvironmentManagerInternals.parseManagedEnvironment(sourceContent);
  const rendered = passengerEnvironmentManagerInternals.renderPassengerEnvironmentInclude(values);
  assert.doesNotMatch(rendered, /passenger_env_var NODE_ENV/);
  assert.match(rendered, /passenger_env_var HOST "127\.0\.0\.1";/);
  assert.match(rendered, /passenger_env_var PORT "3123";/);
  assert.match(rendered, /DATABASE_URL "mysql:\/\/user:p\\"a\\\\ss@localhost\/db";/);
  assert.match(rendered, /PRICE "cost\\\$5; #literal";/);
});

test('Passenger environment inspect stays secret-safe when include is missing', async () => {
  const f = await fixture();
  try {
    const result = await f.manager.inspect({ applicationId, runtime });
    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'passenger_environment_include_missing');
    assert.equal(result.sourceSha256.length, 64);
    assert.equal(JSON.stringify(result).includes('mysql://'), false);
    assert.equal(JSON.stringify(result).includes('cost$5'), false);
  } finally { await f.cleanup(); }
});

test('Passenger environment apply writes a root-private include and verifies it without returning secrets', async () => {
  const f = await fixture();
  try {
    const result = await f.manager.apply({ applicationId, runtime }, { operationId });
    assert.equal(result.satisfied, true);
    assert.equal(result.changed, true);
    assert.equal(result.ownedByOperation, true);
    assert.equal(JSON.stringify(result).includes('mysql://'), false);
    const includePath = path.join(f.includeRoot, `${applicationId}.conf`);
    const info = await stat(includePath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.uid, 0);
    assert.equal(info.gid, 0);
    const content = await readFile(includePath, 'utf8');
    assert.equal(content.includes('DATABASE_URL'), true);
    const inspected = await f.manager.inspect({
      applicationId,
      runtime,
      expectedSourceSha256: result.sourceSha256,
    });
    assert.equal(inspected.satisfied, true);
  } finally { await f.cleanup(); }
});

test('Passenger environment apply refuses when preview source checksum changed', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.manager.apply({ applicationId, runtime, expectedSourceSha256: 'a'.repeat(64) }, { operationId }),
      (error) => error instanceof PassengerEnvironmentManagerError
        && error.code === 'passenger_environment_source_changed',
    );
  } finally { await f.cleanup(); }
});

test('Passenger environment validation rejects managed runtime drift', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.manager.inspect({ applicationId, runtime: { ...runtime, port: 4555 } }),
      (error) => error instanceof PassengerEnvironmentManagerError
        && error.code === 'passenger_environment_source_drift',
    );
  } finally { await f.cleanup(); }
});

test('Passenger environment compensation restores the exact previous include', async () => {
  const f = await fixture();
  try {
    await mkdir(f.includeRoot, { recursive: true, mode: 0o700 });
    const includePath = path.join(f.includeRoot, `${applicationId}.conf`);
    const previous = 'passenger_env_var LEGACY "kept";\n';
    await writeFile(includePath, previous, { mode: 0o600 });
    await f.manager.apply({ applicationId, runtime }, { operationId });
    const pending = await f.manager.inspectCompensation({ applicationId }, { operationId });
    assert.equal(pending.satisfied, false);
    assert.equal(pending.reason, 'passenger_environment_compensation_pending');
    const restored = await f.manager.compensate({ applicationId }, { operationId });
    assert.equal(restored.satisfied, true);
    assert.equal(restored.restoredPrevious, true);
    assert.equal(await readFile(includePath, 'utf8'), previous);
  } finally { await f.cleanup(); }
});

test('Passenger environment retry retains operation ownership after a successful apply', async () => {
  const f = await fixture();
  try {
    const first = await f.manager.apply({ applicationId, runtime }, { operationId });
    assert.equal(first.ownedByOperation, true);
    const retried = await f.manager.apply({ applicationId, runtime }, { operationId });
    assert.equal(retried.satisfied, true);
    assert.equal(retried.changed, false);
    assert.equal(retried.ownedByOperation, true);
    assert.equal(retried.receiptVersion, 1);
  } finally { await f.cleanup(); }
});

test('Passenger environment apply restores previous include when postcondition fails', async () => {
  const f = await fixture();
  try {
    await mkdir(f.includeRoot, { recursive: true, mode: 0o700 });
    const includePath = path.join(f.includeRoot, `${applicationId}.conf`);
    const previous = 'passenger_env_var LEGACY "kept";\n';
    await writeFile(includePath, previous, { mode: 0o600 });
    let corruptCandidateOnce = true;
    const manager = createPassengerEnvironmentManager({
      sourceRoot: f.sourceRoot,
      includeRoot: f.includeRoot,
      receiptRoot: f.receiptRoot,
      renameFn: async (from, to) => {
        const { rename, chmod } = await import('node:fs/promises');
        await rename(from, to);
        if (to === includePath && corruptCandidateOnce) {
          corruptCandidateOnce = false;
          await chmod(to, 0o644);
        }
      },
    });
    await assert.rejects(
      manager.apply({ applicationId, runtime }, { operationId }),
      (error) => error instanceof PassengerEnvironmentManagerError
        && error.code === 'passenger_environment_write_unverified',
    );
    assert.equal(await readFile(includePath, 'utf8'), previous);
    const info = await stat(includePath);
    assert.equal(info.mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});
