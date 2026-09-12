import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailForwardingTemplateError,
  mailForwardingTemplatePolicy,
  previewManagedMailboxForwardingSieve,
  renderManagedMailboxForwardingSieve,
} from '../src/index.js';

test('renders deterministic copy and redirect mailbox forwarding policies', () => {
  const rendered = renderManagedMailboxForwardingSieve([
    {
      source: 'Sales@EXAMPLE.COM.',
      mode: 'copy',
      destinations: ['Owner@example.com', 'external@elsewhere.test'],
    },
    {
      source: 'billing@example.com',
      mode: 'redirect',
      destinations: ['finance@elsewhere.test'],
    },
  ]);
  assert.equal(rendered, [
    'require ["envelope", "copy"];',
    '',
    'if envelope :is "to" "billing@example.com" {',
    '  redirect "finance@elsewhere.test";',
    '  stop;',
    '}',
    '',
    'if envelope :is "to" "sales@example.com" {',
    '  redirect :copy "external@elsewhere.test";',
    '  redirect :copy "owner@example.com";',
    '  keep;',
    '  stop;',
    '}',
    '',
    '',
  ].join('\n'));
});

test('no forwarding policies produce a safe no-op global sieve script', () => {
  assert.equal(renderManagedMailboxForwardingSieve([]), 'require ["envelope", "copy"];\n\n\n');
});

test('forwarding preview exposes only fixed compile metadata and deterministic digest', () => {
  const input = [{
    source: 'owner@example.com',
    mode: 'copy',
    destinations: ['external@elsewhere.test'],
  }];
  const preview = previewManagedMailboxForwardingSieve(input);
  assert.equal(preview.path, '/etc/yunpanel/mail/dovecot/yunpanel-forwarding.sieve');
  assert.equal(preview.compiledPath, '/etc/yunpanel/mail/dovecot/yunpanel-forwarding.svbin');
  assert.deepEqual(preview.compile, {
    file: '/usr/bin/sievec',
    args: ['/etc/yunpanel/mail/dovecot/yunpanel-forwarding.sieve'],
  });
  assert.equal(preview.policies, 1);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.sideEffects, false);
  assert.equal(previewManagedMailboxForwardingSieve([{
    source: 'OWNER@EXAMPLE.COM.',
    mode: 'copy',
    destinations: ['EXTERNAL@ELSEWHERE.TEST.'],
  }]).sha256, preview.sha256);
  assert.equal(mailForwardingTemplatePolicy.maxDestinations, 4);
});

test('forwarding template rejects duplicate sources, self forwarding, cycles and control-character injection', () => {
  assert.throws(
    () => renderManagedMailboxForwardingSieve([
      { source: 'a@example.com', mode: 'copy', destinations: ['external@elsewhere.test'] },
      { source: 'A@EXAMPLE.COM.', mode: 'redirect', destinations: ['other@elsewhere.test'] },
    ]),
    (error) => error instanceof MailForwardingTemplateError && error.code === 'duplicate_mailbox_forwarding',
  );
  assert.throws(
    () => renderManagedMailboxForwardingSieve([
      { source: 'a@example.com', mode: 'copy', destinations: ['A@EXAMPLE.COM.'] },
    ]),
    (error) => error instanceof MailForwardingTemplateError && error.code === 'mailbox_forwarding_self_destination',
  );
  assert.throws(
    () => renderManagedMailboxForwardingSieve([
      { source: 'a@example.com', mode: 'copy', destinations: ['b@example.com'] },
      { source: 'b@example.com', mode: 'redirect', destinations: ['a@example.com'] },
    ]),
    (error) => error instanceof MailForwardingTemplateError && error.code === 'mailbox_forwarding_cycle',
  );
  assert.throws(
    () => renderManagedMailboxForwardingSieve([
      { source: 'a@example.com"; discard; #', mode: 'redirect', destinations: ['external@elsewhere.test'] },
    ]),
    MailForwardingTemplateError,
  );
});

test('forwarding template rejects more redirects than the bounded policy allows', () => {
  assert.throws(
    () => renderManagedMailboxForwardingSieve([{
      source: 'owner@example.com',
      mode: 'copy',
      destinations: [
        'one@elsewhere.test', 'two@elsewhere.test', 'three@elsewhere.test', 'four@elsewhere.test', 'five@elsewhere.test',
      ],
    }]),
    (error) => error instanceof MailForwardingTemplateError
      && error.code === 'invalid_mailbox_forwarding_destinations',
  );
});
