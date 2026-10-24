import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { normalizeDomainSet } from '@yunpanel/shared';

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const TIMEOUT = 15_000;
function failure() { return Object.assign(new Error('Managed mail certificate reload could not be verified'), { code: 'mail_certificate_reload_failed' }); }

function secureLeaf({ hostname, fingerprint256, socket = null, port = 993 }, { connectTls = tls.connect } = {}) {
  return new Promise((resolve, reject) => {
    const connection = connectTls({ ...(socket ? { socket } : { host: '127.0.0.1', port }),
      servername: hostname, rejectUnauthorized: true });
    const timer = setTimeout(() => finish(failure()), TIMEOUT);
    function finish(error) { clearTimeout(timer); connection.destroy(); error ? reject(error) : resolve(fingerprint256); }
    connection.once('error', () => finish(failure()));
    connection.once('secureConnect', () => finish(connection.authorized
      && connection.getPeerCertificate().fingerprint256 === fingerprint256 ? null : failure()));
  });
}

function smtpLeaf(identity, { connectTcp = net.createConnection, connectTls = tls.connect } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port: 587 });
    let buffer = '', bytes = 0, stage = 0, starttls = false, finished = false;
    const timer = setTimeout(() => fail(), TIMEOUT);
    function fail() { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); reject(failure()); }
    socket.once('error', fail); socket.once('end', fail);
    function receive(chunk) {
      bytes += chunk.length; if (bytes > 64 * 1024) return fail(); buffer += chunk.toString('ascii');
      while (buffer.includes('\n') && !finished) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!/^[0-9]{3}[- ]/.test(line)) return fail();
        const expected = stage === 1 ? '250' : '220'; if (!line.startsWith(expected)) return fail();
        if (stage === 1 && /^250[- ]STARTTLS(?:\s|$)/i.test(line)) starttls = true;
        if (line[3] !== ' ') continue;
        if (stage === 0) { stage = 1; socket.write('EHLO yunpanel.local\r\n'); }
        else if (stage === 1) { if (!starttls) return fail(); stage = 2; socket.write('STARTTLS\r\n'); }
        else {
          finished = true; clearTimeout(timer); socket.removeListener('data', receive); socket.removeListener('error', fail); socket.removeListener('end', fail);
          secureLeaf({ ...identity, socket }, { connectTls }).then(resolve, reject);
        }
      }
    }
    socket.on('data', receive);
  });
}

export async function probeMailCertificate(identity, connectors = {}) {
  const [imapFingerprint256, smtpFingerprint256] = await Promise.all([secureLeaf(identity, connectors), smtpLeaf(identity, connectors)]);
  return { imapFingerprint256, smtpFingerprint256 };
}

// Called only inside the mail activator's existing serialization chain.
export async function reloadMailCertificate(identity, { run, readFileFn, probe = probeMailCertificate } = {}) {
  try {
    const hostname = normalizeDomainSet(identity.hostname, []).primary;
    if (hostname !== identity.hostname || !FINGERPRINT.test(identity.fingerprint256)
      || identity.fullchainPath !== `/etc/letsencrypt/live/${identity.certName}/fullchain.pem`
      || identity.privateKeyPath !== `/etc/letsencrypt/live/${identity.certName}/privkey.pem`
      || normalizeDomainSet(identity.certName, []).primary !== identity.certName) throw failure();
    const certificate = new X509Certificate(await readFileFn(identity.fullchainPath));
    if (certificate.fingerprint256 !== identity.fingerprint256 || !certificate.checkHost(hostname)
      || Date.parse(certificate.validTo) <= Date.now()) throw failure();
    async function command(file, args) { return run(file, args, { timeout: TIMEOUT, maxBuffer: 256 * 1024 }); }
    async function exact(file, args, value) {
      if (String((await command(file, args)).stdout ?? '').trim() !== value) throw failure();
    }
    await exact('/usr/sbin/postconf', ['-h', 'myhostname'], hostname);
    await exact('/usr/sbin/postconf', ['-h', 'smtpd_tls_cert_file'], identity.fullchainPath);
    await exact('/usr/sbin/postconf', ['-h', 'smtpd_tls_key_file'], identity.privateKeyPath);
    await exact('/usr/bin/doveconf', ['-h', 'ssl_cert'], '<' + identity.fullchainPath);
    await exact('/usr/bin/doveconf', ['-h', 'ssl_key'], '<' + identity.privateKeyPath);
    await exact('/usr/bin/doveconf', ['-h', 'shutdown_clients'], 'no');
    await command('/usr/sbin/postfix', ['check']);
    await command('/usr/bin/doveconf', ['-n']);
    for (const service of ['dovecot', 'postfix']) {
      await command('/usr/bin/systemctl', ['reload', service]);
      await exact('/usr/bin/systemctl', ['is-active', service], 'active');
    }
    const proof = await probe({ hostname, fingerprint256: identity.fingerprint256 });
    if (proof?.imapFingerprint256 !== identity.fingerprint256 || proof?.smtpFingerprint256 !== identity.fingerprint256) throw failure();
    return { service: 'mail', stage: 'reload', status: 'succeeded', imapFingerprintVerified: true, smtpFingerprintVerified: true };
  } catch { throw failure(); }
}
