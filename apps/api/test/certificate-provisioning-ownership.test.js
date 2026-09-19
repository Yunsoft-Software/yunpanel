import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCertificateRegistry,
  CertificateRegistryError,
} from '../src/certificate-registry.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';

test('managed certificate records persist exact Website provisioning ownership', async () => {
  const registry = createCertificateRegistry();
  const certificate = await registry.createForDomain({
    domainId: 'domain-1',
    serverId: 'server-1',
    domains: ['example.com', 'webmail.example.com'],
    email: 'ops@example.com',
    provisioningOperationId: operationId,
  });

  assert.equal(certificate.provisioningOperationId, operationId);
  assert.equal((await registry.getCertificate(certificate.id)).provisioningOperationId, operationId);
  await assert.rejects(
    registry.createForDomain({
      domainId: 'domain-2',
      serverId: 'server-1',
      domains: ['other.example.com'],
      email: 'ops@example.com',
      provisioningOperationId: 'bad operation id with spaces',
    }),
    (error) => error instanceof CertificateRegistryError
      && error.code === 'invalid_certificate_provisioning_operation',
  );
});

test('version four certificate state hydrates with null provisioning ownership and upgrades on mutation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cert-v4-'));
  const filePath = path.join(directory, 'certificates.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const seed = createCertificateRegistry();
  const certificate = await seed.createForDomain({
    domainId: 'domain-1',
    serverId: 'server-1',
    domains: ['example.com'],
    email: 'ops@example.com',
  });
  const legacy = { ...certificate };
  delete legacy.provisioningOperationId;
  await writeFile(filePath, JSON.stringify({ version: 4, certificates: [legacy] }));

  const registry = createCertificateRegistry({ filePath });
  const loaded = await registry.getCertificate(certificate.id);
  assert.equal(loaded.provisioningOperationId, null);

  await registry.setState(certificate.id, 'issuing');
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 6);
  assert.equal(persisted.certificates[0].provisioningOperationId, null);
});
