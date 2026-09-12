import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailDiagnosticsInspector,
  MailDiagnosticsInspectorError,
} from '../src/index.js';

function absent(code = 'ENODATA') {
  return Object.assign(new Error('absent'), { code });
}

function fixture(overrides = {}) {
  const calls = [];
  const inspector = createMailDiagnosticsInspector({
    now: () => Date.parse('2026-09-12T18:45:00.000Z'),
    run: async (file, args) => {
      calls.push(['run', file, [...args]]);
      assert.equal(file, '/usr/sbin/postconf');
      assert.deepEqual(args, ['-h', 'myhostname']);
      return { stdout: `${overrides.mailHostname ?? 'mail.example.com'}\n`, stderr: '' };
    },
    resolveMx: async (name) => {
      calls.push(['mx', name]);
      if (overrides.mxError) throw overrides.mxError;
      return overrides.mx ?? [{ priority: 10, exchange: 'mail.example.com.' }];
    },
    resolveTxt: async (name) => {
      calls.push(['txt', name]);
      if (name.startsWith('_dmarc.')) {
        if (overrides.dmarcError) throw overrides.dmarcError;
        return overrides.dmarc ?? [['v=DMARC1; p=none']];
      }
      if (overrides.txtError) throw overrides.txtError;
      return overrides.txt ?? [['google-site-verification=ignored'], ['v=spf1 ', 'mx -all']];
    },
    resolve4: async (name) => {
      calls.push(['a', name]);
      if (overrides.aError) throw overrides.aError;
      return overrides.ipv4 ?? ['203.0.113.10'];
    },
    resolve6: async (name) => {
      calls.push(['aaaa', name]);
      if (overrides.aaaaError) throw overrides.aaaaError;
      if (overrides.ipv6) return overrides.ipv6;
      throw absent();
    },
    reverse: async (address) => {
      calls.push(['ptr', address]);
      if (overrides.reverseError) throw overrides.reverseError;
      return overrides.ptr?.[address] ?? ['mail.example.com.'];
    },
  });
  return { inspector, calls };
}

test('reports bounded current/expected mail DNS state without pretending DKIM is configured', async () => {
  const { inspector, calls } = fixture();
  const result = await inspector.inspect('EXAMPLE.COM.');

  assert.equal(result.domainName, 'example.com');
  assert.equal(result.mailHostname, 'mail.example.com');
  assert.equal(result.observedAt, '2026-09-12T18:45:00.000Z');
  assert.equal(result.sideEffects, false);
  assert.equal(result.diagnostics.mx.state, 'ready');
  assert.deepEqual(result.diagnostics.mx.expected, { exchange: 'mail.example.com', priority: null });
  assert.deepEqual(result.diagnostics.mx.current, [{ priority: 10, exchange: 'mail.example.com' }]);
  assert.equal(result.diagnostics.spf.state, 'present');
  assert.deepEqual(result.diagnostics.spf.current, ['v=spf1 mx -all']);
  assert.equal(result.diagnostics.dmarc.state, 'present');
  assert.deepEqual(result.diagnostics.dmarc.current, ['v=DMARC1; p=none']);
  assert.equal(result.diagnostics.ptr.state, 'ready');
  assert.deepEqual(result.diagnostics.ptr.current, [{
    address: '203.0.113.10',
    names: ['mail.example.com'],
    state: 'ready',
  }]);
  assert.equal(result.diagnostics.dkim.state, 'not_configured');
  assert.equal(result.diagnostics.dkim.expected, null);
  assert.equal(result.diagnostics.dkim.action, 'configure_dkim_signing');
  assert.deepEqual(result.issues, [{
    kind: 'dkim',
    reasonCode: 'mail_dkim_not_configured',
    action: 'configure_dkim_signing',
  }]);
  assert.equal(result.attentionRequired, true);
  assert.ok(calls.some(([kind, name]) => kind === 'txt' && name === '_dmarc.example.com'));
});

test('reports actionable MX, SPF, DMARC and PTR mismatches without raw resolver errors', async () => {
  const { inspector } = fixture({
    mx: [{ priority: 5, exchange: 'mx.other.test' }],
    txtError: absent(),
    dmarcError: absent(),
    ptr: { '203.0.113.10': ['ptr.other.test'] },
  });
  const result = await inspector.inspect('example.com');

  assert.equal(result.diagnostics.mx.state, 'target_mismatch');
  assert.equal(result.diagnostics.mx.action, 'point_mail_mx_to_managed_hostname');
  assert.equal(result.diagnostics.spf.state, 'missing');
  assert.equal(result.diagnostics.spf.action, 'publish_spf_policy');
  assert.equal(result.diagnostics.dmarc.state, 'missing');
  assert.equal(result.diagnostics.dmarc.action, 'publish_dmarc_policy');
  assert.equal(result.diagnostics.ptr.state, 'target_mismatch');
  assert.equal(result.diagnostics.ptr.action, 'configure_ptr_with_server_provider');
  assert.deepEqual(result.issues.map((issue) => issue.kind), ['mx', 'spf', 'dkim', 'dmarc', 'ptr']);
  assert.doesNotMatch(JSON.stringify(result), /absent|ENODATA/i);
});

test('multiple SPF and DMARC records are surfaced instead of guessed as valid', async () => {
  const { inspector } = fixture({
    txt: [['v=spf1 mx -all'], ['V=SPF1 include:_spf.example.test ~all']],
    dmarc: [['v=DMARC1; p=none'], ['V=DMARC1; p=reject']],
  });
  const result = await inspector.inspect('example.com');

  assert.equal(result.diagnostics.spf.state, 'multiple');
  assert.equal(result.diagnostics.spf.action, 'consolidate_spf_records');
  assert.equal(result.diagnostics.dmarc.state, 'multiple');
  assert.equal(result.diagnostics.dmarc.action, 'consolidate_dmarc_records');
});

test('mail hostname address and resolver failures remain bounded diagnostics', async () => {
  const addressMissing = fixture({ aError: absent(), aaaaError: absent() });
  const missing = await addressMissing.inspector.inspect('example.com');
  assert.equal(missing.diagnostics.ptr.state, 'mail_hostname_address_missing');
  assert.equal(missing.diagnostics.ptr.action, 'publish_mail_hostname_address');

  const resolverFailure = fixture({ mxError: Object.assign(new Error('private resolver failure'), { code: 'ETIMEOUT' }) });
  const failed = await resolverFailure.inspector.inspect('example.com');
  assert.equal(failed.diagnostics.mx.state, 'resolver_error');
  assert.equal(failed.diagnostics.mx.action, 'retry_mail_dns_diagnostics');
  assert.doesNotMatch(JSON.stringify(failed), /private resolver failure|ETIMEOUT/);
});

test('invalid input and invalid Postfix hostname fail with authored bounded errors', async () => {
  const { inspector } = fixture();
  await assert.rejects(
    inspector.inspect('not a domain'),
    (error) => error instanceof MailDiagnosticsInspectorError
      && error.code === 'mail_diagnostics_domain_invalid' && error.status === 400,
  );

  const invalidHost = fixture({ mailHostname: 'bad host value' });
  await assert.rejects(
    invalidHost.inspector.inspect('example.com'),
    (error) => error instanceof MailDiagnosticsInspectorError
      && error.code === 'mail_diagnostics_hostname_invalid' && error.status === 503,
  );
});
