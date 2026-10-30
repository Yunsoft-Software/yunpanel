import assert from 'node:assert/strict';
import test from 'node:test';
import { dmarcPolicy, mailDnsRequirementStatus } from '../src/workspace/mail-dns-requirements.js';

test('mail DNS requirement status follows the diagnostics state the API returns', () => {
  assert.equal(mailDnsRequirementStatus({ state: 'present' }), 'valid');
  assert.equal(mailDnsRequirementStatus({ state: 'ready' }), 'valid');
  assert.equal(mailDnsRequirementStatus({ state: 'not_configured' }), 'unconfigured');
  for (const state of ['missing', 'multiple', 'value_mismatch', 'target_mismatch', 'resolver_error']) {
    assert.equal(mailDnsRequirementStatus({ state }), 'invalid');
  }
  assert.equal(mailDnsRequirementStatus(null), 'invalid');
});

test('DMARC policy is read from the published record', () => {
  assert.equal(dmarcPolicy({ state: 'present', current: ['v=DMARC1; p=quarantine; rua=mailto:a@example.com'] }), 'quarantine');
  assert.equal(dmarcPolicy({ state: 'present', current: ['v=DMARC1; p=none'] }), 'none');
  assert.equal(dmarcPolicy({ state: 'missing', current: [] }), null);
});
