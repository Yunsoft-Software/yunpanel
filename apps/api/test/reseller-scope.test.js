import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import {
  assertCustomerCreationScope, assertCustomerManagement, assertCustomerWebsiteAccess,
  assertResellerManagement, validateHostingAccount,
} from '../src/reseller-scope.js';

const owner = Object.freeze({ id: 'owner', role: 'owner', active: true });
const reseller = Object.freeze({ id: 'reseller-a', kind: 'reseller', resellerId: null, active: true });
const customer = Object.freeze({ id: 'customer-a', kind: 'customer', resellerId: reseller.id, active: true });
const website = Object.freeze({ id: 'website-a', customerId: customer.id });
const actor = Object.freeze({ id: reseller.id, role: 'reseller', active: true });
const childActor = Object.freeze({ id: customer.id, role: 'customer', active: true });
const direct = Object.freeze({ ...customer, id: 'direct', resellerId: null });
const context = (changes = {}) => ({ actor, reseller, customer, website, ...changes });
const forbidden = (fn) => assert.throws(fn, (error) => error instanceof AuthError && error.status === 403);
const invalid = (fn) => assert.throws(fn, (error) => error instanceof AuthError && error.code === 'invalid_reseller_record');

test('Owner manages reseller accounts, including inactive accounts', () => {
  assertResellerManagement({ actor: owner, reseller });
  assertResellerManagement({ actor: owner, reseller: { ...reseller, active: false } });
});
for (const candidate of [actor, childActor, { ...owner, role: 'read_only' }, { ...owner, role: 'site_manager' }]) {
  test(`${candidate.role} cannot change reseller accounts or limits`, () => forbidden(() => assertResellerManagement({ actor: candidate, reseller })));
}
for (const candidate of [null, {}, { ...owner, active: false }, { ...owner, active: 1 }, { ...owner, role: 'admin' }, { ...owner, id: '' }]) {
  test(`invalid/inactive actor fails closed: ${JSON.stringify(candidate)}`, () => {
    for (const check of [assertResellerManagement, assertCustomerCreationScope, assertCustomerManagement, assertCustomerWebsiteAccess]) {
      forbidden(() => check(context({ actor: candidate })));
    }
  });
}
test('Owner creates direct customers; own reseller creates only assigned customers', () => {
  assertCustomerCreationScope({ actor: owner });
  assertCustomerCreationScope({ actor: owner, reseller });
  assertCustomerCreationScope({ actor, reseller });
  forbidden(() => assertCustomerCreationScope({ actor }));
  forbidden(() => assertCustomerCreationScope({ actor, reseller: { ...reseller, id: 'reseller-b' } }));
  forbidden(() => assertCustomerCreationScope({ actor: childActor, reseller }));
});
test('new customers cannot be created under an inactive reseller, even by Owner', () => {
  for (const candidate of [actor, owner]) forbidden(() => assertCustomerCreationScope({ actor: candidate, reseller: { ...reseller, active: false } }));
});
test('Owner and assigned reseller manage active/inactive customers', () => {
  for (const candidate of [owner, actor]) {
    assertCustomerManagement(context({ actor: candidate }));
    assertCustomerManagement(context({ actor: candidate, customer: { ...customer, active: false } }));
  }
});
test('customer cannot use customer administration, even for itself', () => forbidden(() => assertCustomerManagement(context({ actor: childActor }))));
test('reseller cannot manage another reseller customer or an Owner customer', () => {
  forbidden(() => assertCustomerManagement(context({ actor: { ...actor, id: 'reseller-b' } })));
  forbidden(() => assertCustomerManagement(context({ customer: direct, reseller: null })));
});
test('current inactive parent denies reseller management but permits Owner repair', () => {
  forbidden(() => assertCustomerManagement(context({ reseller: { ...reseller, active: false } })));
  assertCustomerManagement(context({ actor: owner, reseller: { ...reseller, active: false } }));
});
test('Owner, assigned reseller and own customer pass the Website scope guard', () => {
  for (const candidate of [owner, actor, childActor]) assertCustomerWebsiteAccess(context({ actor: candidate }));
});
for (const candidate of [{ ...actor, id: 'reseller-b' }, { ...childActor, id: 'customer-b' }]) {
  test(`${candidate.id} cannot access the Website`, () => forbidden(() => assertCustomerWebsiteAccess(context({ actor: candidate }))));
}
test('direct Owner customer needs no artificial reseller or subscription', () => {
  assertCustomerManagement({ actor: owner, customer: direct });
  for (const candidate of [owner, { id: direct.id, role: 'customer', active: true }]) {
    assertCustomerWebsiteAccess({ actor: candidate, customer: direct, website: { ...website, customerId: direct.id } });
  }
  forbidden(() => assertCustomerWebsiteAccess({ actor, customer: direct, website: { ...website, customerId: direct.id } }));
});
for (const change of [{ customer: { ...customer, active: false } }, { reseller: { ...reseller, active: false } }]) {
  test(`inactive ${Object.keys(change)[0]} blocks site tools but not Owner repair`, () => {
    for (const candidate of [actor, childActor]) forbidden(() => assertCustomerWebsiteAccess(context({ ...change, actor: candidate })));
    assertCustomerWebsiteAccess(context({ ...change, actor: owner }));
  });
}
test('a previously allowed snapshot does not grant access after parent revocation', () => {
  assertCustomerWebsiteAccess(context());
  forbidden(() => assertCustomerWebsiteAccess(context({ reseller: { ...reseller, active: false } })));
});
test('explicit wrong Website ownership is denied even for Owner', () => {
  for (const candidate of [actor, childActor, owner]) forbidden(() => assertCustomerWebsiteAccess(context({ actor: candidate, website: { ...website, customerId: 'other' } })));
});
for (const value of [null, {}, { ...website, id: '' }, { id: website.id, websiteId: customer.id }, { ...website, customerId: undefined }]) {
  test(`invalid Website record ${JSON.stringify(value)} never falls back to another identity`, () => invalid(() => assertCustomerWebsiteAccess(context({ website: value }))));
}
for (const value of [null, {}, { ...customer, active: 'true' }, { ...customer, resellerId: undefined }, { ...customer, resellerId: customer.id }, { ...customer, kind: 'reseller' }]) {
  test(`invalid customer record ${JSON.stringify(value)} is rejected`, () => invalid(() => assertCustomerManagement(context({ customer: value }))));
}
test('missing and mismatched parents never become direct Owner customers', () => {
  invalid(() => assertCustomerWebsiteAccess(context({ reseller: null })));
  forbidden(() => assertCustomerWebsiteAccess(context({ reseller: { ...reseller, id: 'reseller-b' } })));
  forbidden(() => assertCustomerManagement(context({ customer: direct })));
});
test('reseller nesting is rejected for every account scope operation', () => {
  const nested = { ...reseller, resellerId: 'parent-reseller' };
  invalid(() => assertResellerManagement({ actor: owner, reseller: nested }));
  invalid(() => assertCustomerCreationScope({ actor: owner, reseller: nested }));
  invalid(() => assertCustomerManagement(context({ reseller: nested })));
  invalid(() => assertCustomerWebsiteAccess(context({ reseller: nested })));
});
test('inherited fields and non-record values cannot supply authority', () => {
  forbidden(() => assertCustomerManagement(context({ actor: Object.create(owner) })));
  invalid(() => validateHostingAccount(Object.create(customer), 'customer'));
  invalid(() => validateHostingAccount([], 'customer'));
});
test('normalized records are defensive copies and do not expose extra secrets', () => {
  const input = Object.freeze({ ...customer, passwordHash: 'not-a-real-secret' });
  const normalized = validateHostingAccount(input, 'customer');
  assert.deepEqual(normalized, customer);
  assert.notEqual(normalized, input);
  assertCustomerWebsiteAccess(context());
  assert.equal(customer.active, true);
});
test('scope errors do not disclose other account or Website identifiers', () => {
  assert.throws(() => assertCustomerWebsiteAccess(context({ website: { ...website, customerId: 'private-other-id' } })), (error) => {
    assert.equal(error.message.includes('private-other-id'), false);
    return error.status === 403;
  });
});
