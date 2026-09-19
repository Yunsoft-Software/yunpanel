import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoundcubeDomainMappingRegistry,
  RoundcubeDomainMappingRegistryError,
} from '../src/roundcube-domain-mapping-registry.js';

const mailDomainId = '11111111-1111-4111-8111-111111111111';
const webDomainId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const certificateId = '44444444-4444-4444-8444-444444444444';
const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');

function fixture({
  mailStatus = 'enabled',
  certificateState = 'active',
  inspectedFingerprint = fingerprint,
  now = (() => {
    let value = Date.parse('2026-09-19T14:00:00.000Z');
    return () => value++;
  })(),
} = {}) {
  const registry = createRoundcubeDomainMappingRegistry({
    now,
    getMailDomain: async () => ({
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: mailStatus,
      revision: 4,
    }),
    getDomain: async () => ({
      id: webDomainId,
      serverId,
      primaryDomain: 'example.com',
      desiredRevision: 8,
    }),
    getCertificate: async () => ({
      id: certificateId,
      domainId: webDomainId,
      serverId,
      state: certificateState,
      staging: false,
      fingerprint256: fingerprint,
      updatedAt: '2026-09-19T13:00:00.000Z',
    }),
    inspectCertificate: async ({ certificate, domains }) => {
      assert.equal(certificate.id, certificateId);
      assert.deepEqual(domains, ['webmail.example.com']);
      return { fingerprint256: inspectedFingerprint };
    },
  });
  return registry;
}

test('bind preview pins exact local mail, Domain and certificate evidence without material paths', async () => {
  const registry = fixture();
  const preview = await registry.previewBind({ mailDomainId, certificateId });

  assert.equal(preview.hostname, 'webmail.example.com');
  assert.equal(preview.currentRevision, 0);
  assert.equal(preview.mailDomainRevision, 4);
  assert.equal(preview.domainRevision, 8);
  assert.equal(preview.certificateFingerprint256, fingerprint);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.confirmation, /^bind-roundcube-domain:/);
  assert.equal(JSON.stringify(preview).includes('privkey'), false);
  assert.equal(JSON.stringify(preview).includes('/etc/letsencrypt'), false);
});

test('bind persists one revisioned mapping and exact no-change becomes a conflict', async () => {
  const registry = fixture();
  const preview = await registry.previewBind({ mailDomainId, certificateId });
  const created = await registry.bind({
    mailDomainId,
    certificateId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(created.revision, 1);
  assert.equal(created.hostname, 'webmail.example.com');
  assert.equal((await registry.listMappings({ serverId })).length, 1);
  assert.deepEqual(await registry.getForMailDomain(mailDomainId), created);

  await assert.rejects(
    registry.previewBind({ mailDomainId, certificateId }),
    (error) => error instanceof RoundcubeDomainMappingRegistryError
      && error.code === 'roundcube_mapping_no_change',
  );
});

test('mapping requires enabled local mail and an active hostname-covering certificate', async () => {
  await assert.rejects(
    fixture({ mailStatus: 'disabled' }).previewBind({ mailDomainId, certificateId }),
    (error) => error.code === 'roundcube_mapping_mail_domain_not_ready',
  );
  await assert.rejects(
    fixture({ certificateState: 'superseded' }).previewBind({ mailDomainId, certificateId }),
    (error) => error.code === 'roundcube_mapping_certificate_not_ready',
  );
  await assert.rejects(
    fixture({ inspectedFingerprint: Array.from({ length: 32 }, () => 'BB').join(':') })
      .previewBind({ mailDomainId, certificateId }),
    (error) => error.code === 'roundcube_mapping_certificate_drift',
  );
});

test('typed delete removes only the exact current mapping revision', async () => {
  const registry = fixture();
  const bind = await registry.previewBind({ mailDomainId, certificateId });
  const created = await registry.bind({
    mailDomainId,
    certificateId,
    previewDigest: bind.previewDigest,
    confirmation: bind.confirmation,
  });
  const preview = await registry.previewDelete(mailDomainId);

  await assert.rejects(
    registry.deleteMapping(mailDomainId, {
      expectedRevision: created.revision + 1,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (error) => error.code === 'roundcube_mapping_confirmation_invalid',
  );

  const deleted = await registry.deleteMapping(mailDomainId, {
    expectedRevision: created.revision,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.deepEqual(deleted, { id: created.id, mailDomainId, deleted: true });
  assert.equal(await registry.getForMailDomain(mailDomainId), null);
});
