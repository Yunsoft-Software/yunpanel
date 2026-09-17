import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWebsiteIsolationMigration,
  listWebsiteIsolationMigrations,
  rollbackWebsiteIsolationMigration,
  websiteIsolationClientInternals,
  websiteIsolationRollbackConfirmation,
} from '../src/workspace/website-isolation-client.js';
import { setSession } from '../src/session-client.js';
import {
  isolationFindingPresentation,
  isolationMigrationStatusPresentation,
  isolationStatusPresentation,
  isolationStepPresentation,
} from '../src/workspace/website-isolation-model.js';

const websiteId = 'F73CC6AC-07E8-4D22-B29A-741154687D20';

test('Website isolation client accepts only a canonical Website UUID', () => {
  assert.equal(websiteIsolationClientInternals.websiteId(websiteId), websiteId.toLowerCase());
  for (const invalid of ['', '../website', 'f73cc6ac-07e8-4d22-b29a-741154687d20?raw=1']) {
    assert.throws(() => websiteIsolationClientInternals.websiteId(invalid), /website id is invalid/);
  }
});

test('Website isolation presentation keeps unknown states explicit', () => {
  assert.deepEqual(isolationStatusPresentation({ status: 'isolated' }), { badge: 'succeeded', label: 'İzole' });
  assert.deepEqual(isolationStatusPresentation({ status: 'migration_required' }), { badge: 'warning', label: 'Migration gerekli' });
  assert.equal(isolationStatusPresentation({ status: 'future' }).label, 'Bilinmiyor');
  assert.deepEqual(isolationStepPresentation({ stepId: 'sftp', satisfied: null }), {
    name: 'SFTP izolasyonu', badge: 'unknown', label: 'Doğrulanamadı',
  });
  assert.deepEqual(isolationFindingPresentation({ severity: 'critical' }), { badge: 'failed', label: 'Kritik' });
  assert.deepEqual(isolationMigrationStatusPresentation({ status: 'succeeded' }), { badge: 'succeeded', label: 'Uygulandı' });
  assert.equal(isolationMigrationStatusPresentation({ status: 'future' }).label, 'Bilinmiyor');
});

test('Website isolation client sends exact apply and receipt rollback confirmations', async (context) => {
  setSession({ csrfToken: 'csrf-isolation' });
  context.after(() => setSession(null));
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  const normalizedWebsiteId = websiteId.toLowerCase();
  const operation = {
    id: '9AE512C0-A717-4611-943C-6CE2AB0ABF16',
    websiteId: normalizedWebsiteId,
    previewDigest: 'b'.repeat(64),
  };
  const migration = {
    applyAvailable: true,
    previewDigest: 'a'.repeat(64),
    confirmation: `migrate-isolation:${normalizedWebsiteId}:3:${'a'.repeat(64)}`,
  };

  await listWebsiteIsolationMigrations(websiteId);
  await applyWebsiteIsolationMigration(websiteId, migration);
  await rollbackWebsiteIsolationMigration(websiteId, operation);

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    [`/api/panel/websites/${normalizedWebsiteId}/isolation-migrations`, 'GET'],
    [`/api/panel/websites/${normalizedWebsiteId}/isolation-migrations`, 'POST'],
    [`/api/panel/websites/${normalizedWebsiteId}/isolation-migrations/${operation.id.toLowerCase()}/rollback`, 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    expectedPreviewDigest: migration.previewDigest,
    confirmation: migration.confirmation,
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    confirmation: websiteIsolationRollbackConfirmation(operation),
  });
  assert.equal(calls[1].options.headers['x-csrf-token'], 'csrf-isolation');
  assert.equal(calls[2].options.headers['x-csrf-token'], 'csrf-isolation');
});
