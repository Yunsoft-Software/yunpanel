import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATIONS } from '@yunpanel/protocol';
import {
  createRoundcubeWebmailEndpointResolver,
  RoundcubeWebmailEndpointResolverError,
} from '../src/roundcube-webmail-endpoint-resolver.js';

const mailDomain = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  webDomainId: '22222222-2222-4222-8222-222222222222',
  domainName: 'example.com',
  managementMode: 'local',
  status: 'enabled',
});
const domain = Object.freeze({
  id: mailDomain.webDomainId,
  serverId: '33333333-3333-4333-8333-333333333333',
  primaryDomain: 'example.com',
});
const mapping = Object.freeze({
  id: '44444444-4444-4444-8444-444444444444',
  mailDomainId: mailDomain.id,
  webDomainId: domain.id,
  serverId: domain.serverId,
  domainName: domain.primaryDomain,
  hostname: 'webmail.example.com',
  certificateId: '55555555-5555-4555-8555-555555555555',
  certificateFingerprint256: Array.from({ length: 32 }, () => 'AA').join(':'),
  revision: 2,
  updatedAt: '2026-09-19T15:00:00.000Z',
});
const preview = Object.freeze({
  readyToApply: true,
  sha256: 'a'.repeat(64),
  nginxSha256: 'b'.repeat(64),
  mappings: Object.freeze([{ ...mapping }]),
});

function fixture({
  currentMapping = mapping,
  currentPreview = preview,
  jobs = null,
} = {}) {
  const appliedJob = {
    id: 'roundcube-job-1',
    serverId: domain.serverId,
    operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
    resourceType: 'server',
    resourceId: domain.serverId,
    status: 'succeeded',
    createdAt: '2026-09-19T15:10:00.000Z',
    result: {
      previewSha256: preview.sha256,
      nginxSha256: preview.nginxSha256,
      httpHealthy: true,
      applied: true,
    },
  };
  return createRoundcubeWebmailEndpointResolver({
    roundcubeDomainMappingRegistry: {
      async getForMailDomain(id) {
        assert.equal(id, mailDomain.id);
        return currentMapping;
      },
    },
    roundcubeConfigurationService: {
      async previewForServer(id) {
        assert.equal(id, domain.serverId);
        return currentPreview;
      },
    },
    jobRegistry: {
      async listJobs({ serverId }) {
        assert.equal(serverId, domain.serverId);
        return jobs ?? [appliedJob];
      },
    },
  });
}

test('live Roundcube apply evidence exposes webmail endpoint readiness', async () => {
  const resolved = await fixture().resolve({ mailDomain, domain });

  assert.deepEqual(resolved, {
    version: 1,
    mailDomainId: mailDomain.id,
    serverId: domain.serverId,
    mappingId: mapping.id,
    mappingRevision: mapping.revision,
    hostname: mapping.hostname,
    protocol: 'https',
    path: '/',
    roundcubePreviewSha256: preview.sha256,
    roundcubeApplyJobId: 'roundcube-job-1',
    ready: true,
  });
});

test('desired mapping without exact successful Roundcube apply remains DNS-ineligible', async () => {
  const pending = await fixture({ jobs: [] }).resolve({ mailDomain, domain });
  assert.equal(pending, null);

  const wrongDigest = await fixture({
    jobs: [{
      id: 'roundcube-job-2',
      serverId: domain.serverId,
      operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
      resourceType: 'server',
      resourceId: domain.serverId,
      status: 'succeeded',
      result: {
        previewSha256: 'f'.repeat(64),
        nginxSha256: preview.nginxSha256,
        httpHealthy: true,
        applied: true,
      },
    }],
  }).resolve({ mailDomain, domain });
  assert.equal(wrongDigest, null);
});

test('missing mapping is an explicit not-ready state without reading Roundcube jobs', async () => {
  let previewReads = 0;
  const resolver = createRoundcubeWebmailEndpointResolver({
    roundcubeDomainMappingRegistry: { getForMailDomain: async () => null },
    roundcubeConfigurationService: {
      async previewForServer() { previewReads += 1; return preview; },
    },
    jobRegistry: { listJobs: async () => [] },
  });

  assert.equal(await resolver.resolve({ mailDomain, domain }), null);
  assert.equal(previewReads, 0);
});

test('mapping or current preview revision drift fails closed instead of publishing stale DNS', async () => {
  await assert.rejects(
    fixture({
      currentMapping: { ...mapping, hostname: 'webmail.other.example' },
    }).resolve({ mailDomain, domain }),
    (error) => error instanceof RoundcubeWebmailEndpointResolverError
      && error.code === 'roundcube_webmail_mapping_drift',
  );

  await assert.rejects(
    fixture({
      currentPreview: {
        ...preview,
        mappings: [{ ...mapping, revision: mapping.revision + 1 }],
      },
    }).resolve({ mailDomain, domain }),
    (error) => error instanceof RoundcubeWebmailEndpointResolverError
      && error.code === 'roundcube_webmail_preview_drift',
  );
});
