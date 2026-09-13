import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseRestoreEvidenceInspector,
  DatabaseRestoreEvidenceError,
} from '../src/database-restore-evidence-inspector.js';

const liveContent = 'canonical live database dump\n';

async function fixture(t, { inventory = null, failDump = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-restore-evidence-'));
  const root = path.join(base, 'evidence');
  t.after(() => rm(base, { recursive: true, force: true }));
  const calls = [];
  const inspector = createDatabaseRestoreEvidenceInspector({
    root,
    databaseManager: {
      async inspect() {
        calls.push(['inspect']);
        return inventory ?? {
          engine: 'mariadb',
          version: '10.11.13-MariaDB',
          databases: [{ name: 'app_main', sizeBytes: 4096 }],
        };
      },
    },
    dumpToFile: async ({ databaseName, outputPath, engine, programs }) => {
      calls.push(['dump', databaseName, engine, programs]);
      if (failDump) throw new Error('dump failed');
      await writeFile(outputPath, liveContent, { mode: 0o600 });
    },
    randomSuffix: () => 'fixed-evidence',
  });
  return { base, root, calls, inspector };
}

test('live restore evidence returns only canonical digest metadata and removes temporary dump', async (t) => {
  const fx = await fixture(t);
  const evidence = await fx.inspector.inspectLive({ databaseName: 'app_main', engine: 'mariadb' });
  assert.deepEqual(Object.keys(evidence).sort(), [
    'databaseName', 'databaseVersion', 'dumpBytes', 'dumpSha256', 'engine',
  ]);
  assert.equal(evidence.databaseName, 'app_main');
  assert.equal(evidence.engine, 'mariadb');
  assert.equal(evidence.databaseVersion, '10.11.13-MariaDB');
  assert.equal(evidence.dumpBytes, Buffer.byteLength(liveContent));
  assert.match(evidence.dumpSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(evidence).includes('live.sql'), false);
  assert.deepEqual(await readdir(fx.root), []);
});

test('live restore evidence rejects engine or schema drift before dumping', async (t) => {
  for (const inventory of [
    { engine: 'mysql', version: '8.4.0', databases: [{ name: 'app_main', sizeBytes: 1 }] },
    { engine: 'mariadb', version: '10.11.13-MariaDB', databases: [{ name: 'other_db', sizeBytes: 1 }] },
  ]) {
    const fx = await fixture(t, { inventory });
    await assert.rejects(
      fx.inspector.inspectLive({ databaseName: 'app_main', engine: 'mariadb' }),
      (error) => error instanceof DatabaseRestoreEvidenceError && error.code === 'database_restore_evidence_target_mismatch',
    );
    assert.equal(fx.calls.some(([name]) => name === 'dump'), false);
  }
});

test('live restore evidence cleans temporary state when dump generation fails', async (t) => {
  const fx = await fixture(t, { failDump: true });
  await assert.rejects(
    fx.inspector.inspectLive({ databaseName: 'app_main', engine: 'mariadb' }),
    (error) => error instanceof DatabaseRestoreEvidenceError && error.code === 'database_restore_evidence_dump_failed',
  );
  assert.deepEqual(await readdir(fx.root), []);
  await assert.rejects(access(path.join(fx.root, 'app_main-fixed-evidence', 'live.sql')));
});
