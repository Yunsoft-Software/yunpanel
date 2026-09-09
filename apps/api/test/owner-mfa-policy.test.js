import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';

const owner = { id: 'session', user: { id: 'owner', role: 'owner' }, csrfToken: 'test' };
function fixture() {
  let enabled = false;
  const store = { mfa: { enabled: (id) => { assert.equal(id, 'owner'); return enabled; } } };
  return { policy: createOwnerMfaPolicy({ store }), enable: (value) => { enabled = value; } };
}

test('password-only Owner session remains self-service only', () => {
  const { policy } = fixture();
  assert.deepEqual(policy.describe(owner).security, { ownerMfaRequired: true, enrollmentRequired: true, managementAllowed: false });
  assert.throws(() => policy.requireManagement(owner), { status: 403, code: 'mfa_enrollment_required' });
});

test('enrollment and local recovery take effect on the next request, not the next login', () => {
  const { policy, enable } = fixture();
  enable(true);
  assert.equal(policy.requireManagement(owner).security.managementAllowed, true);
  enable(false);
  assert.throws(() => policy.requireManagement(owner), { code: 'mfa_enrollment_required' });
});

test('client-provided security metadata cannot grant management', () => {
  const { policy } = fixture();
  assert.throws(() => policy.requireManagement({ ...owner, security: { managementAllowed: true, enrollmentRequired: false } }), { code: 'mfa_enrollment_required' });
  assert.equal(owner.security, undefined);
});

test('anonymous and non-Owner callers cannot gain access through MFA state', () => {
  const { policy } = fixture();
  assert.equal(policy.describe(null), null);
  assert.throws(() => policy.requireManagement(null), { status: 401 });
  assert.throws(() => policy.requireManagement({ ...owner, user: { id: 'reader', role: 'read_only' } }), { code: 'forbidden' });
});

test('unavailable or malformed enrollment state fails closed', () => {
  for (const enabled of [undefined, null, 'true', 1, Promise.resolve(true)]) {
    const policy = createOwnerMfaPolicy({ store: { mfa: { enabled: () => enabled } } });
    assert.throws(() => policy.describe(owner), /unavailable/);
  }
  assert.throws(() => createOwnerMfaPolicy({ store: {} }).requireManagement(owner));
});

test('optional development policy never promotes read-only accounts', () => {
  const policy = createOwnerMfaPolicy({ store: {}, required: false });
  assert.equal(policy.requireManagement(owner).security.managementAllowed, true);
  assert.equal(policy.describe(owner).security.ownerMfaRequired, false);
  assert.throws(() => policy.requireManagement({ ...owner, user: { role: 'read_only' } }), { status: 403 });
  assert.throws(() => createOwnerMfaPolicy({ store: {}, required: 'false' }), TypeError);
});
