import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createAcmeManager } from '../src/acme-manager.js';

const execFileAsync = promisify(execFile);

async function generateCertificate(directory, name) {
  const certificatePath = path.join(directory, `${name}.crt`);
  const privateKeyPath = path.join(directory, `${name}.key`);
  await execFileAsync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=secure.example.com',
    '-addext', 'subjectAltName=DNS:secure.example.com',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  return {
    certificatePem: await readFile(certificatePath, 'utf8'),
    privateKeyPem: await readFile(privateKeyPath, 'utf8'),
  };
}

test('ACME inspection accepts a matched pair and rejects replaced private-key material', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-acme-pair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const liveRoot = path.join(directory, 'live');
  const certificateDirectory = path.join(liveRoot, 'secure.example.com');
  await mkdir(certificateDirectory, { recursive: true });
  const first = await generateCertificate(directory, 'first');
  const second = await generateCertificate(directory, 'second');
  await writeFile(path.join(certificateDirectory, 'cert.pem'), first.certificatePem, 'utf8');
  await writeFile(path.join(certificateDirectory, 'privkey.pem'), first.privateKeyPem, 'utf8');

  const manager = createAcmeManager({ liveRoot });
  const inspected = await manager.inspectCertificate('secure.example.com');
  assert.equal(inspected.certName, 'secure.example.com');
  assert.match(inspected.fingerprint256, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  await writeFile(path.join(certificateDirectory, 'privkey.pem'), second.privateKeyPem, 'utf8');
  await assert.rejects(
    manager.inspectCertificate('secure.example.com'),
    (error) => error.code === 'certificate_private_key_mismatch'
      && !/BEGIN|PRIVATE KEY/.test(error.message),
  );
});

test('Cloudflare DNS-01 uses a private temporary credential file without putting token in argv', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-acme-dns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialRoot = path.join(directory, 'credentials');
  const calls = [];
  const token = 'cloudflare_dns_private_token_123456';
  const challenge = {
    type: 'dns-01',
    provider: 'cloudflare',
    credentialId: '12345678-1234-4234-8234-123456789012',
    dnsZoneId: '22345678-1234-4234-8234-123456789012',
    propagationSeconds: 30,
  };
  const dnsCredential = {
    id: challenge.credentialId,
    dnsZoneId: challenge.dnsZoneId,
    provider: 'cloudflare',
    token,
  };
  const manager = createAcmeManager({
    credentialRoot,
    certbotPaths: ['/usr/bin/certbot'],
    accessFn: async () => {},
    run: async (file, args) => {
      const credentialIndex = args.indexOf('--dns-cloudflare-credentials');
      assert.notEqual(credentialIndex, -1);
      const credentialContent = await readFile(args[credentialIndex + 1], 'utf8');
      assert.equal(credentialContent, `dns_cloudflare_api_token = ${token}\n`);
      assert.doesNotMatch(JSON.stringify({ file, args }), new RegExp(token));
      calls.push({ file, args });
    },
  });

  const result = await manager.issueCertificate({
    domains: ['example.com', '*.example.com'],
    email: 'owner@example.com',
    staging: true,
    challenge,
  }, { dnsCredential });
  assert.equal(result.status, 'validated');
  assert.deepEqual(result.domains, ['example.com', '*.example.com']);
  assert.equal(calls[0].args.includes('--webroot'), false);
  assert.deepEqual(await readdir(credentialRoot), []);

  const renewed = await manager.renewCertificate({ certName: 'example.com', dryRun: true, challenge }, { dnsCredential });
  assert.equal(renewed.status, 'validated');
  assert.equal(calls[1].args.includes('--dns-cloudflare'), true);
  assert.deepEqual(await readdir(credentialRoot), []);
});
