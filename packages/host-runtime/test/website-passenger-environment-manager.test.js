import assert from 'node:assert/strict';
import test from 'node:test';
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
