import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { claimFailureDiagnostic, safeClaimFailureFields } from '../src/jobs/local-claim-failure-diagnostic.js';

test('claim diagnostic rejects a switching accessor without reading it', () => {
  let reads = 0;
  const privateMarker = 'owned-private-' + randomUUID();
  const input = { causeClass: 'SyntaxError', causeCode: 'none' };
  Object.defineProperty(input, 'failureBoundary', { get() { return ++reads === 1 ? 'select_queued' : privateMarker; } });
  const result = safeClaimFailureFields(input);
  assert.deepEqual(result, {});
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
});

test('claim diagnostic rejects a throwing accessor without escaping', () => {
  let reads = 0;
  const input = { failureBoundary: 'claim_next', causeCode: 'none' };
  Object.defineProperty(input, 'causeClass', { get() { reads++; throw new Error('owned accessor must not run'); } });
  assert.doesNotThrow(() => assert.deepEqual(safeClaimFailureFields(input), {}));
  assert.equal(reads, 0);
});

test('claim diagnostic never reads poisoned names constructors or code getters and bounds unknown codes', () => {
  let reads = 0;
  const privateMarker = 'owned-private-' + randomUUID();
  const error = new Error(privateMarker);
  for (const key of ['name', 'constructor', 'code']) Object.defineProperty(error, key, { configurable: true, get() { reads++; throw new Error('owned getter must not run'); } });
  const result = claimFailureDiagnostic(error, 'select_queued');
  assert.deepEqual(result, { failureBoundary: 'select_queued', causeClass: 'Error', causeCode: 'unknown' });
  assert.equal(reads, 0);
  Object.defineProperty(error, 'code', { value: privateMarker });
  assert.equal(claimFailureDiagnostic(error, 'claim_next').causeCode, 'unknown');
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
});

test('claim diagnostic returns a detached finite own-data snapshot', () => {
  const input = { failureBoundary: 'claim_next', causeClass: 'SyntaxError', causeCode: 'none', message: 'owned unselected detail' };
  const result = safeClaimFailureFields(input);
  input.failureBoundary = 'owned changed value';
  input.causeCode = 'owned unknown code';
  assert.deepEqual(result, { failureBoundary: 'claim_next', causeClass: 'SyntaxError', causeCode: 'none' });
  assert.deepEqual(Object.keys(result).sort(), ['causeClass', 'causeCode', 'failureBoundary']);
});
