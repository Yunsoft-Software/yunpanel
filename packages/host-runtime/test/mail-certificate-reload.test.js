import assert from 'node:assert/strict';import test from 'node:test';import { execFile } from 'node:child_process';
import { promisify } from 'node:util';import { mkdtemp, readFile, rm } from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import { X509Certificate } from 'node:crypto';import net from 'node:net';import tls from 'node:tls';
import { probeMailCertificate, reloadMailCertificate } from '../src/mail-certificate-reload.js';
import { createMailConfigActivator } from '../src/mail-config-activator.js';
let root, pem, identity;
test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-certificate-'));
  await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=mail.example.com', '-addext', 'subjectAltName=DNS:mail.example.com', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert')]);
  pem = await readFile(path.join(root, 'cert'));identity = { hostname: 'mail.example.com', certName: 'mail.example.com',
    fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem', fingerprint256: new X509Certificate(pem).fingerprint256 };
});
test.after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
function fixture({ shutdown = 'no', fail = null, wrongFingerprint = false } = {}) {
  const calls = [];return { calls, options: { readFileFn: async () => pem,
    run: async (file, args) => { calls.push([file, args]);if (fail?.(file, args)) throw Error('PRIVATE_NATIVE_OUTPUT=/secret/key');
      const values = { myhostname: identity.hostname, smtpd_tls_cert_file: identity.fullchainPath, smtpd_tls_key_file: identity.privateKeyPath,
        ssl_cert: '<' + identity.fullchainPath, ssl_key: '<' + identity.privateKeyPath, shutdown_clients: shutdown };
      return { stdout: args[0] === '-h' ? values[args[1]] + '\n' : args[0] === 'is-active' ? 'active\n' : '', stderr: '' }; },
    probe: async target => { assert.deepEqual(target, { hostname: identity.hostname, fingerprint256: identity.fingerprint256 });
      calls.push(['probe']);return { imapFingerprint256: identity.fingerprint256, smtpFingerprint256: wrongFingerprint ? 'wrong' : identity.fingerprint256 }; },
  } };
}
test('validates native TLS paths/configuration and preserves sessions before reload and both protocol probes', async () => {
  const f = fixture();const proof = await reloadMailCertificate(identity, f.options);assert.equal(proof.status, 'succeeded');
  assert.deepEqual(f.calls.filter(([file,args]) => file === '/usr/bin/systemctl' && args[0] === 'reload').map(([,args]) => args[1]), ['dovecot', 'postfix']);
  assert.equal(f.calls.at(-1)[0], 'probe');assert.equal(JSON.stringify(proof).includes('/etc'), false);
});
for (const patch of [{ shutdown: 'yes' }, { fail: (f,a) => f === '/usr/sbin/postfix' && a[0] === 'check' }]) test('unsafe consumer state fails before any reload without native error leakage', async () => {
  const f = fixture(patch);await assert.rejects(reloadMailCertificate(identity, f.options), e => e.code === 'mail_certificate_reload_failed' && !e.message.includes('PRIVATE'));
  assert.equal(f.calls.some(([file,args]) => file === '/usr/bin/systemctl' && args[0] === 'reload'), false);
});
for (const patch of [{ fail: (f,a) => f === '/usr/bin/systemctl' && a[0] === 'reload' }, { wrongFingerprint: true }]) test('reload or protocol leaf mismatch is never native success', async () => {
  const f = fixture(patch);await assert.rejects(reloadMailCertificate(identity, f.options), { code: 'mail_certificate_reload_failed' });
});
test('foreign paths and certificate fingerprint fail before configuration commands', async () => {
  for (const patch of [{ fullchainPath: '/foreign/cert' }, { hostname: 'other.example.com' }, { fingerprint256: Array(32).fill('CD').join(':') }]) {
    const f = fixture();await assert.rejects(reloadMailCertificate({ ...identity, ...patch }, f.options), { code: 'mail_certificate_reload_failed' });assert.equal(f.calls.length, 0);
  }
});

test('TLS reloads share the existing mail activator serialization chain', async () => {
  const f = fixture();let release, entered;const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });let probes = 0;
  const activator = createMailConfigActivator({ ...f.options, probeCertificate: async target => {
    if (++probes === 1) { entered();await barrier; }return f.options.probe(target);
  } });
  const first = activator.reloadTlsIdentity(identity);await started;
  const before = f.calls.length;const second = activator.reloadTlsIdentity(identity);await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, before);assert.equal(probes, 1);release();
  assert.equal((await first).status, 'succeeded');assert.equal((await second).status, 'succeeded');assert.equal(probes, 2);
});

test('both probes perform real local TLS, including SMTP STARTTLS and hostname/fingerprint validation', async t => {
  const key = await readFile(path.join(root, 'key'));const sockets = new Set();
  const context = tls.createSecureContext({ cert: pem, key });
  const imap = tls.createServer({ cert: pem, key }, socket => { sockets.add(socket);socket.on('error', () => {}); });
  const smtp = net.createServer(socket => {
    sockets.add(socket);socket.on('error', () => {});socket.write('220 fixture ready\r\n');let buffer = '';
    function receive(chunk) { buffer += chunk.toString();if (!buffer.includes('\r\n')) return;
      const line = buffer.slice(0, buffer.indexOf('\r\n'));buffer = '';
      if (line === 'EHLO yunpanel.local') socket.write('250-fixture\r\n250 STARTTLS\r\n');
      else if (line === 'STARTTLS') { socket.removeListener('data', receive);socket.write('220 Ready for TLS\r\n', () => {
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });sockets.add(secure);secure.on('error', () => {});
      }); }else socket.destroy();
    }socket.on('data', receive);
  });
  await Promise.all([new Promise(resolve => imap.listen(0, '127.0.0.1', resolve)), new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve))]);
  t.after(async () => { for (const socket of sockets) socket.destroy();await Promise.all([new Promise(resolve => imap.close(resolve)), new Promise(resolve => smtp.close(resolve))]); });
  const connectors = {
    connectTcp: options => { assert.deepEqual(options, { host: '127.0.0.1', port: 587 });return net.createConnection({ ...options, port: smtp.address().port }); },
    connectTls: options => { assert.equal(options.rejectUnauthorized, true);assert.equal(options.servername, identity.hostname);
      return tls.connect({ ...options, ca: pem, ...(options.socket ? {} : { port: imap.address().port }) }); },
  };
  assert.deepEqual(await probeMailCertificate(identity, connectors), { imapFingerprint256: identity.fingerprint256, smtpFingerprint256: identity.fingerprint256 });
  await assert.rejects(probeMailCertificate({ ...identity, fingerprint256: Array(32).fill('CD').join(':') }, connectors), { code: 'mail_certificate_reload_failed' });
});
