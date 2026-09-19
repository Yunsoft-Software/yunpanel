import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDomainRemovalBackupImpactProvider,
  DomainRemovalBackupImpactError,
} from '../src/domain-removal-backup-impact.js';

function executionStep(stepId, resourceType, input) {
  return {
    stepId,
    resourceType,
    input,
  };
}

function completedStep(stepId, artifactId) {
  return {
    stepId,
    status: 'succeeded',
    workRef: { kind: 'local', id: 'work-' + stepId },
    evidence: {
      artifactId,
      contentSha256: 'a'.repeat(64),
      bytes: 10,
      createdAt: '2026-09-19T12:00:00.000Z',
    },
    error: null,
    updatedAt: '2026-09-19T12:00:00.000Z',
  };
}

function backupOperation() {
  const planSteps = [
    executionStep('step-app', 'application', { applicationId: 'app-1' }),
    executionStep('step-db', 'database', { databaseName: 'site_db' }),
    executionStep('step-docker', 'docker_storage', { projectId: 'project-2' }),
    executionStep('step-mail', 'mail_data', { mailDomainId: 'mail-2' }),
    executionStep('step-unrelated', 'application', { applicationId: 'app-other' }),
    executionStep('step-pending', 'application', { applicationId: 'app-1' }),
  ];
  return {
    id: 'backup-operation-1',
    serverId: 'server-1',
    status: 'failed',
    plan: { steps: planSteps },
    steps: [
      completedStep('step-app', 'artifact-app'),
      completedStep('step-db', 'artifact-db'),
      completedStep('step-docker', 'artifact-docker'),
      completedStep('step-mail', 'artifact-mail'),
      completedStep('step-unrelated', 'artifact-other'),
      {
        stepId: 'step-pending',
        status: 'pending',
        workRef: null,
        evidence: null,
        error: null,
        updatedAt: '2026-09-19T12:00:00.000Z',
      },
    ],
  };
}

function fixture({ missingDomain = false } = {}) {
  const domains = new Map([
    ['domain-1', { id: 'domain-1', serverId: 'server-1', websiteId: 'website-1' }],
    ['domain-2', { id: 'domain-2', serverId: 'server-1', websiteId: 'website-2' }],
  ]);
  const websites = new Map([
    ['website-1', {
      id: 'website-1',
      serverId: 'server-1',
      applicationId: 'app-1',
      managedComposeBinding: null,
    }],
    ['website-2', {
      id: 'website-2',
      serverId: 'server-1',
      applicationId: null,
      managedComposeBinding: { projectId: 'project-2' },
    }],
  ]);
  const provider = createDomainRemovalBackupImpactProvider({
    backupOperationRegistry: {
      async listOperations({ serverId }) {
        assert.equal(serverId, 'server-1');
        return [backupOperation()];
      },
    },
    domainRegistry: {
      async getDomain(id) {
        if (missingDomain) return null;
        return domains.get(id) ?? null;
      },
    },
    websiteRegistry: {
      async getWebsite(id) {
        return websites.get(id) ?? null;
      },
    },
    databaseBindingRegistry: {
      async listBindings({ serverId }) {
        assert.equal(serverId, 'server-1');
        return [
          { id: 'binding-1', serverId, websiteId: 'website-1', databaseName: 'site_db' },
          { id: 'binding-other', serverId, websiteId: 'website-other', databaseName: 'other_db' },
        ];
      },
    },
    mailDomainRegistry: {
      async listMailDomains() {
        return [
          { id: 'mail-2', webDomainId: 'domain-2' },
          { id: 'mail-other', webDomainId: 'domain-other' },
        ];
      },
    },
    localServerId: 'server-1',
  });
  return provider;
}

test('backup impact inventories retained artifacts across affected application, database, Docker and mail resources', async () => {
  const provider = fixture();

  const result = await provider({
    resourceType: 'domain',
    resourceId: 'domain-1',
    serverId: 'server-1',
    targetServerId: null,
    websiteId: 'website-1',
    applicationId: 'app-1',
    dockerWorkloadId: null,
    dockerProjectId: null,
    domainIds: ['domain-1', 'domain-2'],
  });

  assert.deepEqual(result, [
    { id: 'backup-operation-1:step-app', state: 'retained_application' },
    { id: 'backup-operation-1:step-db', state: 'retained_database' },
    { id: 'backup-operation-1:step-docker', state: 'retained_docker_storage' },
    { id: 'backup-operation-1:step-mail', state: 'retained_mail_data' },
  ]);
});

test('website impact remains scoped even when no Domain is currently linked', async () => {
  const provider = fixture();

  const result = await provider({
    resourceType: 'website',
    resourceId: 'website-1',
    serverId: 'server-1',
    targetServerId: null,
    websiteId: 'website-1',
    applicationId: 'app-1',
    dockerWorkloadId: null,
    dockerProjectId: null,
    domainIds: [],
  });

  assert.deepEqual(result, [
    { id: 'backup-operation-1:step-app', state: 'retained_application' },
    { id: 'backup-operation-1:step-db', state: 'retained_database' },
  ]);
});

test('backup impact ignores pending work and unrelated succeeded artifacts', async () => {
  const provider = fixture();

  const result = await provider({
    resourceType: 'domain',
    resourceId: 'domain-1',
    serverId: 'server-1',
    targetServerId: null,
    websiteId: null,
    applicationId: null,
    dockerWorkloadId: null,
    dockerProjectId: null,
    domainIds: ['domain-1'],
  });

  assert.deepEqual(result, [
    { id: 'backup-operation-1:step-app', state: 'retained_application' },
    { id: 'backup-operation-1:step-db', state: 'retained_database' },
  ]);
});

test('stale affected Domain state fails closed instead of reporting an empty backup inventory', async () => {
  const provider = fixture({ missingDomain: true });

  await assert.rejects(
    provider({
      resourceType: 'domain',
      resourceId: 'domain-1',
      serverId: 'server-1',
      targetServerId: null,
      websiteId: null,
      applicationId: null,
      dockerWorkloadId: null,
      dockerProjectId: null,
      domainIds: ['domain-1'],
    }),
    (error) => error instanceof DomainRemovalBackupImpactError
      && error.code === 'domain_removal_backup_domain_drift',
  );
});
