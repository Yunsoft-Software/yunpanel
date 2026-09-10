import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainValidationError,
  assertDomainName,
  normalizeDomainSet,
  validateDomainName,
} from '../src/index.js';

test('normalizes valid FQDN and IDN values to canonical ASCII', () => {
  assert.equal(assertDomainName(' Example.COM. '), 'example.com');
  assert.equal(assertDomainName('xn--bcher-kva.example'), 'xn--bcher-kva.example');
  assert.equal(assertDomainName('BÜCHER.example'), 'xn--bcher-kva.example');
  assert.equal(assertDomainName('bücher。example。'), 'xn--bcher-kva.example');
});

test('rejects unsafe or unsupported domain values', () => {
  assert.equal(validateDomainName('localhost').ok, false);
  assert.equal(validateDomainName('*.example.com').code, 'wildcard_not_supported');
  assert.equal(validateDomainName('-bad.example.com').ok, false);
  assert.equal(validateDomainName('bad_.example.com').ok, false);
  assert.equal(validateDomainName('example.com; include /etc/passwd').ok, false);
  assert.equal(validateDomainName(`bad\u0000.example.com`).ok, false);
});

test('normalizes and de-duplicates aliases after IDN conversion', () => {
  assert.deepEqual(
    normalizeDomainSet('example.com', ['www.example.com', 'WWW.EXAMPLE.COM.', 'example.com']),
    { primary: 'example.com', aliases: ['www.example.com'] },
  );
  assert.deepEqual(
    normalizeDomainSet('bücher.example', ['xn--bcher-kva.example', 'shop.bücher.example', 'SHOP.XN--BCHER-KVA.EXAMPLE.']),
    { primary: 'xn--bcher-kva.example', aliases: ['shop.xn--bcher-kva.example'] },
  );
});

test('throws typed validation errors for invalid domains', () => {
  assert.throws(
    () => assertDomainName('../etc/passwd'),
    (error) => error instanceof DomainValidationError && error.code === 'invalid_domain_label',
  );
});
