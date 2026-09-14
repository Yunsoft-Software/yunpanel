import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canBeginCompensationInOrder,
  findBlockingLaterCompensationStep,
} from '../src/website-provisioning-compensation-order.js';

function operation(later) {
  return {
    steps: [
      { id: 'mutation', state: 'succeeded', compensation: { state: 'pending' } },
      { id: 'later', ...later },
    ],
  };
}

test('terminal read-only provisioning steps do not block earlier compensation', () => {
  for (const state of ['succeeded', 'failed']) {
    const value = operation({ state, compensation: { state: 'not_required' } });
    assert.equal(findBlockingLaterCompensationStep(value, 'mutation'), null);
    assert.equal(canBeginCompensationInOrder(value, 'mutation'), true);
  }
});

test('in-flight read-only provisioning still blocks concurrent destructive compensation', () => {
  for (const state of ['applying', 'compensating']) {
    const value = operation({ state, compensation: { state: 'not_required' } });
    assert.equal(findBlockingLaterCompensationStep(value, 'mutation')?.id, 'later');
    assert.equal(canBeginCompensationInOrder(value, 'mutation'), false);
  }
});

test('terminal mutation steps keep reverse-order compensation strict', () => {
  for (const state of ['succeeded', 'failed']) {
    const value = operation({ state, compensation: { state: 'pending' } });
    assert.equal(findBlockingLaterCompensationStep(value, 'mutation')?.id, 'later');
    assert.equal(canBeginCompensationInOrder(value, 'mutation'), false);
  }
});
