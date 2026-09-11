import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationValidationError,
  applicationEnvironmentPolicy,
  normalizeApplicationEnvironmentBundle,
  normalizeEnvironmentKey,
  parseApplicationEnvironmentImport,
} from '../src/index.js';

test('normalizes bounded application environment values', () => {
  assert.deepEqual(normalizeApplicationEnvironmentBundle({
    API_URL: 'https://example.test/api',
    FEATURE_FLAG: 'enabled',
    EMPTY_VALUE: '',
  }), {
    API_URL: 'https://example.test/api',
    FEATURE_FLAG: 'enabled',
    EMPTY_VALUE: '',
  });
});

test('rejects reserved and unsafe environment names', () => {
  for (const key of ['NODE_ENV', 'HOST', 'PORT', 'YUNPANEL_APPLICATION_ID', 'bad-name', 'lowercase']) {
    assert.throws(() => normalizeEnvironmentKey(key), ApplicationValidationError);
  }
});

test('rejects multiline, nul and oversized environment values', () => {
  for (const value of ['line1\nline2', 'line1\rline2', 'bad\u0000value', 'x'.repeat(applicationEnvironmentPolicy.maxValueLength + 1)]) {
    assert.throws(
      () => normalizeApplicationEnvironmentBundle({ TEST_VALUE: value }),
      ApplicationValidationError,
    );
  }
});

test('enforces the per-application environment variable limit', () => {
  const tooMany = Object.fromEntries(
    Array.from({ length: applicationEnvironmentPolicy.maxVariables + 1 }, (_, index) => [`VALUE_${index}`, 'x']),
  );
  assert.throws(() => normalizeApplicationEnvironmentBundle(tooMany), ApplicationValidationError);
});

test('parses a strict bounded dotenv import without executing interpolation', () => {
  assert.deepEqual(parseApplicationEnvironmentImport(`\ufeff# comment\nexport API_URL=https://example.test # public\nTOKEN='literal # value'\nQUOTE="say \\"hello\\""\nEMPTY=\n`), {
    API_URL: 'https://example.test',
    TOKEN: 'literal # value',
    QUOTE: 'say "hello"',
    EMPTY: '',
  });
  assert.equal(applicationEnvironmentPolicy.maxImportLength, 12 * 1024);
});

test('rejects ambiguous, duplicate, reserved and multiline dotenv input', () => {
  for (const source of [
    'lower=value',
    'DUP=one\nDUP=two',
    'PORT=4000',
    'BROKEN="unterminated',
    'ESCAPE="line\\nvalue"',
    'MULTI=one\rvalue',
    `TOO_LARGE=${'x'.repeat((12 * 1024) + 1)}`,
  ]) assert.throws(() => parseApplicationEnvironmentImport(source), ApplicationValidationError);
});
