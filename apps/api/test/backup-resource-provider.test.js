import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackupResourceProviderError,
  createBackupResourceProvider,
} from '../src/backup-resource-provider.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';
const projectId = '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';
const webDomainId = 'c2591ea3-e1c2-4c37-a194-cc5650acd9ef';
const mailDomainId = 'f15f21e0-3ce8-47cf-93bf-d45c8c723246';

function fixture({ databaseInventory = undefined, mailPreviewError = null } = {}) {
  const calls = { environment: [], mail: [] };
  const provider = createBackupResourceProvider({
    serverRegistry: {
      async getServer(id) { return id === serverId ? { id: serverId, executionMode: 'local' } : null; },
    },
    dockerComposeProjectRegistry: {
      async listProjects({ serverId: requested }) {
        assert.equal(requested, serverId);
        return [{
          id: projectId,
          serverId,
          projectName: 'shop_stack',
          revision: 3,
          services: [{
            name: 'web',
            storageMounts: [
              { kind: 'named_volume', source: 'uploads', sourceScope: 'project', target: '/app/uploads', readOnly: false },
              { kind: 'ephemeral', source: null, sourceScope: null, target: '/tmp/cache', readOnly: false },
            ],
          }],
        }];
      },
    },
    applicationRegistry: {
      async listApplications() {
        return [{
          id: applicationId,
          serverId,
          name: 'Storefront',
          type: 'node',
          desiredRevision: 4,
          appliedRevision: 3,
          currentReleaseId: releaseId,
          currentCommitSha: 'a'.repeat(40),
        }, {
          id: '771abf90-ec8c-450b-bbe5-23f5f68fd9b0',
          serverId: otherServerId,
          name: 'Foreign',
          type: 'static',
          desiredRevision: 1,
          appliedRevision: 0,
          currentReleaseId: null,
          currentCommitSha: null,
        }];
      },
    },
    applicationEnvironmentRegistry: {
      async environmentStatus(id, options) {
        calls.environment.push({ id, options });
        return {
          applicationId: id,
          savedRevision: 7,
          appliedRevision: 6,
          appliedReleaseId: releaseId,
        };
      },
    },
    async loadDatabaseInventory(requested) {
      assert.equal(requested, serverId);
      if (databaseInventory !== undefined) return databaseInventory;
      return {
        engine: 'mariadb',
        version: '11.4.3-MariaDB',
        databases: [{ name: 'novasis', sizeBytes: 4096 }],
        snapshot: { jobId: inventoryJobId, refreshedAt: '2026-09-13T20:01:00.000Z' },
      };
    },
    mailDomainRegistry: {
      async listMailDomains() {
        return [{
          id: mailDomainId,
          domainName: 'example.com',
          webDomainId,
          managementMode: 'local',
          revision: 5,
        }, {
          id: '70007f04-3a08-4d9d-a91a-1bfe5665ed62',
          domainName: 'external.example',
          webDomainId: null,
          managementMode: 'external',
          revision: 1,
        }];
      },
    },
    domainRegistry: {
      async getDomain(id) {
        return id === webDomainId ? { id, serverId, primaryDomain: 'example.com' } : null;
      },
    },
    mailDataOperationsService: {
      async previewBackup(input) {
        calls.mail.push(input);
        if (mailPreviewError) throw mailPreviewError;
        return {
          version: 1,
          operation: 'mail_data_backup',
          mailDomainId,
          scope: 'domain',
          resourceId: mailDomainId,
          identity: 'example.com',
          expectedRevision: 5,
          snapshotSha256: 'b'.repeat(64),
          sourcePresent: true,
          bytes: 2048,
          previewDigest: 'c'.repeat(64),
          confirmation: 'unused',
          sideEffects: false,
        };
      },
    },
    now: () => Date.parse('2026-09-13T20:05:00.000Z'),
  });
  return { provider, calls };
}

test('live backup provider gathers Docker, Application, database and domain-level Mail resources', async () => {
  const { provider, calls } = fixture();
  const plan = await provider.preview({ serverId });

  assert.equal(plan.serverId, serverId);
  assert.equal(plan.selectionMode, 'all_managed');
  assert.equal(plan.resources.length, 5);
  assert.deepEqual(
    plan.resources.map((resource) => resource.type).sort(),
    ['application', 'database', 'docker_storage', 'docker_storage', 'mail_data'],
  );
  assert.equal(plan.counts.selected, 4);
  assert.equal(plan.counts.excluded, 1);
  assert.deepEqual(calls.environment, [{ id: applicationId, options: { currentReleaseId: releaseId } }]);
  assert.deepEqual(calls.mail, [{ scope: 'domain', resourceId: mailDomainId }]);
  assert.equal(plan.resources.some((resource) => resource.serverId === otherServerId), false);
});

test('live backup provider produces a stable digest when live evidence is unchanged', async () => {
  const first = await fixture().provider.preview({ serverId });
  const second = await fixture().provider.preview({ serverId });
  assert.equal(first.previewDigest, second.previewDigest);
  assert.equal(first.confirmation, second.confirmation);
});

test('live backup provider requires a verified database inventory instead of silently omitting databases', async () => {
  const { provider } = fixture({ databaseInventory: null });
  await assert.rejects(
    () => provider.preview({ serverId }),
    (error) => error instanceof BackupResourceProviderError
      && error.code === 'backup_database_inventory_required'
      && error.status === 409,
  );
});

test('live backup provider fails closed when managed mail data cannot be inspected', async () => {
  const { provider } = fixture({ mailPreviewError: new Error('private path leaked') });
  await assert.rejects(
    () => provider.preview({ serverId }),
    (error) => error instanceof BackupResourceProviderError
      && error.code === 'backup_mail_data_unavailable'
      && error.status === 503
      && !error.message.includes('private path leaked'),
  );
});

test('live backup provider hides unknown servers as not found', async () => {
  const { provider } = fixture();
  await assert.rejects(
    () => provider.preview({ serverId: otherServerId }),
    (error) => error instanceof BackupResourceProviderError
      && error.code === 'server_not_found'
      && error.status === 404,
  );
});
