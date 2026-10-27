import assert from 'node:assert/strict';
import test from 'node:test';
import { trackDeliveries } from '../src/mail-delivery-tracker.js';

// Line shapes as journald stores Postfix MESSAGE on Ubuntu 24.04 (postfix@-.service).
const at = (second) => `2026-10-27T10:00:${String(second).padStart(2, '0')}.000Z`;
const lines = [
  [1, '4F1A2B3C4D: client=mail.sender.example[203.0.113.5]'],
  [1, '4F1A2B3C4D: message-id=<abc@sender.example>'],
  [2, '4F1A2B3C4D: from=<info@a.com>, size=2048, nrcpt=2 (queue active)'],
  [3, '4F1A2B3C4D: to=<ali@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=1.2, delays=0.1/0/0.4/0.7, dsn=2.0.0, status=sent (250 2.0.0 OK)'],
  [4, '4F1A2B3C4D: to=<veli@hotmail.com>, relay=none, delay=30, delays=0.1/0/30/0, dsn=4.4.1, status=deferred (connect to mx.hotmail.com[1.2.3.4]:25: Connection timed out)'],
  [5, '7E7E7E7E7E: from=<newsletter@data.com>, size=900, nrcpt=1 (queue active)'],
  [6, '7E7E7E7E7E: to=<kim@data.com>, relay=local, dsn=2.0.0, status=sent (delivered)'],
  [7, '9BF524470C: from=<>, size=2999, nrcpt=1 (queue active)'],
  [8, '9BF524470C: to=<info@a.com>, relay=none, delay=0.01, delays=0.01/0/0/0, dsn=5.4.4, status=bounced (Host or domain name not found)'],
  [9, '9BF524470C: removed'],
  [10, 'NOQUEUE: reject: RCPT from unknown[198.51.100.7]: 554 5.7.1 <spam@a.com>: Relay access denied; from=<x@spammer.example> to=<spam@a.com> proto=ESMTP helo=<bad>'],
  [11, 'NOQUEUE: reject: RCPT from unknown[198.51.100.8]: 554 5.7.1 <z@data.com>: Relay access denied; from=<x@spammer.example> to=<z@data.com> proto=ESMTP helo=<bad>'],
  [12, 'C0FFEE1234: from=<ops@mail.a.com>, size=10, nrcpt=1 (queue active)'],
  [13, 'C0FFEE1234: to=<root@b.org>, relay=none, dsn=5.0.0, status=expired, returned to sender'],
  [14, 'garbage line without queue id'],
].map(([second, message]) => ({ timestamp: at(second), message }));

test('lines are grouped into messages with per-recipient status, newest first', () => {
  const messages = trackDeliveries(lines, { domain: 'a.com' });
  const outgoing = messages.find(message => message.queueId === '4F1A2B3C4D');
  assert.equal(outgoing.from, 'info@a.com');
  assert.equal(outgoing.size, 2048);
  assert.equal(outgoing.messageId, 'abc@sender.example');
  assert.deepEqual(outgoing.recipients.map(r => [r.address, r.status, r.dsn]), [
    ['ali@gmail.com', 'sent', '2.0.0'], ['veli@hotmail.com', 'deferred', '4.4.1']]);
  assert.match(outgoing.recipients[1].reason, /Connection timed out/);
  assert.equal(outgoing.status, 'deferred', 'a message is only as good as its worst recipient');
  assert.equal(outgoing.recipients[0].relay, 'gmail-smtp-in.l.google.com[142.250.1.27]:25');
  assert.deepEqual(messages.map(message => message.queueId ?? 'rejected'), ['rejected', '9BF524470C', '4F1A2B3C4D'],
    'newest first; mail.a.com is a different domain and excluded');
});

test('a bounce to the domain and a pre-queue rejection are tracked', () => {
  const messages = trackDeliveries(lines, { domain: 'a.com' });
  const bounce = messages.find(message => message.queueId === '9BF524470C');
  assert.equal(bounce.from, null, 'null sender (bounce) is shown as null, not an empty string');
  assert.equal(bounce.status, 'bounced');
  assert.equal(bounce.removed, true);
  const rejected = messages.find(message => message.queueId === null);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.recipients.map(r => r.address), ['spam@a.com']);
  assert.match(rejected.reason, /Relay access denied/);
});

test('scoping matches whole domains only: a.com never sees data.com or mail.a.com', () => {
  const ids = (domain) => trackDeliveries(lines, { domain }).map(message => message.queueId ?? `rejected:${message.recipients[0].address}`);
  assert.equal(ids('a.com').some(id => ['7E7E7E7E7E', 'C0FFEE1234', 'rejected:z@data.com'].includes(id)), false);
  assert.deepEqual(ids('data.com').sort(), ['7E7E7E7E7E', 'rejected:z@data.com'].sort());
  assert.deepEqual(ids('mail.a.com'), ['C0FFEE1234']);
  assert.equal(trackDeliveries(lines, { domain: 'A.COM' }).length, 3, 'case-insensitive');
});

test('search narrows by address, queue id or reason; expired is reported', () => {
  assert.deepEqual(trackDeliveries(lines, { domain: 'a.com', search: 'gmail' }).map(m => m.queueId), ['4F1A2B3C4D']);
  assert.deepEqual(trackDeliveries(lines, { domain: 'a.com', search: '9bf524' }).map(m => m.queueId), ['9BF524470C']);
  assert.equal(trackDeliveries(lines, { domain: 'mail.a.com' })[0].status, 'expired');
  assert.equal(trackDeliveries(lines, { domain: 'a.com', limit: 1 }).length, 1);
});

test('an invalid domain is refused instead of matching everything', () => {
  for (const domain of ['', 'com', null, 'a.com; x', '*.a.com']) {
    assert.throws(() => trackDeliveries(lines, { domain }), { code: 'invalid_mail_domain' });
  }
});
