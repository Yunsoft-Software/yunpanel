import assert from 'node:assert/strict';
import test from 'node:test';
import {
  previewManagedMailConfiguration,
  previewManagedMailForwardingConfiguration,
} from '@yunpanel/config-templates';
import {
  createMailReadinessInspector,
  MailReadinessError,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 5).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 6).toString('base64').replace(/=+$/, '')}`;

function preview() {
  return previewManagedMailConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
  });
}

function forwardingPreview() {
  return previewManagedMailForwardingConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['backup@elsewhere.test'] }],
  });
}

function service(id) {
  return {
    id,
    installed: true,
    active: true,
    health: { status: 'ready', configuration: 'valid' },
  };
}

function command(file, args) {
  return `${file} ${args.join(' ')}`;
}

function healthyOutputs(overrides = {}) {
  return new Map(Object.entries({
    [command('/usr/sbin/dovecot', ['--version'])]: '2.3.21\n',
    [command('/usr/bin/getent', ['passwd', 'vmail'])]: 'vmail:x:5000:5000::/var/lib/yunpanel/mail:/usr/sbin/nologin\n',
    [command('/usr/bin/getent', ['passwd', 'postfix'])]: 'postfix:x:110:117::/var/spool/postfix:/usr/sbin/nologin\n',
    [command('/usr/bin/doveconf', ['-h', 'ssl'])]: 'required\n',
    [command('/usr/bin/doveconf', ['-h', 'ssl_cert'])]: '</etc/ssl/certs/mail.pem\n',
    [command('/usr/bin/doveconf', ['-h', 'ssl_key'])]: '</etc/ssl/private/mail.key\n',
    [command('/usr/sbin/postconf', ['-h', 'smtpd_tls_cert_file'])]: '/etc/ssl/certs/mail.pem\n',
    [command('/usr/sbin/postconf', ['-h', 'smtpd_tls_key_file'])]: '/etc/ssl/private/mail.key\n',
    [command('/usr/sbin/postconf', ['-h', 'myhostname'])]: 'mail.example.net\n',
    [command('/usr/sbin/postconf', ['-h', 'mydomain'])]: 'example.net\n',
    [command('/usr/sbin/postconf', ['-h', 'mydestination'])]: '$myhostname, localhost.$mydomain, localhost\n',
    [command('/usr/sbin/postconf', ['-h', 'smtpd_relay_restrictions'])]: 'permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination\n',
    [command('/usr/sbin/postconf', ['-h', 'smtpd_recipient_restrictions'])]: '\n',
    [command('/usr/bin/ss', ['-H', '-ltn', 'sport = :11332'])]: '\n',
    ...overrides,
  }));
}

function createInspector({ outputs = healthyOutputs(), serviceOverrides = {}, missingFiles = [], sievecMode = 0o755 } = {}) {
  return createMailReadinessInspector({
    managedServiceManager: {
      inspect: async (id) => serviceOverrides[id] ?? service(id),
    },
    run: async (file, args) => {
      const key = command(file, args);
      if (!outputs.has(key)) throw new Error('unexpected command');
      return { stdout: outputs.get(key) };
    },
    statFn: async (filePath) => {
      if (missingFiles.includes(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, mode: filePath === '/usr/bin/sievec' ? sievecMode : 0o600 };
    },
  });
}

test('marks managed mail ready only when every host requirement is satisfied', async () => {
  const result = await createInspector().inspect(preview());
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.requirements.every((entry) => entry.satisfied), true);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('/etc/ssl/private/mail.key'), false);
  assert.equal(JSON.stringify(result).includes('defer_unauth_destination'), false);
});

test('forwarding readiness requires the fixed executable sievec binary', async () => {
  const candidate = forwardingPreview();
  const ready = await createInspector().inspect(candidate);
  assert.equal(ready.ready, true);
  assert.equal(ready.requirements.some((entry) => entry.id === 'dovecot_sieve' && entry.satisfied), true);

  const missing = await createInspector({ missingFiles: ['/usr/bin/sievec'] }).inspect(candidate);
  assert.equal(missing.ready, false);
  assert.equal(missing.blockers.includes('dovecot_sieve'), true);

  const nonExecutable = await createInspector({ sievecMode: 0o644 }).inspect(candidate);
  assert.equal(nonExecutable.ready, false);
  assert.equal(nonExecutable.blockers.includes('dovecot_sieve'), true);
});

test('blocks privileged or malformed vmail identities', async () => {
  for (const value of [
    'vmail:x:0:0::/var/lib/yunpanel/mail:/usr/sbin/nologin\n',
    'vmail:x:not-a-number:5000::/var/lib/yunpanel/mail:/usr/sbin/nologin\n',
  ]) {
    const outputs = healthyOutputs({
      [command('/usr/bin/getent', ['passwd', 'vmail'])]: value,
    });
    const result = await createInspector({ outputs }).inspect(forwardingPreview());
    assert.equal(result.ready, false);
    assert.equal(result.blockers.includes('vmail_identity'), true);
  }
});

test('blocks managed domains in mydestination and wildcard rspamd listeners', async () => {
  const outputs = healthyOutputs({
    [command('/usr/sbin/postconf', ['-h', 'mydestination'])]: '$myhostname, example.com, localhost\n',
    [command('/usr/bin/ss', ['-H', '-ltn', 'sport = :11332'])]: 'LISTEN 0 4096 0.0.0.0:11332 0.0.0.0:*\n',
  });
  const result = await createInspector({ outputs }).inspect(preview());
  assert.equal(result.ready, false);
  assert.equal(result.blockers.includes('managed_domains_excluded_from_mydestination'), true);
  assert.equal(result.blockers.includes('loopback_11332_available'), true);
});

test('blocks dynamic or unresolved mydestination values instead of guessing', async () => {
  for (const value of ['$myhostname, $relay_domains, localhost\n', 'hash:/etc/postfix/virtual-destinations\n']) {
    const outputs = healthyOutputs({
      [command('/usr/sbin/postconf', ['-h', 'mydestination'])]: value,
    });
    const result = await createInspector({ outputs }).inspect(preview());
    assert.equal(result.ready, false);
    assert.equal(result.blockers.includes('managed_domains_excluded_from_mydestination'), true);
  }
});

test('blocks missing tls material, non-2.3 dovecot and unsafe relay policy', async () => {
  const outputs = healthyOutputs({
    [command('/usr/sbin/dovecot', ['--version'])]: '2.4.0\n',
    [command('/usr/sbin/postconf', ['-h', 'smtpd_relay_restrictions'])]: 'permit_mynetworks\n',
  });
  const result = await createInspector({
    outputs,
    missingFiles: ['/etc/ssl/private/mail.key'],
  }).inspect(preview());
  assert.equal(result.ready, false);
  assert.equal(result.blockers.includes('dovecot_2_3'), true);
  assert.equal(result.blockers.includes('mail_tls_material'), true);
  assert.equal(result.blockers.includes('postfix_relay_policy_verified'), true);
});

test('rejects forged readiness requirement ordering before host inspection', async () => {
  const input = forwardingPreview();
  await assert.rejects(
    createInspector().inspect({ ...input, requirements: [...input.requirements].reverse() }),
    (error) => error instanceof MailReadinessError && error.code === 'mail_readiness_requirements_invalid',
  );
});
