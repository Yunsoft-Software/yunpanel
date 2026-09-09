import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerAccess, enrollmentCanContinue, panelPermission } from '../src/owner-access.js';

const session = { user: { role: 'owner' }, security: { ownerMfaRequired: true, enrollmentRequired: true, managementAllowed: false }, access: { mode: 'self_service', permissions: [] } };
const ready = { ...session, security: { ...session.security, enrollmentRequired: false, managementAllowed: true }, access: { mode: 'management', permissions: ['*'] } };
const reader = { user: { role: 'read_only' }, security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: false }, access: { mode: 'read_only', permissions: ['servers.read', 'domains.read'] } };

test('password-only sessions route to enrollment, verified sessions to management', () => {
  assert.equal(ownerAccess(session), 'enrollment');
  assert.equal(ownerAccess(ready), 'management');
  assert.equal(ownerAccess(reader), 'read_only');
});

test('missing or malformed policy metadata fails closed', () => {
  for (const value of [null, {}, { ...session, security: {} }, { ...session, access: undefined }, { ...session, access: { mode: 'self_service', permissions: 'none' } }]) assert.equal(ownerAccess(value), 'unknown');
});

test('non-Owners cannot inherit management wildcard or inconsistent metadata', () => {
  assert.equal(ownerAccess({ ...ready, user: { role: 'read_only' } }), 'denied');
  assert.equal(ownerAccess({ ...reader, access: { mode: 'read_only', permissions: ['*'] } }), 'denied');
  assert.equal(panelPermission(reader, '*'), false);
});

test('panel permissions are explicit for read-only and wildcard only for management', () => {
  assert.equal(panelPermission(ready, 'jobs.read'), true);
  assert.equal(panelPermission(reader, 'servers.read'), true);
  assert.equal(panelPermission(reader, 'jobs.read'), false);
  assert.equal(panelPermission({ ...reader, access: { mode: 'read_only', permissions: ['*'] } }, 'servers.read'), false);
});

test('recovery acknowledgement and busy state block leaving enrollment', () => {
  assert.equal(enrollmentCanContinue({ session }), false);
  assert.equal(enrollmentCanContinue({ session: ready, sensitive: true }), false;
  assert.equal(enrollmentCanContinue({ session: ready, busy: true }), false;
  assert.equal(enrollmentCanContinue({ session: ready }), true);
  assert.equal(enrollmentCanContinue({ session: reader }), false);
});

test('an expired or locally reset enrollment cannot be bypassed by a continue click', () => {
  assert.equal(enrollmentCanContinue({ session: ready }), true);
  assert.equal(enrollmentCanContinue({ session: { ...ready, security: session.security, access: session.access } }), false);
});

test('explicit optional development policy allows ordinary management', () => {
  assert.equal(ownerAccess({ ...ready, security: { ...ready.security, ownerMfaRequired: false } }), 'management');
});
