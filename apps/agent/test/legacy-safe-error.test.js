import assert from 'node:assert/strict';
import test from 'node:test';
import {
  safeLegacyAgentDiagnosticCode,
  safeLegacyAgentError,
} from '../src/legacy-safe-error.js';

test('known legacy host errors use authored safe diagnostics instead of raw messages', () => {
  for (const code of [
    'nginx_config_invalid',
    'nginx_activation_prepare_failed',
    'staged_config_inspection_failed',
    'active_config_inspection_failed',
  ]) {
    const error = Object.assign(new Error('SECRET=/root/private/nginx.conf'), { code });
    const result = safeLegacyAgentError(error);
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|\/root\/private/);
  }
});

test('certificate pair failures keep a bounded legacy diagnostic', () => {
  const error = Object.assign(new Error('PRIVATE KEY MATERIAL'), { code: 'certificate_private_key_mismatch' });
  const result = safeLegacyAgentError(error);
  assert.equal(result.code, 'certificate_private_key_mismatch');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY MATERIAL/);
});

test('unknown or hostile error codes cannot escape into job or journal diagnostics', () => {
  const unknown = new Error('password=super-secret /root/private/key');
  unknown.code = 'password_super_secret';
  assert.deepEqual(safeLegacyAgentError(unknown), {
    code: 'legacy_operation_failed',
    message: 'Legacy host operation failed. Inspect protected host diagnostics before retrying.',
  });

  const hostile = {};
  Object.defineProperty(hostile, 'code', { get() { throw new Error('TOKEN=secret'); } });
  assert.deepEqual(safeLegacyAgentError(hostile), {
    code: 'legacy_operation_failed',
    message: 'Legacy host operation failed. Inspect protected host diagnostics before retrying.',
  });
});

test('legacy logging emits only allowlisted or caller-authored fallback codes', () => {
  const known = Object.assign(new Error('raw'), { code: 'database_drop_failed' });
  assert.equal(safeLegacyAgentDiagnosticCode(known, 'command_poll_failed'), 'database_drop_failed');

  const unknown = Object.assign(new Error('SECRET=/tmp/token'), { code: 'secret_token_123' });
  assert.equal(safeLegacyAgentDiagnosticCode(unknown, 'command_poll_failed'), 'command_poll_failed');
  assert.equal(safeLegacyAgentDiagnosticCode(unknown, 'INVALID SECRET'), 'legacy_agent_failed');
});
