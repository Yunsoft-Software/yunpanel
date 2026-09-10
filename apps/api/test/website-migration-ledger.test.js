import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteMigrationLedger, WebsiteMigrationLedgerError } from '../src/website-migration-ledger.js';

const domainId = '0ef7e00b-1b85-4938-b726-247c94679c66';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const otherWebsiteId = 'da25db71-1a5d-414e-af9f-f1e7f9a9baf7';
const sourceDigest = 'a'.repeat(64);
const bindingDigest = 'b'.repeat(64);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-website-ledger-'));
  const filePath = path.join(root, 'website-migration-ledger.json');
  let clock = Date.parse('2026-09-11T01:00:00.000Z');
  const ledger = createWebsiteMigrationLedger({ filePath, now: () => clock });
  await ledger.init();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { filePath, ledger, advance() { clock += 1000; } };
}

test('migration-created Website state advances durably through binding and rollback', async (t) => {
  const f = await fixture(t);
  const planned = await f.ledger.planWebsiteCreation({ domainId, applicationId, websiteId, sourcePreviewDigest: sourceDigest });
  assert.equal(planned.state, 'creating_website');
  assert.equal(planned.createdWebsite, true);
  f.advance();
  assert.equal((await f.ledger.markWebsiteCreated({ domainId, applicationId, websiteId })).state, 'website_created');
  f.advance();
  assert.equal((await f.ledger.planBinding({ domainId, applicationId, websiteId, previewDigest: bindingDigest, createdWebsite: true })).state, 'binding_planned');
  f.advance();
  assert.equal((await f.ledger.markBound({ domainId, applicationId, websiteId })).state, 'bound');
  f.advance();
  assert.equal((await f.ledger.beginRollback({ domainId, websiteId })).state, 'rolling_back');
  f.advance();
  const rolledBack = await f.ledger.markRolledBack({ domainId, websiteId });
  assert.equal(rolledBack.state, 'rolled_back');
  assert.ok(rolledBack.rolledBackAt);
  assert.equal((await stat(f.filePath)).mode & 0o077, 0);

  const reopened = createWebsiteMigrationLedger({ filePath: f.filePath });
  await reopened.init();
  assert.deepEqual(await reopened.get(domainId), rolledBack);
  assert.equal((await reopened.list()).length, 1);
});

test('existing Website binding starts at binding_planned and remains idempotent', async (t) => {
  const f = await fixture(t);
  const first = await f.ledger.planBinding({ domainId, applicationId, websiteId, previewDigest: bindingDigest, createdWebsite: false });
  const retry = await f.ledger.planBinding({ domainId, applicationId, websiteId, previewDigest: bindingDigest, createdWebsite: false });
  assert.deepEqual(retry, first);
  assert.equal(first.createdWebsite, false);
  assert.equal(first.state, 'binding_planned');
  const bound = await f.ledger.markBound({ domainId, applicationId, websiteId });
  assert.equal(bound.state, 'bound');
  assert.deepEqual(await f.ledger.markBound({ domainId, applicationId, websiteId }), bound);
});

test('identity and transition drift fail closed', async (t) => {
  const f = await fixture(t);
  await f.ledger.planWebsiteCreation({ domainId, applicationId, websiteId, sourcePreviewDigest: sourceDigest });
  await assert.rejects(
    f.ledger.planWebsiteCreation({ domainId, applicationId, websiteId: otherWebsiteId, sourcePreviewDigest: sourceDigest }),
    (error) => error instanceof WebsiteMigrationLedgerError && error.code === 'website_migration_ledger_conflict',
  );
  await assert.rejects(
    f.ledger.markBound({ domainId, applicationId, websiteId }),
    (error) => error instanceof WebsiteMigrationLedgerError && error.code === 'website_migration_ledger_transition_invalid',
  );
  await assert.rejects(
    f.ledger.beginRollback({ domainId, websiteId }),
    (error) => error instanceof WebsiteMigrationLedgerError && error.code === 'website_migration_ledger_transition_invalid',
  );
});

test('ledger schema contains only bounded migration identity metadata', async (t) => {
  const f = await fixture(t);
  await f.ledger.planBinding({ domainId, applicationId, websiteId, previewDigest: bindingDigest });
  const persisted = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.deepEqual(Object.keys(persisted.entries[0]).sort(), [
    'applicationId', 'bindingPreviewDigest', 'createdAt', 'createdWebsite', 'domainId', 'rolledBackAt',
    'sourcePreviewDigest', 'state', 'updatedAt', 'websiteId',
  ].sort());
  assert.equal(JSON.stringify(persisted).includes('/var/'), false);
  assert.equal(JSON.stringify(persisted).includes('password'), false);
  assert.equal(JSON.stringify(persisted).includes('certificate'), false);
});

test('corrupt persisted ledger state fails closed', async (t) => {
  const f = await fixture(t);
  const invalid = [
    { version: 99, entries: [] },
    { version: 1, entries: [{ domainId, applicationId, websiteId, createdWebsite: true, sourcePreviewDigest: sourceDigest, bindingPreviewDigest: null, state: 'bound', createdAt: 'bad', updatedAt: 'bad', rolledBackAt: null }] },
    { version: 1, entries: [{ domainId, applicationId, websiteId, createdWebsite: false, sourcePreviewDigest: sourceDigest, bindingPreviewDigest: bindingDigest, state: 'rolled_back', createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z', rolledBackAt: null }] },
  ];
  for (const state of invalid) {
    await writeFile(f.filePath, JSON.stringify(state), { mode: 0o600 });
    const reopened = createWebsiteMigrationLedger({ filePath: f.filePath });
    await assert.rejects(reopened.init());
  }
});
