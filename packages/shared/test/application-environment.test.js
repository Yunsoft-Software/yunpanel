import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationValidationError,
  applicationEnvironmentPolicy,
  normalizeApplicationEnvironmentBundle,
  normalizeEnvironmentKey,
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
