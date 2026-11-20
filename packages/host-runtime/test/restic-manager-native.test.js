import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createResticManager } from '../src/restic-manager.js';

const resticPath = process.env.YUNPANEL_RESTIC_NATIVE_BIN;

test('Restic restores file and SQL data after the original source path disappears', {
  skip: resticPath ? false : 'Set YUNPANEL_RESTIC_NATIVE_BIN to an installed Restic executable',
}, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'yunpanel-restic-native-')));
  try {
    const manager = createResticManager({ resticPath });
    const source = path.join(root, 'source');
    const repository = path.join(root, 'repository');
    const targetDirectory = path.join(root, 'restore');
    const password = randomBytes(32).toString('hex');
    const content = '<h1>YunPanel yerel kurtarma</h1>\n';
    await mkdir(source);
    await writeFile(path.join(source, 'index.html'), content);
    const sourceDatabase = new DatabaseSync(path.join(source, 'data.sqlite'));
    try {
      sourceDatabase.exec("CREATE TABLE page (body text); INSERT INTO page VALUES ('geri geldi');");
    } finally {
      sourceDatabase.close();
    }

    await manager.init({ repository, password });
    const { snapshotId } = await manager.createSnapshot({ repository, password, paths: [source] });
    assert.equal((await manager.check({ repository, password, readDataSubset: '100%' })).healthy, true);
    await rename(source, path.join(root, 'source-offline'));
    await assert.rejects(readFile(path.join(source, 'index.html')), { code: 'ENOENT' });

    assert.equal((await manager.restore({ repository, password, snapshotId, targetDirectory })).verified, true);
    const restored = path.join(targetDirectory, source);
    assert.equal(await readFile(path.join(restored, 'index.html'), 'utf8'), content);
    const restoredDatabase = new DatabaseSync(path.join(restored, 'data.sqlite'), { readOnly: true });
    try {
      assert.equal(restoredDatabase.prepare('SELECT body FROM page').get().body, 'geri geldi');
    } finally {
      restoredDatabase.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
