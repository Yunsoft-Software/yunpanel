import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootPackageUrl = new URL('../../../package.json', import.meta.url);
const buildDebUrl = new URL('../../../scripts/build-deb.sh', import.meta.url);
const envExampleUrl = new URL('../../../.env.example', import.meta.url);
const migrationDocUrl = new URL('../../../docs/local-runtime-migration.md', import.meta.url);

test('root package exposes the local runtime migration CLI', async () => {
  const packageJson = JSON.parse(await readFile(rootPackageUrl, 'utf8'));
  assert.equal(packageJson.scripts['local-runtime'], 'node scripts/local-runtime.mjs');
});

test('Debian package installs the local runtime migration entry point and runbook', async () => {
  const buildScript = await readFile(buildDebUrl, 'utf8');
  assert.match(buildScript, /install -m 0755 scripts\/local-runtime\.mjs .*\/usr\/lib\/yunpanel\/scripts\/local-runtime\.mjs/);
  assert.match(buildScript, /docs\/local-runtime-migration\.md/);
});

test('environment template keeps local execution disabled until explicit migration', async () => {
  const env = await readFile(envExampleUrl, 'utf8');
  assert.match(env, /^YUNPANEL_LOCAL_SERVER_ID=$/m);
  assert.match(env, /packaged migration CLI before enabling this value/);
  assert.doesNotMatch(env, /^YUNPANEL_LOCAL_SERVER_ID=[0-9a-f-]+$/m);
});

test('migration runbook requires stopped consumers, clear work and a verified backup for ownership mutation', async () => {
  const doc = await readFile(migrationDocUrl, 'utf8');
  assert.match(doc, /YUNPANEL_SERVER_STORE=\/var\/lib\/yunpanel\/control-plane\/server-registry\.json/);
  assert.match(doc, /YUNPANEL_JOB_STORE=\/var\/lib\/yunpanel\/control-plane\/job-registry\.json/);
  assert.match(doc, /no `queued` or `running` job/);
  assert.match(doc, /systemctl stop yunpanel-api\.service yun-agent\.service/);
  assert.match(doc, /local-migration-backup\.mjs create --confirm/);
  assert.match(doc, /local-migration-backup\.mjs verify \/var\/backups\/yunpanel\/migration-<timestamp>/);
  assert.match(doc, /local-runtime\.mjs bind <server-uuid> --backup-dir \/var\/backups\/yunpanel\/migration-<timestamp> --confirm/);
  assert.match(doc, /local-runtime\.mjs release <server-uuid> --backup-dir \/var\/backups\/yunpanel\/migration-<rollback-timestamp> --confirm/);
});
