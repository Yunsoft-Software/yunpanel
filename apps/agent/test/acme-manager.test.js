import assert from 'node:assert/strict';
import test from 'node:test';
import { AcmeManagerError, createAcmeManager } from '../src/acme-manager.js';

function certificateMetadata(certName) {
  return {
    certName,
    certificatePath: `/etc/letsencrypt/live/${certName}/cert.pem`,
    fullchainPath: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    privateKeyPath: `/etc/letsencrypt/live/${certName}/privkey.pem`,
    subject: `CN=${certName}`,
    issuer: 'CN=Test CA',
    subjectAltName: `DNS:${certName}`,
    validFrom: '2026-09-08T00:00:00.000Z',
    validTo: '2026-12-07T00:00:00.000Z',
    fingerprint256: 'AA:BB',
  };
}

test('certificate issue uses fixed certbot binary and webroot arguments without shell strings', async () => {
  const calls = [];
  const directories = [];
  const manager = createAcmeManager({
    certbotPaths: ['/usr/bin/certbot'],
    accessFn: async (candidate) => {
      assert.equal(candidate, '/usr/bin/certbot');
    },
    mkdirFn: async (directory, options) => directories.push({ directory, options }),
    inspectCertificateFn: async (certName) => certificateMetadata(certName),
    run: async (file, args) => calls.push({ file, args }),
  });

  const result = await manager.issueCertificate({
    domains: ['example.com', 'www.example.com'],
    email: 'admin@example.com',
    staging: true,
  });

  assert.equal(directories[0].directory, '/var/lib/yunpanel/acme');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/certbot');
  assert.deepEqual(calls[0].args, [
    'certonly',
    '--webroot',
    '--webroot-path', '/var/lib/yunpanel/acme',
    '--non-interactive',
    '--agree-tos',
    '--email', 'admin@example.com',
    '--cert-name', 'example.com',
    '--test-cert',
    '-d', 'example.com',
    '-d', 'www.example.com',
  ]);
  assert.equal(result.certName, 'example.com');
  assert.deepEqual(result.domains, ['example.com', 'www.example.com']);
  assert.equal(result.staging, true);
});

test('certificate issue rejects wildcard and invalid email before certbot runs', async () => {
  let runs = 0;
  const manager = createAcmeManager({
    accessFn: async () => {},
    mkdirFn: async () => {},
    inspectCertificateFn: async () => certificateMetadata('example.com'),
    run: async () => { runs += 1; },
  });

  await assert.rejects(
    manager.issueCertificate({
      domains: ['*.example.com'],
      email: 'admin@example.com',
    }),
    (error) => error instanceof AcmeManagerError,
  );

  await assert.rejects(
    manager.issueCertificate({
      domains: ['example.com'],
      email: 'invalid-email',
    }),
    (error) => error instanceof AcmeManagerError && error.code === 'invalid_acme_email',
  );

  assert.equal(runs, 0);
});

test('renewal selects one certificate and supports dry-run without reading private material', async () => {
  const calls = [];
  let inspected = false;
  const manager = createAcmeManager({
    certbotPaths: ['/usr/local/bin/certbot'],
    accessFn: async () => {},
    run: async (file, args) => calls.push({ file, args }),
    inspectCertificateFn: async () => {
      inspected = true;
      return certificateMetadata('example.com');
    },
  });

  const result = await manager.renewCertificate({ certName: 'example.com', dryRun: true });

  assert.deepEqual(calls[0], {
    file: '/usr/local/bin/certbot',
    args: ['renew', '--cert-name', 'example.com', '--non-interactive', '--dry-run'],
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.dryRun, true);
  assert.equal(inspected, false);
});

test('certbot execution errors are sanitized', async () => {
  const manager = createAcmeManager({
    accessFn: async () => {},
    mkdirFn: async () => {},
    run: async () => {
      const error = new Error('stderr contains sensitive server details');
      error.code = 1;
      throw error;
    },
  });

  await assert.rejects(
    manager.issueCertificate({
      domains: ['example.com'],
      email: 'admin@example.com',
    }),
    (error) => {
      assert.equal(error.code, 'certbot_failed');
      assert.equal(error.message, 'Certbot operation failed');
      assert.equal(error.exitCode, 1);
      assert.equal(error.message.includes('sensitive'), false);
      return true;
    },
  );
});
