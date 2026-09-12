import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enableManagedMailSrs,
  MailSrsTemplateError,
  mailSrsTemplatePolicy,
} from '../src/index.js';

const BASE = Object.freeze({
  version: 1,
  sha256: 'a'.repeat(64),
  counts: Object.freeze({ domains: 1, mailboxes: 1, aliases: 0, forwardings: 1 }),
  artifacts: Object.freeze([]),
  postfixParameters: Object.freeze([
    Object.freeze({ name: 'virtual_mailbox_domains', value: 'hash:/etc/postfix/yunpanel-domains' }),
  ]),
  validate: Object.freeze([]),
  requirements: Object.freeze(['postfix', 'dovecot_2_3', 'dovecot_sieve']),
  readyToApply: false,
  sideEffects: false,
});

test('SRS policy is a no-op when forwarding stays inside managed mail domains', () => {
  const result = enableManagedMailSrs(BASE, {
    domains: ['example.com'],
    srsDomain: 'mail.example.com',
    forwardings: [{
      source: 'owner@example.com',
      mode: 'copy',
      destinations: ['archive@example.com'],
    }],
  });
  assert.equal(result, BASE);
});

test('external forwarding adds Noble PostSRSd 1.x config and exact Postfix canonical maps without a secret value', () => {
  const result = enableManagedMailSrs(BASE, {
    domains: ['example.com', 'example.net'],
    srsDomain: 'mail.example.com',
    forwardings: [{
      source: 'owner@example.com',
      mode: 'redirect',
      destinations: ['archive@example.net', 'external@gmail.com'],
    }],
  });

  assert.notEqual(result.sha256, BASE.sha256);
  assert.deepEqual(result.requirements, ['postfix', 'dovecot_2_3', 'dovecot_sieve', 'postsrsd_srs']);
  assert.equal(result.srs.required, true);
  assert.equal(result.srs.rewriteDomain, 'mail.example.com');
  assert.equal(result.srs.externalDestinationCount, 1);
  assert.equal(result.srs.forwardEndpoint, 'tcp:127.0.0.1:10001');
  assert.equal(result.srs.reverseEndpoint, 'tcp:127.0.0.1:10002');

  const defaults = result.artifacts.find((artifact) => artifact.path === mailSrsTemplatePolicy.defaultsPath);
  assert.ok(defaults);
  assert.equal(defaults.sensitive, false);
  assert.match(defaults.content, /^SRS_DOMAIN=mail\.example\.com$/m);
  assert.match(defaults.content, /^SRS_SECRET=\/etc\/postsrsd\.secret$/m);
  assert.match(defaults.content, /^SRS_LISTEN_ADDR=127\.0\.0\.1$/m);
  assert.match(defaults.content, /^SRS_EXCLUDE_DOMAINS=example\.com,example\.net$/m);
  assert.doesNotMatch(defaults.content, /secret\s*=\s*[A-Za-z0-9+/=_-]{16,}/i);

  const parameters = Object.fromEntries(result.postfixParameters.map((entry) => [entry.name, entry.value]));
  assert.equal(parameters.sender_canonical_maps, 'tcp:127.0.0.1:10001');
  assert.equal(parameters.sender_canonical_classes, 'envelope_sender');
  assert.equal(parameters.recipient_canonical_maps, 'tcp:127.0.0.1:10002');
  assert.equal(parameters.recipient_canonical_classes, 'envelope_recipient,header_recipient');
});

test('SRS policy fails closed on invalid rewrite domain or conflicting Postfix canonical maps', () => {
  assert.throws(
    () => enableManagedMailSrs(BASE, {
      domains: ['example.com'],
      srsDomain: 'not a hostname',
      forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['external@gmail.com'] }],
    }),
    (error) => error instanceof MailSrsTemplateError && error.code === 'invalid_mail_srs_domain',
  );

  assert.throws(
    () => enableManagedMailSrs({
      ...BASE,
      postfixParameters: [{ name: 'sender_canonical_maps', value: 'hash:/unsafe' }],
    }, {
      domains: ['example.com'],
      srsDomain: 'mail.example.com',
      forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['external@gmail.com'] }],
    }),
    (error) => error instanceof MailSrsTemplateError && error.code === 'mail_srs_postfix_parameter_conflict',
  );
});
