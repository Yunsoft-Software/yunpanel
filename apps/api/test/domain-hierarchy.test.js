import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDomainParent, validateDomainHierarchy } from '../src/domain-hierarchy.js';

const root = { id: 'root', serverId: 'local', primaryDomain: 'example.com.tr' };
const child = { id: 'child', serverId: 'local', primaryDomain: 'api.example.com.tr', parentDomainId: 'root' };
const candidate = (overrides = {}) => ({ serverId: 'local', primaryDomain: 'api.example.com.tr', parentDomainId: 'root', ...overrides });
const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('parent is explicit, including legacy records and public-suffix domains', () => {
  assert.equal(validateDomainParent([root], candidate()), 'root');
  assert.equal(validateDomainParent([root], candidate({ parentDomainId: null })), null);
  assert.equal(validateDomainParent([root], { serverId: 'local', primaryDomain: 'api.example.com.tr' }), null);
  assert.doesNotThrow(() => validateDomainHierarchy([root, child]));
});

test('nested subdomains can use an explicit immediate parent', () => {
  assert.equal(validateDomainParent([root, child], candidate({ primaryDomain: 'v2.api.example.com.tr', parentDomainId: 'child' })), 'child');
});

test('same-name, suffix lookalike, unrelated domain and alias cannot be children', () => {
  const parent = { ...root, aliases: ['example.net'] };
  for (const primaryDomain of ['example.com.tr', 'badexample.com.tr', 'other.com', 'api.example.net']) {
    rejects(() => validateDomainParent([parent], candidate({ primaryDomain })), 'invalid_subdomain_parent');
  }
});

test('parent IDs reject invalid types and missing resources', () => {
  for (const parentDomainId of ['', 7, {}, [], 'x'.repeat(129)]) {
    rejects(() => validateDomainParent([root], candidate({ parentDomainId })), 'invalid_parent_domain');
  }
  rejects(() => validateDomainParent([root], candidate({ parentDomainId: 'missing' })), 'parent_domain_not_found');
});

test('cross-server links are rejected', () => {
  rejects(() => validateDomainParent([{ ...root, serverId: 'remote' }], candidate()), 'parent_server_mismatch');
});

test('self-parent and ancestor cycles terminate with a conflict', () => {
  rejects(() => validateDomainParent([root], candidate({ id: 'root' })), 'domain_parent_cycle');
  const corrupt = [{ ...root, parentDomainId: 'child' }, child];
  rejects(() => validateDomainParent(corrupt, candidate()), 'domain_parent_cycle');
});

test('dangling ancestors fail closed instead of silently detaching', () => {
  rejects(() => validateDomainHierarchy([{ ...root, parentDomainId: 'missing' }, child]), 'parent_domain_not_found');
});

test('duplicate or missing IDs fail closed on persisted state', () => {
  for (const domains of [[root, { ...root }], [{}], [null]]) {
    rejects(() => validateDomainHierarchy(domains), 'invalid_domain_hierarchy');
  }
});

test('validation does not mutate domain state or alias ownership', () => {
  const domains = [Object.freeze({ ...root, aliases: Object.freeze(['www.example.com.tr']) }), Object.freeze(child)];
  const before = JSON.stringify(domains);
  validateDomainHierarchy(domains);
  assert.equal(JSON.stringify(domains), before);
});
