import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMailDomainRemovalPhaseRouter,
  MailDomainRemovalPhaseRouterError,
} from '../src/mail-domain-removal-phase-router.js';

function phase(name, calls) {
  return {
    async execute(operation) {
      calls.push(name + ':execute:' + operation.status);
      return { name, mode: 'execute' };
    },
    async inspect(operation) {
      calls.push(name + ':inspect:' + operation.status);
      return { name, mode: 'inspect' };
    },
  };
}

function routerFixture() {
  const calls = [];
  const router = createMailDomainRemovalPhaseRouter({
    configPhase: phase('config', calls),
    cleanupPhase: phase('cleanup', calls),
    dataPhase: phase('data', calls),
    finalizePhase: phase('finalize', calls),
  });
  return { router, calls };
}

test('local removal routes every durable phase to its bounded adapter', async () => {
  const state = routerFixture();
  const cases = [
    ['pending', 'config'],
    ['disabling', 'config'],
    ['cleaning', 'cleanup'],
    ['backing_up', 'data'],
    ['deleting_data', 'data'],
    ['finalizing', 'finalize'],
  ];

  for (const [status, expected] of cases) {
    const result = await state.router.execute({ managementMode: 'local', status });
    assert.equal(result.name, expected);
  }

  assert.deepEqual(state.calls, cases.map(([status, expected]) => expected + ':execute:' + status));
});

test('external removal only routes metadata unlink phases to finalizer', async () => {
  const state = routerFixture();

  assert.equal(
    (await state.router.execute({ managementMode: 'external', status: 'pending' })).name,
    'finalize',
  );
  assert.equal(
    (await state.router.execute({ managementMode: 'external', status: 'finalizing' })).name,
    'finalize',
  );

  await assert.rejects(
    state.router.execute({ managementMode: 'external', status: 'cleaning' }),
    (error) => error instanceof MailDomainRemovalPhaseRouterError
      && error.code === 'mail_domain_removal_phase_not_executable',
  );
});

test('startup inspection routes interrupted local phases without executing mutation adapters', async () => {
  const state = routerFixture();
  const cases = [
    ['disabling', 'config'],
    ['cleaning', 'cleanup'],
    ['backing_up', 'data'],
    ['deleting_data', 'data'],
    ['finalizing', 'finalize'],
  ];

  for (const [status, expected] of cases) {
    const result = await state.router.inspect({ managementMode: 'local', status });
    assert.equal(result.name, expected);
    assert.equal(result.mode, 'inspect');
  }

  assert.deepEqual(state.calls, cases.map(([status, expected]) => expected + ':inspect:' + status));
});

test('pending phase cannot be inspected because no mutation intent has started', async () => {
  const state = routerFixture();

  await assert.rejects(
    state.router.inspect({ managementMode: 'local', status: 'pending' }),
    (error) => error instanceof MailDomainRemovalPhaseRouterError
      && error.code === 'mail_domain_removal_phase_not_inspectable',
  );

  assert.deepEqual(state.calls, []);
});

test('terminal or blocked states are never routed as executable phases', async () => {
  const state = routerFixture();

  for (const status of ['removed', 'blocked', 'failed']) {
    await assert.rejects(
      state.router.execute({ managementMode: 'local', status }),
      (error) => error instanceof MailDomainRemovalPhaseRouterError
        && error.code === 'mail_domain_removal_phase_not_executable',
    );
  }

  assert.deepEqual(state.calls, []);
});
