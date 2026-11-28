import assert from 'node:assert/strict';
import test from 'node:test';
import { dockerRemovalMessage, dockerRemovalVolumes } from '../src/workspace/docker-compose-model.js';

const preview = (deleteVolumes) => ({
  deleteVolumes,
  volumes: [
    { volumeKey: 'data', volumeName: 'shop_data', present: true, deletable: true, blockReason: null },
    { volumeKey: 'never', volumeName: 'shop_never', present: false, deletable: false, blockReason: 'Host üzerinde oluşturulmuş volume yok.' },
    { volumeKey: 'shared', volumeName: 'shared_uploads', present: null, deletable: false, blockReason: 'Harici veya özel adlı volume silinemez.' },
  ],
});

test('removal preview volumes default to kept and are marked for deletion only after opt-in', () => {
  const keep = dockerRemovalVolumes(preview(false));
  assert.equal(keep.canDelete, true);
  assert.equal(keep.deleteVolumes, false);
  assert.deepEqual(keep.rows.map((row) => [row.volumeName, row.status]), [
    ['shop_data', 'Korunacak'],
    ['shop_never', 'Host üzerinde oluşturulmuş volume yok.'],
    ['shared_uploads', 'Harici veya özel adlı volume silinemez.'],
  ]);
  const remove = dockerRemovalVolumes(preview(true));
  assert.equal(remove.deleteVolumes, true);
  assert.deepEqual(remove.rows.map((row) => [row.volumeName, row.status, row.deleted]), [
    ['shop_data', 'Silinecek', true],
    ['shop_never', 'Host üzerinde oluşturulmuş volume yok.', false],
    ['shared_uploads', 'Harici veya özel adlı volume silinemez.', false],
  ]);
});

test('removal preview without deletable volumes offers no delete choice', () => {
  const none = dockerRemovalVolumes({ deleteVolumes: false, volumes: [preview(false).volumes[2]] });
  assert.equal(none.canDelete, false);
  assert.deepEqual(dockerRemovalVolumes({}), { rows: [], canDelete: false, deleteVolumes: false });
});

test('removal message states whether named volumes are kept or deleted', () => {
  assert.match(dockerRemovalMessage('shop', dockerRemovalVolumes(preview(false))), /volume'lar sunucuda korunur/);
  assert.match(dockerRemovalMessage('shop', dockerRemovalVolumes(preview(true))), /1 volume ve içindeki veriler kalıcı olarak silinir/);
  assert.doesNotMatch(dockerRemovalMessage('shop', dockerRemovalVolumes(preview(true))), /Adlı volume'lar sunucuda korunur/);
});
