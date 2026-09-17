import assert from 'node:assert/strict';
import test from 'node:test';
import { websiteIsolationClientInternals } from '../src/workspace/website-isolation-client.js';
import {
  isolationFindingPresentation,
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
});
