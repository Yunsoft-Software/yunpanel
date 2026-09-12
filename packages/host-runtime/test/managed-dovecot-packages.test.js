import assert from 'node:assert/strict';
import test from 'node:test';
import { managedServicePolicy } from '../src/index.js';

test('managed Dovecot service includes IMAP, LMTP and Sieve packages', () => {
  const dovecot = managedServicePolicy.services.find((entry) => entry.id === 'dovecot');
  assert.ok(dovecot);
  assert.deepEqual(dovecot.packages, ['dovecot-imapd', 'dovecot-lmtpd', 'dovecot-sieve']);
  assert.deepEqual(dovecot.units, ['dovecot.service']);
  assert.deepEqual(dovecot.configurationChecks, [{ file: '/usr/bin/doveconf', args: ['-n'] }]);
});
