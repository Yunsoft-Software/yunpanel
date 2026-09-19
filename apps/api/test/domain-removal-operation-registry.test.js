import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDomainRemovalOperationRegistry,
  domainRemovalOperationPublicView,
  domainRemovalOperationRegistryInternals,
  DomainRemovalOperationRegistryError,
} from '../src/domain-removal-operation-registry.js';

const checksum = 'a'.repeat(64);
const impactDigest = 'b'.repeat(64);
const previewDigest = 'c'.repeat(64);
const dnsPreviewDigest = 'd'.repeat(64);
const zoneSnapshotDigest = 'e'.repeat(64);
const evidenceDigest = 'f'.repeat(64);
const ownershipEvidenceDigest = '1'.repeat(64);

function preview() {
  return {
    version: 1,
    operation: 'domain_remove',
    domain: {
      id: 'domain-1',
      serverId: 'local',
      primaryDomain: 'example.com',
      websiteId: 'website-1',
      certificateId: 'certificate-1',
      parentDomainId: null,
      state: 'active',
      desiredRevision: 4,
      checksum,
      suspensionOperationId: null,
    },
    impact: {
      previewDigest: impactDigest,
      confirmation: `delete:domain:domain-1:${impactDigest}`,
      blockers: [
        'authoritative_dns_retirement_blocked',
        'certificates_present',
        'child_domains_present',
        'impact_apply_not_implemented',
        'mail_domains_present',
        'website_binding_present',
      ],
    },
    plan: {
      childDomainIds: ['child-domain-1'],
      childDomains: [{
        id: 'child-domain-1',
        serverId: 'local',
        primaryDomain: 'api.example.com',
        websiteId: 'website-2',
        certificateId: null,
        parentDomainId: 'domain-1',
        state: 'active',
        desiredRevision: 2,
        checksum: '2'.repeat(64),
        suspensionOperationId: null,
        authoritativeDns: {
          state: 'not_applicable',
          previewDigest: '2'.repeat(64),
          zoneSnapshotDigest: null,
          ownershipEvidenceDigest: null,
          snapshotRetentionDays: null,
          blockers: [],
        },
      }],
      websiteId: 'website-1',
      applicationId: 'application-1',
      managedComposeProjectId: null,
      certificateIds: ['certificate-1'],
      certificateIntents: [{
        id: 'certificate-1',
        domainId: 'domain-1',
        serverId: 'local',
        state: 'active',
        source: 'acme',
        renewalMode: 'automatic',
        staging: false,
        validTo: '2026-12-01T00:00:00.000Z',
        updatedAt: '2026-09-18T20:00:00.000Z',
        retirementOperationId: null,
        retiredAt: null,
        retiredFromState: null,
      }],
      boundCertificateId: 'certificate-1',
      dnsZoneIds: ['external-zone-1'],
      mailDomainIds: ['mail-domain-1'],
      mailDomainIntents: [{
        id: 'mail-domain-1',
        domainName: 'example.com',
        webDomainId: 'domain-1',
        managementMode: 'local',
        status: 'disabled',
        revision: 3,
        updatedAt: '2026-09-18T20:00:00.000Z',
      }],
      activeJobIds: [],
      additional: {
        mailboxes: { status: 'available', ids: [] },
        backups: { status: 'available', ids: [] },
        crons: { status: 'available', ids: [] },
        dockerWorkloads: { status: 'available', ids: [] },
      },
      authoritativeDns: {
        state: 'blocked',
        previewDigest: dnsPreviewDigest,
        zoneSnapshotDigest,
        ownershipEvidenceDigest,
        snapshotRetentionDays: 30,
        blockers: ['domain_routing_active', 'domain_website_binding_present'],
      },
    },
    hardBlockers: [],
    readyToStart: true,
    previewDigest,
    confirmation: `start-domain-remove:domain-1:4:${previewDigest}`,
    sideEffects: false,
  };
}

test('journals deterministic reverse-dependency steps and preserves private start confirmations', async () => {
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'operation-1',
    now: () => Date.parse('2026-09-18T20:00:00.000Z'),
  });
  const operation = await registry.create(preview());

  assert.equal(operation.id, 'operation-1');
  assert.equal(operation.parentOperationId, null);
  assert.deepEqual(
    operation.steps.map((step) => step.kind),
    [
      'routing_suspend',
      'child_domain',
      'certificate',
      'mail_domain',
      'external_dns_zone',
      'website_binding',
      'authoritative_dns',
      'metadata_finalization',
    ],
  );
  assert.equal(operation.steps[0].resourceId, 'domain-1');
  assert.equal(operation.steps.at(-1).resourceId, 'domain-1');

  const duplicate = await registry.create(preview());
  assert.equal(duplicate.id, operation.id);

  const publicView = domainRemovalOperationPublicView(operation);
  assert.equal(publicView.impactPreviewDigest, impactDigest);
  assert.equal(publicView.parentOperationId, null);
  assert.equal(Object.hasOwn(publicView, 'impactConfirmation'), false);
  assert.equal(Object.hasOwn(publicView, 'startConfirmation'), false);
});

test('parent journal delegates descendant certificates to child Domain operations', async () => {
  const input = preview();
  input.plan.childDomains[0] = {
    ...input.plan.childDomains[0],
    certificateId: 'child-certificate-1',
  };
  input.plan.certificateIds = ['certificate-1', 'child-certificate-1'];
  input.plan.certificateIntents = [
    ...input.plan.certificateIntents,
    {
      ...input.plan.certificateIntents[0],
      id: 'child-certificate-1',
      domainId: 'child-domain-1',
    },
  ];
  input.plan.mailDomainIds = ['mail-domain-1', 'mail-domain-child-1'];
  input.plan.mailDomainIntents = [
    ...input.plan.mailDomainIntents,
    {
      ...input.plan.mailDomainIntents[0],
      id: 'mail-domain-child-1',
      domainName: 'api.example.com',
      webDomainId: 'child-domain-1',
    },
  ];
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'operation-1',
    now: () => Date.parse('2026-09-18T20:00:00.000Z'),
  });

  const operation = await registry.create(input);

  assert.deepEqual(
    operation.steps.filter((step) => step.kind === 'certificate').map((step) => step.resourceId),
    ['certificate-1'],
  );
  assert.equal(operation.plan.certificateIntents.length, 2);
  assert.deepEqual(
    operation.steps.filter((step) => step.kind === 'mail_domain').map((step) => step.resourceId),
    ['mail-domain-1'],
  );
  assert.equal(operation.plan.mailDomainIntents.length, 2);
});

test('binds child operations to one parent and blocks concurrent Domain removal ownership', async () => {
  let nextId = 0;
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => `operation-${++nextId}`,
    now: () => Date.parse('2026-09-18T20:00:00.000Z') + nextId,
  });
  const parent = await registry.create(preview());
  const ownedPreview = preview();
  ownedPreview.domain = {
    ...ownedPreview.domain,
    id: 'owned-domain-1',
    primaryDomain: 'owned.example.com',
    certificateId: null,
  };
  ownedPreview.plan = {
    ...ownedPreview.plan,
    certificateIds: [],
    certificateIntents: [],
    boundCertificateId: null,
    mailDomainIds: [],
    mailDomainIntents: [],
  };
  ownedPreview.impact = {
    ...ownedPreview.impact,
    confirmation: `delete:domain:owned-domain-1:${ownedPreview.impact.previewDigest}`,
  };
  ownedPreview.previewDigest = '8'.repeat(64);
  ownedPreview.confirmation = `start-domain-remove:owned-domain-1:4:${ownedPreview.previewDigest}`;
  await assert.rejects(
    registry.create(ownedPreview, { parentOperationId: 'missing-parent' }),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_parent_operation_invalid',
  );
  const child = await registry.create(ownedPreview, { parentOperationId: parent.id });
  assert.equal(child.parentOperationId, parent.id);
  assert.equal(domainRemovalOperationPublicView(child).parentOperationId, parent.id);

  const duplicate = await registry.create(ownedPreview, { parentOperationId: parent.id });
  assert.equal(duplicate.id, child.id);

  const conflicting = ownedPreview;
  conflicting.previewDigest = '9'.repeat(64);
  conflicting.confirmation = `start-domain-remove:owned-domain-1:4:${conflicting.previewDigest}`;
  await assert.rejects(
    registry.create(conflicting, { parentOperationId: parent.id }),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_conflict',
  );
});

test('omits authoritative DNS mutation when the removal plan has no local zone', async () => {
  const withoutAuthoritativeDns = preview();
  withoutAuthoritativeDns.plan = {
    ...withoutAuthoritativeDns.plan,
    authoritativeDns: null,
  };
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'operation-1',
    now: () => Date.parse('2026-09-18T20:00:00.000Z'),
  });

  const operation = await registry.create(withoutAuthoritativeDns);

  assert.equal(operation.steps.some((step) => step.kind === 'authoritative_dns'), false);
  assert.equal(operation.steps.at(-1).kind, 'metadata_finalization');
});

test('legacy journal plans load fail-closed without inventing DNS ownership or retention evidence', () => {
  const legacy = preview().plan;
  delete legacy.authoritativeDns.ownershipEvidenceDigest;
  delete legacy.authoritativeDns.snapshotRetentionDays;

  const normalized = domainRemovalOperationRegistryInternals.normalizedPlan(legacy);

  assert.equal(normalized.authoritativeDns.zoneSnapshotDigest, zoneSnapshotDigest);
  assert.equal(normalized.authoritativeDns.ownershipEvidenceDigest, null);
  assert.equal(normalized.authoritativeDns.snapshotRetentionDays, null);
});

test('legacy journal plans load without inventing exact child Domain intent evidence', () => {
  const legacy = preview().plan;
  delete legacy.childDomains;
  delete legacy.certificateIntents;
  delete legacy.boundCertificateId;
  delete legacy.mailDomainIntents;

  const normalized = domainRemovalOperationRegistryInternals.normalizedPlan(legacy);

  assert.deepEqual(normalized.childDomainIds, ['child-domain-1']);
  assert.equal(normalized.childDomains, null);
});

test('prior journal plans load without inventing certificate retirement evidence', () => {
  const prior = preview().plan;
  delete prior.certificateIntents;
  delete prior.boundCertificateId;
  delete prior.mailDomainIntents;

  const normalized = domainRemovalOperationRegistryInternals.normalizedPlan(prior);

  assert.equal(normalized.certificateIntents, null);
  assert.equal(normalized.boundCertificateId, null);
});

test('certificate-era journal plans load without inventing Mail Domain removal evidence', () => {
  const prior = preview().plan;
  delete prior.mailDomainIntents;

  const normalized = domainRemovalOperationRegistryInternals.normalizedPlan(prior);

  assert.equal(normalized.certificateIntents.length, 1);
  assert.equal(normalized.mailDomainIntents, null);
});

test('prior child snapshots load without inventing authoritative DNS intent', () => {
  const legacy = preview().plan;
  delete legacy.childDomains[0].authoritativeDns;

  const normalized = domainRemovalOperationRegistryInternals.normalizedPlan(legacy);

  assert.equal(normalized.childDomains[0].authoritativeDns, null);
});

test('legacy operations load without inventing parent ownership', () => {
  const current = domainRemovalOperationRegistryInternals.operationFromPreview(
    preview(),
    () => Date.parse('2026-09-18T20:00:00.000Z'),
    () => 'operation-1',
  );
  const legacy = JSON.parse(JSON.stringify(current));
  delete legacy.parentOperationId;

  const normalized = domainRemovalOperationRegistryInternals.persistedOperation(legacy);

  assert.equal(normalized.parentOperationId, null);
});

test('new operations reject missing or drifted child Domain intent evidence', async () => {
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'operation-1',
    now: () => Date.parse('2026-09-18T20:00:00.000Z'),
  });
  const legacy = preview();
  delete legacy.plan.childDomains;

  await assert.rejects(
    registry.create(legacy),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_state_invalid',
  );

  const drifted = preview();
  drifted.plan.childDomains[0] = {
    ...drifted.plan.childDomains[0],
    id: 'different-child',
  };
  await assert.rejects(
    registry.create(drifted),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_state_invalid',
  );

  const missingDnsIntent = preview();
  delete missingDnsIntent.plan.childDomains[0].authoritativeDns;
  await assert.rejects(
    registry.create(missingDnsIntent),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_state_invalid',
  );

  const missingCertificateIntent = preview();
  delete missingCertificateIntent.plan.certificateIntents;
  await assert.rejects(
    registry.create(missingCertificateIntent),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_state_invalid',
  );

  const missingMailDomainIntent = preview();
  delete missingMailDomainIntent.plan.mailDomainIntents;
  await assert.rejects(
    registry.create(missingMailDomainIntent),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_state_invalid',
  );

  const driftedCertificateBinding = preview();
  driftedCertificateBinding.plan.boundCertificateId = null;
  await assert.rejects(
    registry.create(driftedCertificateBinding),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_state_invalid',
  );
});

test('enforces journal order and allows failed or blocked current step retry', async () => {
  let clock = Date.parse('2026-09-18T20:00:00.000Z');
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'operation-1',
    now: () => clock++,
  });
  let operation = await registry.create(preview());
  const [routing, child] = operation.steps;

  await assert.rejects(
    registry.markStepRunning(operation.id, child.id),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_step_out_of_order',
  );

  operation = await registry.markStepRunning(operation.id, routing.id);
  assert.equal(operation.status, 'running');
  assert.equal((await registry.listInterrupted()).length, 1);

  operation = await registry.failStep(operation.id, routing.id, {
    code: 'domain_suspend_failed',
    message: 'Suspend failed',
  });
  assert.equal(operation.status, 'failed');

  operation = await registry.markStepRunning(operation.id, routing.id);
  operation = await registry.succeedStep(operation.id, routing.id, {
    referenceId: 'suspension-operation-1',
    evidenceDigest,
  });
  assert.equal(operation.steps[0].status, 'succeeded');

  operation = await registry.blockStep(operation.id, child.id, {
    code: 'child_domain_removal_pending',
    message: 'Child Domain removal is still pending',
  });
  assert.equal(operation.status, 'blocked');

  operation = await registry.markStepRunning(operation.id, child.id);
  operation = await registry.succeedStep(operation.id, child.id, {
    referenceId: 'child-removal-operation-1',
    evidenceDigest,
  });
  assert.equal(operation.steps[1].status, 'succeeded');
});

test('persists root-private running state and reloads interrupted operation without replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-removal-'));
  const stateDir = path.join(root, 'state');
  const filePath = path.join(stateDir, 'domain-removal-operations.json');
  let clock = Date.parse('2026-09-18T20:00:00.000Z');
  try {
    const first = createDomainRemovalOperationRegistry({
      filePath,
      idFactory: () => 'operation-1',
      now: () => clock++,
    });
    await first.init();
    let operation = await first.create(preview());
    operation = await first.markStepRunning(operation.id, operation.steps[0].id);

    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.operations[0].steps[0].status, 'running');
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);

    const second = createDomainRemovalOperationRegistry({
      filePath,
      now: () => clock++,
    });
    const recovery = await second.init();
    assert.equal(recovery, undefined);
    const interrupted = await second.listInterrupted();
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].id, 'operation-1');
    assert.equal(interrupted[0].steps[0].status, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operation becomes removed only after every journaled step succeeds', async () => {
  let clock = Date.parse('2026-09-18T20:00:00.000Z');
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'operation-1',
    now: () => clock++,
  });
  let operation = await registry.create(preview());

  while (operation.status !== 'removed') {
    const step = operation.steps.find((candidate) => candidate.status !== 'succeeded');
    operation = await registry.markStepRunning(operation.id, step.id);
    operation = await registry.succeedStep(operation.id, step.id, {
      referenceId: `evidence-${step.kind}`,
      evidenceDigest,
    });
  }

  assert.equal(operation.status, 'removed');
  assert.equal(operation.steps.every((step) => step.status === 'succeeded'), true);
  assert.equal((await registry.listInterrupted()).length, 0);
  await assert.rejects(
    registry.markStepRunning(operation.id, operation.steps.at(-1).id),
    (error) => error instanceof DomainRemovalOperationRegistryError
      && error.code === 'domain_removal_operation_not_runnable',
  );
});
