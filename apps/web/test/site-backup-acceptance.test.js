import assert from 'node:assert/strict';
import test from 'node:test';
import {
  siteBackupBrowser,
  siteBackupErrorMessage,
  siteBackupOperation,
  siteBackupPreview,
  siteBackupScope,
  resolveSiteBackupAccess,
} from '../src/workspace/site-backup-model.js';
import { createSiteBackupClient } from '../src/workspace/site-backup-client.js';

const scope = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  serverId: '22222222-2222-4222-8222-222222222222',
};

const repoId = '33333333-3333-4333-8333-333333333333';
const opId = '44444444-4444-4444-8444-444444444444';
const digest = 'a'.repeat(64);

test('siteBackupOperation validates and normalizes durable operation fields', () => {
  assert.throws(() => siteBackupOperation(null));
  assert.throws(() => siteBackupOperation({ id: 'invalid', websiteId: scope.websiteId }));
  assert.throws(() => siteBackupOperation({ id: opId, websiteId: scope.websiteId, kind: 'invalid', status: 'queued' }));

  const rawOp = {
    id: opId,
    websiteId: scope.websiteId,
    serverId: scope.serverId,
    repositoryId: repoId,
    kind: 'backup',
    snapshotId: 'aaaaaaaa',
    previewDigest: digest,
    status: 'succeeded',
    progress: { phase: 'succeeded', percent: 100, message: 'Done' },
    steps: [{ name: 'prepare', status: 'succeeded' }],
    result: { status: 'succeeded' },
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:05:00.000Z',
  };

  const op = siteBackupOperation(rawOp);
  assert.equal(op.id, opId);
  assert.equal(op.kind, 'backup');
  assert.equal(op.status, 'succeeded');
  assert.equal(op.progress?.percent, 100);
  assert.equal(op.steps.length, 1);
  assert.ok(Object.isFrozen(op));
});

test('siteBackupPreview validates websiteId and confirmation', () => {
  assert.throws(() => siteBackupPreview(null));
  assert.throws(() => siteBackupPreview({ websiteId: 'invalid' }));
  assert.throws(() => siteBackupPreview({ websiteId: scope.websiteId, confirmation: '' }));

  const preview = siteBackupPreview({
    websiteId: scope.websiteId,
    confirmation: `backup:${scope.websiteId}:${repoId}:${digest}`,
    backupSetDigest: digest,
  });
  assert.equal(preview.websiteId, scope.websiteId);
  assert.ok(preview.confirmation.startsWith('backup:'));
});

test('siteBackupErrorMessage maps all known durable backup and isolation error codes', () => {
  assert.equal(siteBackupErrorMessage({ code: 'site_scope_forbidden' }), 'Bu sitenin yedeklerine erişim izniniz yok.');
  assert.equal(siteBackupErrorMessage({ code: 'backup_preview_stale' }), 'Site yapılandırması değişti; lütfen önizlemeyi yenileyin.');
  assert.equal(siteBackupErrorMessage({ code: 'backup_confirmation_invalid' }), 'Yedekleme onay metni eşleşmiyor.');
  assert.equal(siteBackupErrorMessage({ code: 'restore_preview_stale' }), 'Site veya snapshot durumu değişti; lütfen önizlemeyi yenileyin.');
  assert.equal(siteBackupErrorMessage({ code: 'restore_confirmation_invalid' }), 'Geri yükleme onay metni eşleşmiyor.');
  assert.equal(siteBackupErrorMessage({ code: 'website_backup_operation_conflict' }), 'Bu site için halihazırda çalışan veya kuyrukta olan bir işlem var.');
  assert.equal(siteBackupErrorMessage({ code: 'interrupted_by_restart' }), 'İşlem sistem yeniden başlatması nedeniyle kesintiye uğradı.');
  assert.equal(siteBackupErrorMessage({ code: 'unknown_error' }), 'Yedekleme bilgileri alınamadı. Yeniden kontrol edin.');
});

test('createSiteBackupClient executes preview, queue, get, list operations and updates state', async () => {
  const requests = [];
  const mockRequest = async (path, options = {}) => {
    requests.push({ path, ...options });

    if (path.includes('/backups')) {
      return {
        schemaVersion: 1,
        ...scope,
        backupSet: { digest, runtimeType: 'node', databaseCount: 1, mailCount: 0, dnsCount: 1, pathCount: 2, composeHooksEnabled: false },
        repositories: [{
          id: repoId,
          name: 'primary',
          backend: 'local',
          status: 'ready',
          retentionPolicy: { keepLast: 5 },
          lastCheckedAt: null,
          lastSnapshotAt: null,
          snapshotStatus: 'ready',
          snapshots: [{ id: 'a'.repeat(64), shortId: 'aaaaaaaa', time: '2026-09-25T10:00:00.000Z', kind: 'backup' }],
        }],
        inspectedAt: '2026-09-25T10:00:00.000Z',
      };
    }

    if (path.includes('/backup/preview')) {
      return {
        data: {
          websiteId: scope.websiteId,
          repositoryId: repoId,
          backupSetDigest: digest,
          confirmation: `backup:${scope.websiteId}:${repoId}:${digest}`,
        },
      };
    }

    if (path.includes('/backup-operations') && options.method === 'POST') {
      return {
        data: {
          id: opId,
          websiteId: scope.websiteId,
          repositoryId: repoId,
          kind: options.body.kind,
          previewDigest: digest,
          status: 'queued',
          createdAt: '2026-09-25T10:00:00.000Z',
          updatedAt: '2026-09-25T10:00:00.000Z',
        },
      };
    }

    if (path.includes(`/backup-operations/${opId}`)) {
      return {
        data: {
          id: opId,
          websiteId: scope.websiteId,
          repositoryId: repoId,
          kind: 'backup',
          previewDigest: digest,
          status: 'succeeded',
          createdAt: '2026-09-25T10:00:00.000Z',
          updatedAt: '2026-09-25T10:01:00.000Z',
        },
      };
    }

    if (path.endsWith('/backup-operations')) {
      return {
        data: [{
          id: opId,
          websiteId: scope.websiteId,
          repositoryId: repoId,
          kind: 'backup',
          previewDigest: digest,
          status: 'succeeded',
          createdAt: '2026-09-25T10:00:00.000Z',
          updatedAt: '2026-09-25T10:01:00.000Z',
        }],
      };
    }

    throw new Error(`Unhandled path: ${path}`);
  };

  const client = createSiteBackupClient({
    scope,
    request: mockRequest,
  });

  // 1. load()
  const loaded = await client.load();
  assert.equal(loaded, true);
  const snap = client.getSnapshot();
  assert.equal(snap.fresh, true);
  assert.equal(snap.data.repositories.length, 1);
  assert.equal(snap.data.repositories[0].snapshots[0].shortId, 'aaaaaaaa');

  // 2. previewBackup
  const preview = await client.previewBackup(repoId);
  assert.ok(preview.confirmation.startsWith('backup:'));

  // 3. queueBackup
  const queuedOp = await client.queueBackup({
    repositoryId: repoId,
    expectedPreviewDigest: digest,
    confirmation: preview.confirmation,
  });
  assert.equal(queuedOp.id, opId);
  assert.equal(queuedOp.status, 'queued');

  // 4. getOperation
  const fetchedOp = await client.getOperation(opId);
  assert.equal(fetchedOp.id, opId);
  assert.equal(fetchedOp.status, 'succeeded');

  // 5. listOperations
  const list = await client.listOperations();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, opId);

  client.dispose();
});
