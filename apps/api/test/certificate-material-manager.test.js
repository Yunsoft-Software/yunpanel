import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  CertificateMaterialError,
  createCertificateMaterialManager,
} from '../src/certificate-material-manager.js';

const execFileAsync = promisify(execFile);

async function generateCertificate(directory, name, domains) {
  const certificatePath = path.join(directory, `${name}.crt`);
  const privateKeyPath = path.join(directory, `${name}.key`);
  await execFileAsync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', `/CN=${domains[0]}`,
    '-addext', `subjectAltName=${domains.map((domain) => `DNS:${domain}`).join(',')}`,
    '-keyout', privateKeyPath,
    '-out', certificatePath,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  return {
    certificatePem: await readFile(certificatePath, 'utf8'),
    privateKeyPem: await readFile(privateKeyPath, 'utf8'),
  };
}

test('custom certificate inspection proves hostname coverage and private-key identity without returning PEM', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-material-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await generateCertificate(directory, 'first', ['example.com', 'www.example.com']);
  const second = await generateCertificate(directory, 'second', ['example.com']);
  const manager = createCertificateMaterialManager({ customRoot: path.join(directory, 'custom'), getUid: () => 0 });

  const inspected = manager.inspectInput({ ...first, domains: ['example.com', 'www.example.com'] });
  assert.match(inspected.materialDigest, /^[a-f0-9]{64}$/);
  assert.match(inspected.fingerprint256, /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  assert.deepEqual(inspected.domains, ['example.com', 'www.example.com']);
  assert.doesNotMatch(JSON.stringify(inspected), /BEGIN (?:CERTIFICATE|PRIVATE KEY)|privateKeyPem|certificatePem/);

  assert.throws(
    () => manager.inspectInput({ certificatePem: first.certificatePem, privateKeyPem: second.privateKeyPem, domains: ['example.com'] }),
    (error) => error instanceof CertificateMaterialError && error.code === 'certificate_private_key_mismatch',
  );
  assert.throws(
    () => manager.inspectInput({ ...first, domains: ['api.example.com'] }),
    (error) => error instanceof CertificateMaterialError && error.code === 'certificate_domain_mismatch',
  );
});

test('custom certificate install is root-only, private and re-inspectable from fixed paths', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const material = await generateCertificate(directory, 'wildcard', ['*.example.com', 'example.com']);
  const customRoot = path.join(directory, 'custom');
  const certificateId = '12345678-1234-4234-8234-123456789012';
  const denied = createCertificateMaterialManager({ customRoot, getUid: () => 501 });
  assert.throws(
    () => denied.inspectInput({ ...material, domains: ['api.example.com'] }),
    (error) => error instanceof CertificateMaterialError && error.code === 'certificate_root_required',
  );

  const manager = createCertificateMaterialManager({ customRoot, getUid: () => 0 });
  const installed = await manager.installCustom({ certificateId, ...material, domains: ['api.example.com'] });
  assert.equal(installed.certificateId, certificateId);
  assert.equal(installed.privateKeyPath, path.join(customRoot, certificateId, 'privkey.pem'));
  assert.equal((await stat(customRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(installed.privateKeyPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(installed), /BEGIN (?:CERTIFICATE|PRIVATE KEY)|privateKeyPem|certificatePem/);

  const inspected = await manager.inspectStored({
    certificate: {
      id: certificateId,
      certName: 'api.example.com',
      source: 'custom',
      staging: false,
      certificatePath: installed.certificatePath,
      fullchainPath: installed.fullchainPath,
      privateKeyPath: installed.privateKeyPath,
    },
    domains: ['api.example.com'],
  });
  assert.equal(inspected.materialDigest, installed.materialDigest);
  assert.equal(inspected.fingerprint256, installed.fingerprint256);
  assert.equal(await manager.removeCustom(installed.certificateId), true);
  assert.equal(await manager.removeCustom(installed.certificateId), false);
});
