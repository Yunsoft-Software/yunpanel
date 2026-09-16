import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dnsSecondaryPresentation,
  dnsSecondaryTargetPresentation,
} from '../src/workspace/dns-model.js';

test('Secondary DNS presentation fails closed for configured unsynced states', () => {
  assert.deepEqual(
    dnsSecondaryPresentation({ status: 'synced', ready: true }),
    { state: 'active', label: 'Secondary DNS senkron', ready: true, blocking: false, recovery: 'none' },
  );
  assert.deepEqual(
    dnsSecondaryPresentation({ status: 'disabled', ready: true }),
    { state: 'off', label: 'Secondary DNS kapalı', ready: true, blocking: false, recovery: 'none' },
  );

  for (const status of ['drift', 'unverifiable', 'primary_kind_required']) {
    const presentation = dnsSecondaryPresentation({ status, ready: false });
    assert.equal(presentation.ready, false);
    assert.equal(presentation.blocking, true);
    assert.equal(presentation.recovery, 'observe_only');
  }

  assert.equal(dnsSecondaryPresentation({ status: 'synced', ready: false }).blocking, true);
  assert.equal(dnsSecondaryPresentation(null).blocking, true);
});

test('Secondary DNS presentation honors backend health gate, severity and recovery policy', () => {
  assert.deepEqual(
    dnsSecondaryPresentation({
      status: 'primary_kind_required',
      ready: false,
      policy: { healthGate: 'block', severity: 'error', recovery: 'manual_intervention' },
    }),
    { state: 'error', label: 'Primary zone gerekli', ready: false, blocking: true, recovery: 'manual_intervention' },
  );
  assert.deepEqual(
    dnsSecondaryPresentation({
      status: 'drift',
      ready: false,
      policy: { healthGate: 'block', severity: 'error', recovery: 'observe_only' },
    }),
    { state: 'error', label: 'Secondary DNS serial farkı', ready: false, blocking: true, recovery: 'observe_only' },
  );
});

test('Secondary DNS target presentation distinguishes stale, ahead and unverifiable serials', () => {
  assert.deepEqual(
    dnsSecondaryTargetPresentation({ status: 'synced', ready: true }),
    { state: 'active', label: 'Senkron', ready: true },
  );
  assert.equal(dnsSecondaryTargetPresentation({ status: 'stale', ready: false }).state, 'warning');
  assert.equal(dnsSecondaryTargetPresentation({ status: 'ahead', ready: false }).state, 'error');
  assert.equal(dnsSecondaryTargetPresentation({ status: 'unverifiable', ready: false }).ready, false);
});
