import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerAccess, enrollmentCanContinue } from '../src/owner-access.js';

const session = { user: { role: 'owner' }, security: { ownerMfaRequired: true, enrollmentRequired: true, managementAllowed: false } };
const ready = { ...session, security: { ...session.security, enrollmentRequired: false, managementAllowed: true } };

test('password-only sessions route to enrollment, verified sessions to management', () => {
  assert.equal(ownerAccess(session), 'enrollment');
  assert.equal(ownerAccess(ready), 'management');
});

test('missing or malformed policy metadata fails closed', () => {
  for (const value of [null, {}, { ...session, security: {} }, { ...session, security: { ...session.security, managementAllowed: 'true' } }]) assert.equal(ownerAccess(value), 'unknown');
});

test('non-Owners cannot render management even if metadata is inconsistent', () => {
  assert.equal(ownerAccess({ ...ready, user: { role: 'read_only' } }), 'denied');
});

test('recovery acknowledgement and busy state block leaving enrollment', () => {
  assert.equal(enrollmentCanContinue({ session }), false);
  assert.equal(enrollmentCanContinue({ session: ready, sensitive: true }), false);
  assert.equal(enrollmentCanContinue({ session: ready, busy: true }), false);
  assert.equal(enrollmentCanContinue({ session: ready }), true);
});

test('an expired or locally reset enrollment cannot be bypassed by a continue click', () => {
  assert.equal(enrollmentCanContinue({ session: ready }), true);
  assert.equal(enrollmentCanContinue({ session: { ...ready, security: session.security } }), false);
});

test('explicit optional development policy allows ordinary management', () => {
  assert.equal(ownerAccess({ ...ready, security: { ...ready.security, ownerMfaRequired: false } }), 'management');
});
