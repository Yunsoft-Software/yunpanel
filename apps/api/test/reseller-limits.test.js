import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import { assertResellerCapacity, countResellerUsage, validateResellerLimits } from '../src/reseller-limits.js';

const limits = Object.freeze({ maxCustomers: 2, maxWebsites: 3 });
const usage = Object.freeze({ customers: 1, websites: 2 });
const check = (changes = {}) => assertResellerCapacity({ limits, usage, resource: 'customers', ...changes });
const rejects = (fn, code = 'invalid_reseller_limits') => assert.throws(fn, (error) => error instanceof AuthError && error.code === code);

test('exact limit is permitted; next addition is refused with a conflict', () => {
  check();
  check({ resource: 'websites' });
  rejects(() => check({ usage: { ...usage, customers: 2 } }), 'reseller_limit_reached');
  rejects(() => check({ resource: 'websites', usage: { ...usage, websites: 3 } }), 'reseller_limit_reached');
  assert.throws(() => check({ amount: 2 }), { status: 409 });
});
test('only explicit null means unlimited; zero prevents additions', () => {
  check({ limits: { maxCustomers: null, maxWebsites: null }, usage: { customers: 200, websites: 500 } });
  rejects(() => check({ limits: { ...limits, maxCustomers: 0 }, usage: { customers: 0, websites: 0 } }), 'reseller_limit_reached');
});
test('lowering a limit blocks additions without deleting or mutating existing data', () => {
  const over = Object.freeze({ customers: 10, websites: 10 });
  rejects(() => check({ usage: over }), 'reseller_limit_reached');
  assert.deepEqual(over, { customers: 10, websites: 10 });
});
test('customer and site ceilings are independent', () => {
  check({ resource: 'websites', usage: { customers: 2, websites: 0 } });
  check({ usage: { customers: 0, websites: 3 } });
});
for (const value of [undefined, -1, 1.5, '2', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid limit ${String(value)} is not coerced into a usable limit`, () => {
    for (const key of ['maxCustomers', 'maxWebsites']) rejects(() => validateResellerLimits({ ...limits, [key]: value }));
  });
}
for (const value of [undefined, null, {}, [], { maxCustomers: 2 }, { ...limits, overselling: true }, Object.create(limits)]) {
  test(`incomplete/unsupported limit record ${JSON.stringify(value)} is rejected`, () => rejects(() => validateResellerLimits(value)));
}
for (const value of [undefined, null, -1, 1.5, '1', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid usage ${String(value)} does not mean zero`, () => {
    rejects(() => check({ usage: { ...usage, customers: value } }));
    rejects(() => check({ usage: { ...usage, websites: value } }));
  });
}
for (const value of [undefined, null, {}, [], { customers: 1 }, { ...usage, disk: 0 }, Object.create(usage)]) {
  test(`incomplete usage ${JSON.stringify(value)} is rejected`, () => rejects(() => check({ usage: value })));
}
for (const value of [undefined, null, 'disk', '__proto__', 'constructor', '', ['customers']]) {
  test(`unsupported resource ${JSON.stringify(value)} is rejected`, () => rejects(() => check({ resource: value })));
}
for (const value of [0, -1, 0.5, '1', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid addition ${String(value)} is rejected`, () => rejects(() => check({ amount: value })));
}
test('even unlimited mode rejects counter overflow', () => {
  rejects(() => check({ limits: { maxCustomers: null, maxWebsites: null }, usage: { customers: Number.MAX_SAFE_INTEGER, websites: 0 } }));
});
test('validated limits are an independent copy', () => {
  const copy = validateResellerLimits(limits);
  assert.deepEqual(copy, limits);
  assert.notEqual(copy, limits);
  copy.maxCustomers = 99;
  assert.equal(limits.maxCustomers, 2);
});

const reseller = Object.freeze({ id: 'reseller-a', kind: 'reseller', resellerId: null, active: true });
const customers = Object.freeze([
  Object.freeze({ id: 'customer-a1', kind: 'customer', resellerId: reseller.id, active: true }),
  Object.freeze({ id: 'customer-a2', kind: 'customer', resellerId: reseller.id, active: false }),
  Object.freeze({ id: 'customer-b', kind: 'customer', resellerId: 'reseller-b', active: true }),
  Object.freeze({ id: 'direct', kind: 'customer', resellerId: null, active: true }),
]);
const websites = Object.freeze([
  Object.freeze({ id: 'site-a1', customerId: customers[0].id }),
  Object.freeze({ id: 'site-a2', customerId: customers[1].id, active: false }),
  Object.freeze({ id: 'site-a3', customerId: customers[0].id }),
  Object.freeze({ id: 'site-b', customerId: customers[2].id }),
  Object.freeze({ id: 'site-direct', customerId: customers[3].id }),
]);
const inventory = (changes = {}) => countResellerUsage({ reseller, customers, websites, ...changes });

test('usage totals all reseller customers/sites including inactive ones, not other tenants', () => {
  assert.deepEqual(inventory(), { customers: 2, websites: 3 });
  assert.deepEqual(inventory({ reseller: { ...reseller, active: false } }), { customers: 2, websites: 3 });
  assert.deepEqual(inventory({ reseller: { ...reseller, id: 'reseller-b' } }), { customers: 1, websites: 1 });
});
test('real empty inventories give zero, without inventing an unlimited limit', () => {
  assert.deepEqual(inventory({ customers: [], websites: [] }), { customers: 0, websites: 0 });
});
test('suspending customers or sites never frees a slot', () => {
  const suspended = customers.map((entry) => ({ ...entry, active: false }));
  const suspendedSites = websites.map((entry) => ({ ...entry, active: false }));
  assert.deepEqual(inventory({ customers: suspended, websites: suspendedSites }), inventory());
  rejects(() => check({ usage: inventory() }), 'reseller_limit_reached');
});
for (const changes of [
  { customers: null }, { websites: undefined },
  { customers: [...customers, customers[0]] }, { websites: [...websites, websites[0]] },
  { websites: [{ id: 'orphan', customerId: 'missing' }] },
  { websites: [{ id: 'wrong-id-type', domainId: customers[0].id }] },
  { websites: [{ id: '', customerId: customers[0].id }] },
  { websites: [Object.create(websites[0])] },
  { customers: [{ ...customers[0], id: reseller.id, resellerId: null }] },
]) {
  test(`ambiguous or incomplete inventory ${Object.keys(changes).join()} fails closed: ${JSON.stringify(changes)}`, () => {
    rejects(() => inventory(changes), 'invalid_reseller_inventory');
  });
}
test('invalid customer relationship cannot silently lower usage', () => {
  rejects(() => inventory({ customers: [{ ...customers[0], resellerId: undefined }], websites: [] }), 'invalid_reseller_record');
});
test('inventory counting does not mutate input or include secret fields in output', () => {
  const result = inventory();
  assert.deepEqual(Object.keys(result), ['customers', 'websites']);
  assert.equal(customers[1].active, false);
  assert.equal(websites.length, 5);
});
