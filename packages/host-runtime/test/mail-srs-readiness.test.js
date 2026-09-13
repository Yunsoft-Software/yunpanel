import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enableManagedMailSrs,
  previewManagedMailSubmissionConfiguration,
} from '@yunpanel/config-templates';
import { createMailReadinessInspector } from '../src/mail-readiness-inspector.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 7).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 8).toString('base64').replace(/=+$/, '')}`;

function preview() {
  const base = previewManagedMailSubmissionConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['external@gmail.com'] }],
  });
  return enableManagedMailSrs(base, {
    domains: ['example.com'],
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['external@gmail.com'] }],
    srsDomain: 'mail.example.com',
    secretRevision: 1,
    secretSha256: 'a'.repeat(64),
    secretBytes: 44,
  });
}

function inspector({ wildcardForward = false, wrongSenderMap = false } = {}) {
  const service = Object.freeze({
    installed: true,
    active: true,
    health: Object.freeze({ status: 'ready' }),
  });
  const managedServiceManager = { inspect: async () => service };
  const output = new Map([
    ['/usr/sbin/dovecot\u0000--version', '2.3.21'],
    ['/usr/bin/getent\u0000passwd\u0000vmail', 'vmail:x:5000:5000::/var/lib/yunpanel/mail:/usr/sbin/nologin'],
    ['/usr/bin/getent\u0000passwd\u0000postfix', 'postfix:x:110:117::/var/spool/postfix:/usr/sbin/nologin'],
    ['/usr/bin/doveconf\u0000-h\u0000ssl', 'required'],
    ['/usr/bin/doveconf\u0000-h\u0000ssl_cert', '</etc/letsencrypt/live/mail.example.com/fullchain.pem'],
    ['/usr/bin/doveconf\u0000-h\u0000ssl_key', '</etc/letsencrypt/live/mail.example.com/privkey.pem'],
    ['/usr/sbin/postconf\u0000-h\u0000smtpd_tls_cert_file', '/etc/letsencrypt/live/mail.example.com/fullchain.pem'],
    ['/usr/sbin/postconf\u0000-h\u0000smtpd_tls_key_file', '/etc/letsencrypt/live/mail.example.com/privkey.pem'],
    ['/usr/sbin/postconf\u0000-h\u0000myhostname', 'mail.example.com'],
    ['/usr/sbin/postconf\u0000-h\u0000mydomain', 'example.com'],
    ['/usr/sbin/postconf\u0000-h\u0000mydestination', '$myhostname, localhost.$mydomain, localhost'],
    ['/usr/bin/ss\u0000-H\u0000-ltn\u0000sport = :11332', 'LISTEN 0 128 127.0.0.1:11332 0.0.0.0:*'],
    ['/usr/bin/systemctl\u0000show\u0000-p\u0000LoadState\u0000--value\u0000postsrsd.service', 'loaded'],
    ['/usr/bin/systemctl\u0000is-active\u0000--quiet\u0000postsrsd.service', ''],
    ['/usr/bin/ss\u0000-H\u0000-ltn\u0000sport = :10001', `LISTEN 0 128 ${wildcardForward ? '0.0.0.0' : '127.0.0.1'}:10001 0.0.0.0:*`],
    ['/usr/bin/ss\u0000-H\u0000-ltn\u0000sport = :10002', 'LISTEN 0 128 127.0.0.1:10002 0.0.0.0:*'],
    ['/usr/sbin/postconf\u0000-h\u0000sender_canonical_maps', wrongSenderMap ? 'hash:/unsafe' : 'tcp:127.0.0.1:10001'],
    ['/usr/sbin/postconf\u0000-h\u0000recipient_canonical_maps', 'tcp:127.0.0.1:10002'],
  ]);
  return createMailReadinessInspector({
    managedServiceManager,
    run: async (file, args) => {
      const key = `${file}\u0000${args.join('\u0000')}`;
      if (!output.has(key)) throw new Error(`unexpected command ${key}`);
      return { stdout: output.get(key), stderr: '' };
    },
    statFn: async (filePath) => ({
      mode: ['/usr/bin/sievec', '/usr/sbin/postsrsd'].includes(filePath) ? 0o755 : 0o600,
      isFile: () => true,
    }),
  });
}

test('SRS pre-readiness requires the installed PostSRSd binary and unit but not already-applied sockets', async () => {
  const candidate = preview();
  const result = await inspector().inspect(candidate, { phase: 'pre' });
  assert.equal(result.ready, true);
  assert.equal(result.phase, 'pre');
  assert.equal(result.blockers.includes('postsrsd_srs'), false);
});

test('SRS post-readiness requires exact loopback sockets and canonical Postfix maps', async () => {
  const candidate = preview();
  const healthy = await inspector().inspect(candidate, { phase: 'post' });
  assert.equal(healthy.ready, true);
  assert.equal(healthy.phase, 'post');

  const wildcard = await inspector({ wildcardForward: true }).inspect(candidate, { phase: 'post' });
  assert.equal(wildcard.ready, false);
  assert.ok(wildcard.blockers.includes('postsrsd_srs'));

  const wrongMap = await inspector({ wrongSenderMap: true }).inspect(candidate, { phase: 'post' });
  assert.equal(wrongMap.ready, false);
  assert.ok(wrongMap.blockers.includes('postsrsd_srs'));
});
