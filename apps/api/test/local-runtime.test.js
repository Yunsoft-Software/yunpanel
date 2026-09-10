import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocalRuntime, LocalRuntimeError } from '../src/local-runtime.js';

const serverId = 'server-1';
const hostname = 'host-1.example.local';
const boundServer = {
  id: serverId,
  hostname,
  executionMode: 'local',
  localBoundAt: '2026-09-10T00:00:00.000Z',
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(overrides = {}) {
  const events = [];
  let executorOptions;
  const registry = overrides.registry ?? {
    getServer: async () => ({ ...boundServer }),
    updateLocalSnapshot: async (input) => {
      events.push(['snapshot', input]);
      return { ...boundServer, localRuntimeVersion: input.runtimeVersion };
    },
  };
  const lock = {
    release: async () => { events.push(['lock.release']); return true; },
  };
  const acquireLock = overrides.acquireLock ?? (async (input) => {
    events.push(['lock.acquire', input]);
    return lock;
  });
  const executor = overrides.executor ?? {
    start: () => { events.push(['executor.start']); },
    stop: async () => { events.push(['executor.stop']); },
  };
  const executorFactory = overrides.executorFactory ?? ((options) => {
    executorOptions = options;
    events.push(['executor.create']);
    return executor;
  });
  const hostOperations = overrides.hostOperations ?? {
    operations: ['system.packages.inspect'],
    supports: (operation) => operation === 'system.packages.inspect',
    executeOperation: async (operation, payload) => ({ operation, payload }),
  };
  const reconcile = overrides.reconcile ?? (async () => ({ reconciled: true, error: null }));

  return {
    events,
    registry,
    acquireLock,
    executorFactory,
    hostOperations,
    reconcile,
    jobRegistry: { listJobs: async () => [], claimNext: async () => null, complete: async () => null },
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    getExecutorOptions: () => executorOptions,
  };
}

async function startWith(fx, extra = {}) {
  return startLocalRuntime({
    serverId,
    hostname,
    runtimeVersion: '0.3.0',
    lockPath: '/var/lib/yunpanel/control-plane/local-executor.lock',
    registry: fx.registry,
    jobRegistry: fx.jobRegistry,
    domainRegistry: fx.domainRegistry,
    certificateRegistry: fx.certificateRegistry,
    applicationRegistry: fx.applicationRegistry,
    hostOperations: fx.hostOperations,
    executorFactory: fx.executorFactory,
    acquireLock: fx.acquireLock,
    reconcile: fx.reconcile,
    ...extra,
  });
}

test('local runtime acquires ownership, refreshes the bound server and then starts the executor', async () => {
  const fx = fixture();
  const runtime = await startWith(fx);
  assert.deepEqual(fx.events.map((event) => event[0]), ['lock.acquire', 'executor.create', 'snapshot', 'executor.start']);
  assert.equal(runtime.serverId, serverId);
  assert.equal(runtime.hostname, hostname);
  assert.deepEqual(runtime.operations, ['system.packages.inspect']);
  assert.equal(runtime.failure(), null);

  const options = fx.getExecutorOptions();
  assert.equal(options.supportsOperation('system.packages.inspect'), true);
  assert.equal(options.supportsOperation('app.node.deploy'), false);
  assert.deepEqual(await options.executeOperation('system.packages.inspect', { probe: true }), {
    operation: 'system.packages.inspect',
    payload: { probe: true },
  });

  await runtime.stop();
  assert.deepEqual(fx.events.slice(-2).map((event) => event[0]), ['executor.stop', 'lock.release']);
  await runtime.stop();
  assert.equal(fx.events.filter((event) => event[0] === 'lock.release').length, 1);
});

test('local runtime refreshes its server snapshot before the registry offline threshold', async () => {
  const fx = fixture();
  const runtime = await startWith(fx, { snapshotIntervalMs: 50 });
  await delay(130);
  const beforeStop = fx.events.filter((event) => event[0] === 'snapshot').length;
  assert.ok(beforeStop >= 2);
  await runtime.stop();
  await delay(80);
  assert.equal(fx.events.filter((event) => event[0] === 'snapshot').length, beforeStop);
});

test('snapshot refresh failure stops host execution, releases ownership and reports safe metadata', async () => {
  let snapshots = 0;
  const errors = [];
  const fx = fixture({
    registry: {
      getServer: async () => ({ ...boundServer }),
      updateLocalSnapshot: async (input) => {
        snapshots += 1;
        fx.events.push(['snapshot', input]);
        if (snapshots > 1) throw new Error('/private/path SECRET=must-not-leak');
        return { ...boundServer, localRuntimeVersion: input.runtimeVersion };
      },
    },
  });
  const runtime = await startWith(fx, { snapshotIntervalMs: 50, onError: (error) => errors.push(error) });
  await delay(120);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'local_runtime_snapshot_refresh_failed');
  assert.equal(errors[0].phase, 'snapshot');
  assert.equal(errors[0].jobId, null);
  assert.equal(errors[0].message.includes('SECRET'), false);
  assert.deepEqual(runtime.failure(), { code: 'local_runtime_snapshot_refresh_failed', phase: 'snapshot', jobId: null });
  assert.equal(fx.events.filter((event) => event[0] === 'executor.stop').length, 1);
  assert.equal(fx.events.filter((event) => event[0] === 'lock.release').length, 1);
  await runtime.stop();
  assert.equal(fx.events.filter((event) => event[0] === 'lock.release').length, 1);
});

test('local runtime never acquires the lock for an unbound or wrong-host server', async () => {
  for (const [server, code] of [
    [{ ...boundServer, executionMode: 'agent', localBoundAt: null }, 'local_server_not_bound'],
    [{ ...boundServer, hostname: 'another-host' }, 'local_server_hostname_mismatch'],
    [null, 'local_server_not_found'],
  ]) {
    let lockCalls = 0;
    const fx = fixture({
      registry: {
        getServer: async () => server,
        updateLocalSnapshot: async () => { throw new Error('must not update'); },
      },
      acquireLock: async () => { lockCalls += 1; throw new Error('must not lock'); },
    });
    await assert.rejects(
      startWith(fx),
      (error) => error instanceof LocalRuntimeError && error.code === code,
    );
    assert.equal(lockCalls, 0);
  }
});

test('local reconciliation false result is converted into an executor-halting exception', async () => {
  const fx = fixture({
    reconcile: async () => ({ reconciled: false, error: { code: 'reconcile_domain_failed' } }),
  });
  const runtime = await startWith(fx);
  await assert.rejects(
    fx.getExecutorOptions().reconcileCompletedJob({ id: 'job-1' }),
    (error) => error.code === 'reconcile_domain_failed',
  );
  await runtime.stop();
});

test('startup failure drains the executor and releases the ownership lock', async () => {
  const fx = fixture({
    executor: {
      start: () => { throw new Error('start failed'); },
      stop: async () => { fx.events.push(['executor.stop']); },
    },
  });

  await assert.rejects(
    startWith(fx),
    (error) => error instanceof LocalRuntimeError && error.code === 'local_runtime_start_failed',
  );
  assert.deepEqual(fx.events.slice(-2).map((event) => event[0]), ['executor.stop', 'lock.release']);
});

test('snapshot interval validation fails before lock acquisition', async () => {
  let lockCalls = 0;
  const fx = fixture({ acquireLock: async () => { lockCalls += 1; throw new Error('must not run'); } });
  await assert.rejects(startWith(fx, { snapshotIntervalMs: 61_000 }), (error) => error instanceof LocalRuntimeError && error.code === 'invalid_local_snapshot_interval');
  assert.equal(lockCalls, 0);
});
